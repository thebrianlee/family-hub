#!/usr/bin/env bash
# Sproutwall one-command install, for the preview pinned below.
#
#   curl -fsSL https://raw.githubusercontent.com/thebrianlee/sproutwall/main/install.sh | bash
#
# Run it as yourself (not root, not with sudo) in the device's own Terminal,
# on 64-bit Raspberry Pi OS, Debian or Ubuntu. It runs INSTALL-WITH-AI.md's
# steps 3 to 5 and 7 for you, as "Without AI" (tier C): it shows the install
# plan and asks before the first sudo, installs the tools with the guide's
# commands, checks out the pinned commit, verifies the pinned image, starts
# it, waits while you set up the household on the screen, and sets up the
# screen. It never asks for, reads or prints a PIN, password or token. It
# never touches an existing hub. See README.md, "Install".
#
# Everything runs inside main(), called on the last line, so a download that
# is cut off part way runs nothing.

set -euo pipefail

# The pinned preview. Always the same pair as the table near the top of
# INSTALL-WITH-AI.md: a re-pin changes both files together, and
# scripts/tests/test_install_sh.py fails if they differ.
PINNED_SOURCE_COMMIT="beb3ec14dca7eb4060979f852ed5e1e87ed4317c"
PINNED_IMAGE_DIGEST="sha256:878dacdb06d58197313c3f992d42689b189dc86edad2c3c7f58eb8c63e741be0"

REPO_URL="https://github.com/thebrianlee/sproutwall.git"
GUIDE="https://github.com/thebrianlee/sproutwall/blob/main/INSTALL-WITH-AI.md"
PI_GUIDE="https://github.com/thebrianlee/sproutwall/blob/main/docs/raspberry-pi.md"
PREVIEW="docker-compose.preview.yml"
HEALTH_URL="http://127.0.0.1:3847/api/health"

# Test hooks only (scripts/tests/test_install_sh.py): read the system files
# under another folder, and the answers from a file instead of the terminal.
TEST_ROOT="${SPROUTWALL_INSTALL_TEST_ROOT:-}"
TTY_PATH="${SPROUTWALL_INSTALL_TEST_TTY:-/dev/tty}"

STOP_SHOWN=0
WORK_DIR=""
OS_ID=""
IS_RPI_OS=0
SCREEN="none"     # portrait, portrait-flipped, landscape, landscape-flipped or none
KIOSK_RESULT="off" # on, attention or off (the --kiosk value for the final check)
REPLY_TEXT=""

# --- output -------------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }

# Every stop is one plain line on stderr: why, and what to do. Exit 1.
stop() {
  STOP_SHOWN=1
  printf '\nStopped: %s\n' "$*" >&2
  exit 1
}

# Nothing was changed: the person said no, or gave no answer. Exit 0.
leave_unchanged() {
  STOP_SHOWN=1
  printf '\n%s\n' "$*"
  exit 0
}

on_exit() {
  local code=$?
  if [ -n "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
  if [ "$code" -ne 0 ] && [ "$STOP_SHOWN" = 0 ]; then
    printf '\nStopped: a step failed (exit %s). Read the lines above, then continue by hand with the guide from that step: %s\n' \
      "$code" "$GUIDE" >&2
  fi
}

on_interrupt() {
  STOP_SHOWN=1
  printf '\nStopped: you interrupted the install. Read the lines above to see how far it got; the guide has every step: %s\n' \
    "$GUIDE" >&2
  exit 130
}

# --- questions (stdin is the terminal inside run_install) --------------------------------

ask() {
  printf '\n%s ' "$1"
  REPLY_TEXT=""
  if ! read -r REPLY_TEXT; then
    REPLY_TEXT=""
    printf '\n'
    return 1
  fi
  return 0
}

ask_yes_no() {
  ask "$1 [y/N]" || return 1
  case "$REPLY_TEXT" in
    y | Y | yes | Yes | YES) return 0 ;;
  esac
  return 1
}

wait_for_enter() {
  ask "$1 (press Enter)"
}

# --- small helpers ------------------------------------------------------------------------

# Run one command with the docker group, so no new login is needed after
# usermod. Arguments are passed through sg's shell, single-quoted.
as_docker_group() {
  local line="" arg
  for arg in "$@"; do
    case "$arg" in
      *\'*) return 2 ;;
    esac
    line="$line '$arg'"
  done
  sg docker -c "${line# }"
}

# version_at_least NEED HAVE: true if HAVE (a.b[.c]) >= NEED (a.b.c).
version_at_least() {
  local need=$1 have=$2 i n h
  local -a needs haves
  IFS=. read -r -a needs <<<"$need"
  IFS=. read -r -a haves <<<"$have"
  for i in 0 1 2; do
    n=${needs[i]:-0}
    h=${haves[i]:-0}
    if ((10#$h > 10#$n)); then return 0; fi
    if ((10#$h < 10#$n)); then return 1; fi
  done
  return 0
}

first_version() {
  if [[ $1 =~ ([0-9]+\.[0-9]+(\.[0-9]+)?) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  fi
}

os_release_value() {
  local key=$1 line value
  while IFS= read -r line; do
    case "$line" in
      "$key="*)
        value=${line#*=}
        value=${value#\"}
        value=${value%\"}
        printf '%s\n' "$value"
        return 0
        ;;
    esac
  done <"$TEST_ROOT/etc/os-release"
  return 0
}

# Guide step 5: every address with dots must start with 192.168., 10., or
# 172.16. to 172.31.
home_network_ok() {
  local addresses address
  addresses=$(hostname -I) || return 1
  for address in $addresses; do
    case "$address" in
      *.*)
        case "$address" in
          192.168.* | 10.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) ;;
          *) return 1 ;;
        esac
        ;;
    esac
  done
  return 0
}

# Guide step 6, phone check: "Run hostname -I and take the first address".
first_lan_address() {
  local address
  for address in $(hostname -I 2>/dev/null || true); do
    case "$address" in
      *.*)
        printf '%s\n' "$address"
        return 0
        ;;
    esac
  done
  printf '<lan-ip>\n'
}

# --- preflight: nothing is changed here -------------------------------------------------

check_not_root() {
  if [ "$(id -u)" = 0 ] || [ -n "${SUDO_USER:-}" ]; then
    stop "Run this as yourself, not as root and not with sudo: curl -fsSL https://raw.githubusercontent.com/thebrianlee/sproutwall/main/install.sh | bash (it asks before it uses sudo). Nothing was changed."
  fi
  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
    stop "Your home folder could not be found. Open a new Terminal on the device and run this again. Nothing was changed."
  fi
  USER="${USER:-$(id -un)}"
  if [ "$USER" != "$(id -un)" ]; then
    stop "The USER setting does not match the account running this. Open a new Terminal on the device and run this again. Nothing was changed."
  fi
}

check_supported_device() {
  local kernel machine arch model
  kernel=$(uname -s)
  if [ "$kernel" != Linux ] || [ ! -r "$TEST_ROOT/etc/os-release" ]; then
    stop "This script runs on Raspberry Pi OS, Debian or Ubuntu (64-bit) only. See the guide's Supported devices: $GUIDE#supported-devices. Nothing was changed."
  fi
  OS_ID=$(os_release_value ID)
  case "$OS_ID" in
    debian | ubuntu) ;;
    raspbian)
      stop "This is a 32-bit Raspberry Pi OS. Sproutwall needs Raspberry Pi OS (64-bit): see $GUIDE#supported-devices. Nothing was changed."
      ;;
    *)
      stop "This script supports Raspberry Pi OS, Debian and Ubuntu (64-bit). On another Linux, install the tools as the guide says, then continue by hand: $GUIDE#supported-devices. Nothing was changed."
      ;;
  esac
  if ! command -v dpkg >/dev/null 2>&1; then
    stop "dpkg was not found, so this is not a Debian-family system this script supports. See $GUIDE#supported-devices. Nothing was changed."
  fi
  # Guide step 2, "check that this is a 64-bit system".
  arch=$(dpkg --print-architecture)
  machine=$(uname -m)
  if ! { [ "$arch" = arm64 ] && [ "$machine" = aarch64 ]; } && ! { [ "$arch" = amd64 ] && [ "$machine" = x86_64 ]; }; then
    stop "This is not a 64-bit system (arm64 or amd64). Sproutwall needs a 64-bit operating system: see $GUIDE#supported-devices. Nothing was changed."
  fi
  if [ -r "$TEST_ROOT/proc/device-tree/model" ]; then
    model=$(tr -d '\0' <"$TEST_ROOT/proc/device-tree/model")
    case "$model" in
      "Raspberry Pi 4"* | "Raspberry Pi 5"*) ;;
      "Raspberry Pi Compute Module 4"* | "Raspberry Pi Compute Module 5"*) ;;
      "Raspberry Pi"*)
        stop "This Raspberry Pi model is not supported (Raspberry Pi 3 and older, and every Pi Zero). Use a Raspberry Pi 4 or 5: see $GUIDE#supported-devices. Nothing was changed."
        ;;
    esac
    case "$model" in
      "Raspberry Pi 4 "* | "Raspberry Pi 5 "*) ;;
      "Raspberry Pi"*) say "Note: a Raspberry Pi 400, 500 or Compute Module should work but is not tested yet." ;;
    esac
  fi
  if [ -e "$TEST_ROOT/etc/rpi-issue" ]; then
    IS_RPI_OS=1
  fi
}

check_preflight_tools() {
  local version
  if ! command -v sudo >/dev/null 2>&1; then
    stop "sudo was not found. This script needs your account to be able to use sudo; otherwise follow the guide by hand: $GUIDE#without-ai. Nothing was changed."
  fi
  if ! command -v sg >/dev/null 2>&1; then
    stop "The sg command was not found (it lets the install use Docker without a new login). Follow the guide by hand instead: $GUIDE#without-ai. Nothing was changed."
  fi
  # Guide step 3, "Check the tools": Python 3.11 or newer. This script does
  # not install Python, so check it before anything is changed.
  version=$(first_version "$(python3 --version 2>&1 || true)")
  if [ -z "$version" ] || ! version_at_least 3.11.0 "$version"; then
    stop "Sproutwall's install helper needs Python 3.11 or newer (python3), and this system does not have it. Use a newer Raspberry Pi OS, Debian or Ubuntu: $GUIDE#supported-devices. Nothing was changed."
  fi
}

check_terminal() {
  if ! (: <"$TTY_PATH") 2>/dev/null; then
    stop "This install asks you questions, but no terminal is available to answer them. Run it in the device's own Terminal, or follow the guide by hand: $GUIDE#without-ai. Nothing was changed."
  fi
}

EXISTING_HUB_LINE="Sproutwall (or Family Hub) is already on this device, so this script stops here and changes nothing. Never install a second hub next to it: back up, then update in place, as the guide says: $GUIDE#existing-install--update (and $GUIDE#first-is-sproutwall-already-on-this-device)."
# absent: no docker command and no Docker data folder, so no Docker hub can
# exist. checked: this account listed every container and volume.
# unreachable: the docker command exists but this account cannot reach the
# daemon yet. data_only: no docker command, but Docker's data folder from an
# earlier install is still here. For the last two, check_docker_with_sudo
# looks with sudo, read-only, right after approval and before any change.
DOCKER_STATE="absent"

# The one matcher for every existing-hub check (guide "First": any line that
# mentions sproutwall, family-hub or familyhub-data): sproutwall_* and
# family-hub_* volumes, familyhub-data, and container names such as
# sproutwall-family-hub-1. The listings come as arguments, never through a
# pipe, so the answer cannot depend on pipe timing (a reader that exits early
# would make the writer fail under pipefail and turn "found" into "not found").
names_include_a_hub() {
  case "$*" in
    *sproutwall* | *family-hub* | *familyhub-data*) return 0 ;;
  esac
  return 1
}

stop_existing_hub() {
  if [ "${1:-}" = after_tools ]; then
    stop "Sproutwall (or Family Hub) is already on this device, so this script stops before it gets the code. The tools in the plan were installed, but the existing hub and its data were not touched. Never install a second hub next to it: back up, then update in place, as the guide says: $GUIDE#existing-install--update"
  fi
  stop "$EXISTING_HUB_LINE"
}
# Guide "First: is Sproutwall already on this device?":
#   ls -d ~/sproutwall ~/family-hub 2>/dev/null; docker ps -a --format '{{.Names}}'; docker volume ls -q
# Any line that mentions sproutwall, family-hub or familyhub-data is a hub.
check_no_existing_hub_first() {
  local found containers volumes
  found=$(ls -d "$HOME/sproutwall" "$HOME/family-hub" 2>/dev/null || true)
  if [ -n "$found" ]; then
    stop "$EXISTING_HUB_LINE"
  fi
  if command -v docker >/dev/null 2>&1; then
    if containers=$(docker ps -a --format '{{.Names}}' 2>/dev/null) && volumes=$(docker volume ls -q 2>/dev/null); then
      DOCKER_STATE="checked"
      if names_include_a_hub "$containers" "$volumes"; then
        stop_existing_hub
      fi
    else
      DOCKER_STATE="unreachable"
      say "Note: Docker is installed but this account cannot reach it yet. Once you approve the plan, the script looks for an existing hub with sudo (read-only) before it changes anything."
    fi
  elif [ -e "$TEST_ROOT/var/lib/docker" ]; then
    DOCKER_STATE="data_only"
    say "Note: Docker's data folder from an earlier install is on this device. Once you approve the plan, the script looks in it for an existing hub with sudo (read-only) before it changes anything."
  fi
}

# Step 0 of the plan: a read-only look for an existing hub with sudo, right
# after approval and before the first change, when this account could not
# look itself (Docker out of reach, or only Docker's data folder is left).
check_docker_with_sudo() {
  local containers volumes
  case "$DOCKER_STATE" in
    unreachable)
      say ""
      say "Looking for an existing hub in Docker (read-only; sudo asks for your password)..."
      if ! containers=$(sudo docker ps -a --format '{{.Names}}') || ! volumes=$(sudo docker volume ls -q); then
        stop "Docker is installed but did not answer, even with sudo, so this script cannot tell whether a hub is already on this device. Nothing was changed. Check by hand as the guide's first section says: $GUIDE#first-is-sproutwall-already-on-this-device"
      fi
      if names_include_a_hub "$containers" "$volumes"; then
        stop_existing_hub
      fi
      ;;
    data_only)
      say ""
      say "Looking for an existing hub in Docker's data folder (read-only; sudo asks for your password)..."
      if ! volumes=$(sudo ls -1 "$TEST_ROOT/var/lib/docker/volumes"); then
        stop "Docker's data folder from an earlier install is on this device, but its list of volumes could not be read, so this script cannot tell whether a household is there. Nothing was changed. Check by hand as the guide's first section says: $GUIDE#first-is-sproutwall-already-on-this-device"
      fi
      if names_include_a_hub "$volumes"; then
        stop_existing_hub
      fi
      ;;
    *) return 0 ;;
  esac
  say "No existing hub found."
}

check_home_network_first() {
  if ! home_network_ok; then
    stop "This device has an address outside the home-network ranges (hostname -I shows an address that does not start with 192.168., 10. or 172.16. to 172.31.), so it may be reachable from outside your home. Sproutwall is only for a trusted home network: $GUIDE#the-five-decisions. Nothing was changed."
  fi
}

# --- decisions and the install plan -------------------------------------------------------

ask_screen() {
  if [ "$IS_RPI_OS" != 1 ]; then
    SCREEN="none"
    say ""
    say "The screen setup tool is for Raspberry Pi OS only. On this device the install sets up the hub; set the screen up by hand afterwards: $PI_GUIDE#kiosk-on-other-devices"
    return 0
  fi
  say ""
  say "How does the screen hang?"
  say "  1  portrait (the usual choice for a kitchen wall)"
  say "  2  portrait-flipped (portrait, turned the other way)"
  say "  3  landscape"
  say "  4  landscape-flipped"
  say "  5  no kiosk (the hub then serves phones and tablets only)"
  while true; do
    if ! ask "Type 1 to 5 and press Enter [1-5, Enter = 1]"; then
      leave_unchanged "No answer, so nothing was changed."
    fi
    case "$REPLY_TEXT" in
      "" | 1 | portrait) SCREEN="portrait" ;;
      2 | portrait-flipped) SCREEN="portrait-flipped" ;;
      3 | landscape) SCREEN="landscape" ;;
      4 | landscape-flipped) SCREEN="landscape-flipped" ;;
      5 | none | "no kiosk") SCREEN="none" ;;
      *)
        say "Please type a number from 1 to 5."
        continue
        ;;
    esac
    return 0
  done
}

print_docker_commands() {
  if [ "$OS_ID" = ubuntu ]; then
    cat <<'PLAN'
       sudo apt update
       sudo apt install -y ca-certificates curl
       sudo install -m 0755 -d /etc/apt/keyrings
       sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
       sudo chmod a+r /etc/apt/keyrings/docker.asc
       sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
       Types: deb
       URIs: https://download.docker.com/linux/ubuntu
       Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
       Components: stable
       Architectures: $(dpkg --print-architecture)
       Signed-By: /etc/apt/keyrings/docker.asc
       EOF
       sudo apt update
       sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
PLAN
  else
    cat <<'PLAN'
       sudo apt update
       sudo apt install -y ca-certificates curl
       sudo install -m 0755 -d /etc/apt/keyrings
       sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
       sudo chmod a+r /etc/apt/keyrings/docker.asc
       sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
       Types: deb
       URIs: https://download.docker.com/linux/debian
       Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
       Components: stable
       Architectures: $(dpkg --print-architecture)
       Signed-By: /etc/apt/keyrings/docker.asc
       EOF
       sudo apt update
       sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
PLAN
  fi
}

print_gh_commands() {
  cat <<'PLAN'
       (type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
         && sudo mkdir -p -m 755 /etc/apt/keyrings \
         && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
         && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
         && sudo mkdir -p -m 755 /etc/apt/sources.list.d \
         && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
         && sudo apt update \
         && sudo apt install gh -y
PLAN
}

# The guide's "The install plan (decision 3)", for the rows this script runs.
show_plan() {
  local docker_page="https://docs.docker.com/engine/install/debian/"
  if [ "$OS_ID" = ubuntu ]; then
    docker_page="https://docs.docker.com/engine/install/ubuntu/"
  fi
  say ""
  say "THE INSTALL PLAN"
  say "These are all the commands this script runs with sudo. sudo asks for your password in this Terminal."
  say "Your yes covers this plan only. Details: $GUIDE#the-install-plan-decision-3"
  if [ "$DOCKER_STATE" = unreachable ]; then
    say ""
    say "  0. Read-only, right after you approve and before anything changes:"
    say "       sudo docker ps -a --format '{{.Names}}'"
    say "       sudo docker volume ls -q"
    say "     Why: Docker is installed but your account cannot reach it yet, so this looks for an existing hub."
    say "     If it finds one, the script stops with nothing changed. Changes nothing; nothing to undo."
  elif [ "$DOCKER_STATE" = data_only ]; then
    say ""
    say "  0. Read-only, right after you approve and before anything changes:"
    say "       sudo ls -1 /var/lib/docker/volumes"
    say "     Why: Docker's data folder from an earlier install is on this device, so this looks there for a"
    say "     hub's household. If it finds one, the script stops with nothing changed. Nothing to undo."
  fi
  say ""
  say "  1. sudo apt update && sudo apt full-upgrade -y"
  say "     Why: the normal system update. Undo: not reversible; updated packages are not rolled back."
  say ""
  say "  2. sudo apt install -y git"
  say "     Why: download the code. Undo: sudo apt remove git"
  say ""
  say "  3. Docker Engine and the Compose plugin: Docker's commands from $docker_page"
  say "     (\"Install using the apt repository\"), with -y added to its two apt installs because you approve them here:"
  print_docker_commands
  say "     Why: runs the hub. Changes: adds Docker's signing key and package source, installs Docker."
  say "     Undo: the Uninstall section of the same Docker page."
  say "     Deleting Docker's data folders, as that section shows, also deletes the household."
  say ""
  say "  4. sudo usermod -aG docker $USER"
  say "     Why: lets your account ($USER, and only yours) run Docker and the checks without sudo."
  say "     This group is equal to administrator rights. Undo: sudo gpasswd -d $USER docker"
  say ""
  say "  5. The GitHub CLI block from GitHub's install page"
  say "     (https://github.com/cli/cli/blob/trunk/docs/install_linux.md, section Debian):"
  print_gh_commands
  say "     Why: checks the image's signature, with no sign-in. Changes: installs wget if it is missing, adds"
  say "     GitHub's signing key /etc/apt/keyrings/githubcli-archive-keyring.gpg and package source"
  say "     /etc/apt/sources.list.d/github-cli.list, then installs gh."
  say "     Undo: sudo apt remove gh, then sudo rm /etc/apt/sources.list.d/github-cli.list /etc/apt/keyrings/githubcli-archive-keyring.gpg"
  if [ "$SCREEN" != none ]; then
    say ""
    say "  6. sudo raspi-config nonint do_boot_behaviour B4"
    say "     Only if the screen setup prints it; the script asks you again first."
    say "     Why: the desktop logs in by itself, so the screen comes back after a power cut."
    say "     Undo: sudo raspi-config nonint do_boot_behaviour B3"
  fi
  say ""
  say "  At the end, you restart the device yourself with: sudo reboot"
  say ""
  say "  Other changes, without sudo: the sproutwall folder in your home folder and the household's Docker"
  say "  volume (keep both). The screen setup writes a few files in your home folder; ./scripts/sproutwall"
  say "  setup kiosk --undo puts them back. The script sends nothing anywhere except the package installs,"
  say "  the code download, the image download and the image's signature check. It never asks for your PIN."
  say "  If a check finds a problem (for example SSH turned on), the script stops and the guide says what to do."
}

ask_home_network_rule() {
  say ""
  say "THE HOME-NETWORK RULE"
  say "You control this network (it is your own router), it is not a guest or public network, no router"
  say "port is forwarded to this device, and no tunnel or remote-access service exposes it."
  if ! ask_yes_no "Is all of this true for the network this device is on?"; then
    leave_unchanged "Sproutwall is built for a trusted home network only, so nothing was changed. See $GUIDE#the-five-decisions"
  fi
}

# --- step 3: tools ------------------------------------------------------------------------

# Docker's Debian page, "Install using the apt repository", steps 1 and 2:
# https://docs.docker.com/engine/install/debian/ (also the page for 64-bit
# Raspberry Pi OS), with -y added to its two apt installs: the person approved
# these exact lines in the plan, and apt would otherwise stop at [Y/n].
# Keep in step with print_docker_commands.
install_docker_debian() {
  # Add Docker's official GPG key:
  sudo apt update || return 1
  sudo apt install -y ca-certificates curl || return 1
  sudo install -m 0755 -d /etc/apt/keyrings || return 1
  sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc || return 1
  sudo chmod a+r /etc/apt/keyrings/docker.asc || return 1

  # Add the repository to Apt sources:
  # shellcheck disable=SC1091
  sudo tee /etc/apt/sources.list.d/docker.sources <<EOF || return 1
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

  sudo apt update || return 1
  sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
}

# Docker's Ubuntu page, the same steps and the same -y: https://docs.docker.com/engine/install/ubuntu/
install_docker_ubuntu() {
  # Add Docker's official GPG key:
  sudo apt update || return 1
  sudo apt install -y ca-certificates curl || return 1
  sudo install -m 0755 -d /etc/apt/keyrings || return 1
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc || return 1
  sudo chmod a+r /etc/apt/keyrings/docker.asc || return 1

  # Add the repository to Apt sources:
  # shellcheck disable=SC1091
  sudo tee /etc/apt/sources.list.d/docker.sources <<EOF || return 1
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

  sudo apt update || return 1
  sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
}

# GitHub CLI, exactly as INSTALL-WITH-AI.md step 3 shows it (from GitHub's
# install_linux.md, section Debian). Keep in step with print_gh_commands.
install_gh() {
  local out
  # shellcheck disable=SC2086,SC2002
  (type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
    && sudo mkdir -p -m 755 /etc/apt/keyrings \
    && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && sudo mkdir -p -m 755 /etc/apt/sources.list.d \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && sudo apt update \
    && sudo apt install gh -y
}

system_update() {
  sudo apt update && sudo apt full-upgrade -y
}

# Runs one install step. Its error output still shows, and is also kept in
# the script's own temporary folder, so a failure from apt's lock can be told
# apart from other failures.
with_errors_kept() {
  : >"$WORK_DIR/errors"
  { "$@" 2>&1 >&3 | tee "$WORK_DIR/errors" >&2; } 3>&1
}

apt_was_locked() {
  grep -Eq 'Could not get lock|Unable to acquire the dpkg frontend lock|Unable to lock' "$WORK_DIR/errors"
}

# A new Raspberry Pi OS (Imager 2), like many Ubuntu images, runs cloud-init
# at first start, and it holds apt's lock while it works. Read-only, no sudo.
# It never stops the install: the only concern is apt's lock, and the
# apt-lock messages cover what can happen next. coreutils timeout is always
# there on Debian, Ubuntu and Raspberry Pi OS; without it, wait as before.
wait_for_first_start_setup() {
  local device="this device's" device_cap="This device's" code
  if ! command -v cloud-init >/dev/null 2>&1; then
    return 0
  fi
  if [ "$IS_RPI_OS" = 1 ]; then
    device="the Pi's"
    device_cap="The Pi's"
  fi
  say "Waiting for $device first-start setup to finish..."
  if command -v timeout >/dev/null 2>&1; then
    if timeout 600 cloud-init status --wait; then code=0; else code=$?; fi
  else
    if cloud-init status --wait; then code=0; else code=$?; fi
  fi
  case "$code" in
    0) ;;
    124) say "$device_cap first-start setup is still running after 10 minutes; continuing anyway." ;;
    *) say "$device_cap first-start setup reported a problem of its own; continuing anyway." ;;
  esac
}

install_tools() {
  local failed="Nothing of Sproutwall was set up yet, and it is safe to run this script again. Check the internet connection and the messages above, or follow the guide by hand: $GUIDE#install-the-tools"
  say ""
  say "== Installing the tools (guide step 3). sudo asks for your password. =="
  wait_for_first_start_setup
  if ! with_errors_kept system_update; then
    # Nothing was installed or upgraded yet: at most apt refreshed its package lists.
    if apt_was_locked; then
      stop "Another update is running. Wait a few minutes and run the same command again. Nothing that matters was changed."
    fi
    stop "The system update failed. $failed"
  fi
  with_errors_kept sudo apt install -y git || stop_install_step "git could not be installed."
  if [ "$OS_ID" = ubuntu ]; then
    with_errors_kept install_docker_ubuntu || stop_install_step "Docker could not be installed."
  else
    with_errors_kept install_docker_debian || stop_install_step "Docker could not be installed."
  fi
  sudo usermod -aG docker "$USER" || stop "Your account could not be added to the docker group. $failed"
  with_errors_kept install_gh || stop_install_step "The GitHub CLI (gh) could not be installed."
  say "Don't run gh auth login: the image check needs no account."
}

# A failed install step after the system update: say so accurately.
stop_install_step() {
  if apt_was_locked; then
    stop "Another update is running. Wait a few minutes and run the same command again. The system update already ran and some tools may be installed; nothing of Sproutwall was set up yet, and running it again is safe."
  fi
  stop "$1 The system update already ran and some tools may be installed; nothing of Sproutwall was set up yet, and it is safe to run this script again. Check the internet connection and the messages above, or follow the guide by hand: $GUIDE#install-the-tools"
}

# Guide step 3, "Check the tools". No re-login: the docker group is used
# through sg for the rest of the run.
check_tools() {
  local failed="Nothing of Sproutwall was set up yet. Fix it (see $GUIDE#check-the-tools), then run this script again."
  local text version
  say ""
  say "== Checking the tools =="
  text=$(python3 --version 2>&1) || stop "python3 did not run. $failed"
  say "$text"
  version=$(first_version "$text")
  { [ -n "$version" ] && version_at_least 3.11.0 "$version"; } || stop "Python 3.11 or newer is needed. $failed"
  text=$(as_docker_group docker compose version 2>&1) || stop "Docker Compose did not run. $failed"
  say "$text"
  version=$(first_version "$text")
  { [ -n "$version" ] && version_at_least 2.0.0 "$version"; } || stop "Docker Compose v2 or newer is needed. $failed"
  as_docker_group docker info >/dev/null || stop "Docker is not running, or your account cannot reach it. $failed"
  say "Docker OK"
  text=$(gh --version 2>&1) || stop "gh did not run. $failed"
  say "${text%%$'\n'*}"
  version=$(first_version "$text")
  { [ -n "$version" ] && version_at_least 2.68.0 "$version"; } || stop "gh 2.68.0 or newer is needed. $failed"
  gh attestation verify --help >/dev/null || stop "gh cannot check attestations. $failed"
  say "gh attestation OK"
}

# Guide step 3, "Check again for an existing hub, now that Docker is
# installed": this must print nothing.
#   ls -d ~/sproutwall ~/family-hub 2>/dev/null; docker volume ls -q --filter name=familyhub-data
# Here every volume and container name goes through the same matcher as the
# first check (a superset of that filter): Docker's data can outlive an
# uninstalled docker command.
check_no_existing_hub_again() {
  local found volumes containers
  found=$(ls -d "$HOME/sproutwall" "$HOME/family-hub" 2>/dev/null || true)
  volumes=$(as_docker_group docker volume ls -q) \
    || stop "Docker could not be asked about an existing hub, so this script stops before it gets the code. Check docker info, then follow $GUIDE#check-the-tools"
  containers=$(as_docker_group docker ps -a --format '{{.Names}}') \
    || stop "Docker could not be asked about an existing hub, so this script stops before it gets the code. Check docker info, then follow $GUIDE#check-the-tools"
  if [ -n "$found" ] || names_include_a_hub "$containers" "$volumes"; then
    stop_existing_hub after_tools
  fi
}

# --- step 3: the code at the pinned commit ------------------------------------------------

get_code() {
  say ""
  say "== Getting the code at the pinned commit =="
  cd "$HOME" || stop "Your home folder could not be opened. Nothing was started."
  git clone "$REPO_URL" sproutwall || stop "The code could not be downloaded. Check the internet connection. If a sproutwall folder was left in your home folder, it holds no household yet; continue by hand from $GUIDE#get-the-code-at-the-pinned-commit"
  cd "$HOME/sproutwall" || stop "The sproutwall folder could not be opened. Get help: $GUIDE#if-something-goes-wrong"
  git checkout --detach "$PINNED_SOURCE_COMMIT" || stop "The pinned commit could not be checked out. Nothing was started. Continue by hand from $GUIDE#get-the-code-at-the-pinned-commit"
  if test "$(git remote get-url origin)" = "https://github.com/thebrianlee/sproutwall.git" && test "$(git rev-parse HEAD)" = "$PINNED_SOURCE_COMMIT"; then
    say "Source OK"
  else
    stop "The code is not the pinned commit from the official repository. Nothing was started. Don't run anything from ~/sproutwall; get help: $GUIDE#if-something-goes-wrong"
  fi
}

# --- step 4: check the image before starting it -------------------------------------------

verify_image() {
  local hex=${PINNED_IMAGE_DIGEST#sha256:} status numstat count code
  say ""
  say "== Checking the image before starting it (guide step 4) =="
  cd "$HOME/sproutwall" || stop "The sproutwall folder could not be opened. Get help: $GUIDE#if-something-goes-wrong"
  sed -i 's|@sha256:<published-index-digest-hex>"|@sha256:'"$hex"'"|' "$PREVIEW" \
    || stop "The pinned digest could not be written into $PREVIEW. Nothing was started. Get help: $GUIDE#step-4-check-the-image-before-starting-it"
  status=$(git status --short)
  numstat=$(git diff --numstat)
  count=$(grep -c '@sha256:'"$hex"'"' "$PREVIEW" || true)
  if [ "$status" != " M $PREVIEW" ] || [ "$numstat" != "$(printf '1\t1\t%s' "$PREVIEW")" ] || [ "$count" != 1 ]; then
    stop "Writing the pinned digest into $PREVIEW did not give exactly the one expected change. Nothing was started. Get help: $GUIDE#step-4-check-the-image-before-starting-it"
  fi
  say "The pinned digest is in $PREVIEW."
  if as_docker_group ./scripts/sproutwall verify-image --source-sha "$PINNED_SOURCE_COMMIT" --digest "$PINNED_IMAGE_DIGEST"; then
    code=0
  else
    code=$?
  fi
  say "exit $code"
  local again="cd ~/sproutwall && ./scripts/sproutwall verify-image --source-sha $PINNED_SOURCE_COMMIT --digest $PINNED_IMAGE_DIGEST"
  local continue_at="Nothing was started. Once that check exits 0, continue by hand at $GUIDE#step-5-start-the-hub-and-claim-it-right-away"
  case "$code" in
    0) return 0 ;;
    1) stop "The image is not verified: the signature check failed or timed out. Don't start the hub; get help: $GUIDE#step-4-check-the-image-before-starting-it" ;;
    3) stop "gh is missing or older than 2.68.0. Install gh from GitHub's repository (guide step 3), then run: $again. $continue_at" ;;
    4) stop "The image's signed build record could not be downloaded, or failed its own checks. Check the internet connection, wait, then run: $again. $continue_at" ;;
    5) stop "verify-image could not remove its temporary files, so the image counts as not verified. Delete the sproutwall-verify-* folders in /tmp, then run: $again. $continue_at" ;;
    *) stop "verify-image refused before checking (exit $code). Nothing was started. Get help: $GUIDE#step-4-check-the-image-before-starting-it" ;;
  esac
}

# --- step 5: start the hub and claim it right away ----------------------------------------

stop_blocked_database() {
  stop "The hub answered 503: the database is blocked. Don't start over with a new volume. Read the hub's own message yourself with: cd ~/sproutwall && docker compose -f $PREVIEW logs (don't paste it into a chat), then get help: $GUIDE#if-something-goes-wrong"
}

# Prints the checks doctor did not pass as "id status action" (fixed words only).
doctor_findings() {
  python3 -c '
import json, sys
report = json.load(sys.stdin)
for check in report["checks"]:
    if check["status"] not in ("pass", "not_applicable"):
        print(check["id"], check["status"], check["action"])
'
}

DOCTOR_FINDINGS=""
TRUSTED_LAN_ONLY="app_bind unknown confirm_trusted_lan"

# Runs doctor --json for a phase. True when the guide's rule allows going on:
# exit 0, or exit 2 whose only unknown is app_bind / confirm_trusted_lan (the
# person confirmed the home-network rule before anything was installed).
doctor_allows() {
  local phase=$1 report code
  if report=$(as_docker_group ./scripts/sproutwall doctor --json --phase "$phase" --tier C); then
    code=0
  else
    code=$?
  fi
  DOCTOR_FINDINGS=$(printf '%s\n' "$report" | doctor_findings 2>/dev/null || printf 'report unreadable\n')
  if [ "$code" = 0 ]; then
    return 0
  fi
  [ "$code" = 2 ] && [ "$DOCTOR_FINDINGS" = "$TRUSTED_LAN_ONLY" ]
}

stop_doctor() {
  local phase=$1
  say ""
  say "doctor's own report:"
  as_docker_group ./scripts/sproutwall doctor --phase "$phase" --tier C || true
  stop "doctor found something that is not a clean result (see its report above). Don't work around it: look up each check and action in $GUIDE#if-something-goes-wrong"
}

start_hub() {
  local up_ok=1 ps_out health blocked
  say ""
  say "== Starting the hub (guide step 5) =="
  if ! home_network_ok; then
    stop "This device now has an address outside the home-network ranges (hostname -I), so it may be reachable from outside your home. Nothing was started. Read the home-network rule: $GUIDE#the-five-decisions"
  fi
  cd "$HOME/sproutwall" || stop "The sproutwall folder could not be opened. Get help: $GUIDE#if-something-goes-wrong"
  as_docker_group docker compose -f "$PREVIEW" up -d --wait || up_ok=0
  # curl's error text goes to the script's own temporary folder.
  if health=$(curl -fsS --max-time 3 "$HEALTH_URL" 2>"$WORK_DIR/curl.err"); then
    blocked=0
  else
    health=""
    blocked=0
    if grep -q 503 "$WORK_DIR/curl.err"; then blocked=1; fi
  fi
  if [ "$blocked" = 1 ]; then
    stop_blocked_database
  fi
  if [ "$up_ok" = 0 ]; then
    stop "The hub did not start healthy. Don't start over with a new volume and don't delete anything. Check: cd ~/sproutwall && docker compose -f $PREVIEW ps, wait a minute, then get help if it repeats: $GUIDE#if-something-goes-wrong"
  fi
  ps_out=$(as_docker_group docker compose -f "$PREVIEW" ps) || ps_out=""
  printf '%s\n' "$ps_out"
  case "$ps_out" in
    *"(healthy)"*) ;;
    *) stop "The hub is not reported healthy yet. Wait a minute and check: cd ~/sproutwall && docker compose -f $PREVIEW ps. If it repeats, get help: $GUIDE#if-something-goes-wrong" ;;
  esac
  printf '%s\n' "$health"
  case "$health" in
    *'"ok":true'*) ;;
    *) stop "The health check did not answer \"ok\":true. Wait a minute and run: curl -fsS --max-time 3 $HEALTH_URL. If it repeats, get help: $GUIDE#if-something-goes-wrong" ;;
  esac
  say ""
  say "Running the first check (doctor, phase running)..."
  if ! doctor_allows running; then
    stop_doctor running
  fi
  note_trusted_lan
}

note_trusted_lan() {
  if [ "$DOCTOR_FINDINGS" != "$TRUSTED_LAN_ONLY" ]; then
    say "doctor: pass."
  elif [ "${1:-}" = again ]; then
    say "doctor: OK, again with only the expected home-network unknown (app_bind / confirm_trusted_lan)."
  else
    say "doctor: OK, with the one expected unknown: the device cannot see your router, so you confirmed the home-network rule (app_bind / confirm_trusted_lan). This is a known gap, not a clean pass."
  fi
}

# --- step 6: the household, on the device's own screen ------------------------------------

setup_household() {
  say ""
  say "== Set up your household now (guide step 6) =="
  say "Until first-run setup is done, anyone on your network who opens the hub could choose the PIN. Do it now."
  say "On this device's own screen, open the web browser at: http://localhost:3847"
  say "You see \"Set up the house\":"
  say "  1. Your family: try it with the sample family, or set up your own."
  say "  2. What should your wall show? Choose, or tap \"Skip, use recommended\"."
  say "  3. The house: names, the time zone (keep it), the location for the weather, and the Parent PIN."
  say "  4. Tap \"Open the wall\"."
  say "Type the PIN only on the hub's screen. This script never asks for it, reads it or shows it."
  while true; do
    if ! wait_for_enter "When you have tapped \"Open the wall\", come back here."; then
      stop "No answer from the terminal. The hub is running: finish setup on the screen now, then run the check by hand: $GUIDE#step-6-set-up-the-household-then-check"
    fi
    if doctor_allows configured; then
      note_trusted_lan again
      return 0
    fi
    if setup_not_finished_only; then
      say "Setup is not finished yet. Finish it on the hub's screen (\"Open the wall\" at the end)."
      continue
    fi
    stop_doctor configured
  done
}

# True when every finding is either the trusted-LAN unknown or an open_hub
# action (first-run setup not finished yet).
setup_not_finished_only() {
  local id status action seen=0
  while read -r id status action; do
    [ -z "$id" ] && continue
    if [ "$id $status $action" = "$TRUSTED_LAN_ONLY" ]; then continue; fi
    [ "$action" = open_hub ] || return 1
    seen=1
  done <<<"$DOCTOR_FINDINGS"
  [ "$seen" = 1 ]
}

# --- step 7: the screen -------------------------------------------------------------------

offer_autologin() {
  local output=$1
  case "$output" in
    *"sudo raspi-config nonint do_boot_behaviour B4"*) ;;
    *) return 0 ;;
  esac
  say ""
  say "The screen must come back by itself after a power cut, so the desktop must log in by itself."
  say "That needs administrator rights, so the setup tool printed the command instead of running it:"
  say "  sudo raspi-config nonint do_boot_behaviour B4"
  say "It is in the plan you approved. Undo later: sudo raspi-config nonint do_boot_behaviour B3"
  if ask_yes_no "Run it now? sudo asks for your password."; then
    sudo raspi-config nonint do_boot_behaviour B4 || stop "Turning on desktop autologin failed. The hub keeps running. Run the command yourself later: sudo raspi-config nonint do_boot_behaviour B4 (guide step 7: $GUIDE#step-7-set-up-the-screen)"
  else
    say "Skipped. Without autologin the kiosk does not come back by itself after a power cut. Run it yourself later: sudo raspi-config nonint do_boot_behaviour B4"
  fi
}

setup_screen() {
  local output code
  local -a args=(setup kiosk)
  if [ "$SCREEN" = none ]; then
    KIOSK_RESULT="off"
    return 0
  fi
  if [ "$SCREEN" != portrait ]; then
    args+=(--orientation "$SCREEN")
  fi
  say ""
  say "== Setting up the screen (guide step 7) =="
  cd "$HOME/sproutwall" || stop "The sproutwall folder could not be opened. Get help: $GUIDE#if-something-goes-wrong"
  while true; do
    if output=$(./scripts/sproutwall "${args[@]}" 2>&1); then code=0; else code=$?; fi
    printf '%s\n' "$output"
    case "$code" in
      0 | 1) break ;;
      4)
        say "Usually the screen or its touch connection was not found, or several were: reconnect the one screen, unplug any other, and wait ten seconds."
        if ask_yes_no "Try the screen setup again?"; then continue; fi
        ;;
      *) say "Nothing was changed unless the message above says so. The hub keeps working either way." ;;
    esac
    KIOSK_RESULT="off"
    say "The screen is not set up. Set it up by hand ($PI_GUIDE#set-it-up-by-hand), or keep it without a kiosk."
    return 0
  done
  if [ "$code" = 0 ]; then
    wait_for_enter "Tap the four corners and the centre of the screen. Each tap must land under your finger. If taps land elsewhere, run ./scripts/sproutwall setup kiosk --undo later and report it." || true
  fi
  offer_autologin "$output"
  if [ "$code" = 1 ]; then
    KIOSK_RESULT="attention"
    say "The screen settings apply at the next login: after the restart, run ./scripts/sproutwall setup kiosk --check (guide step 7)."
    return 0
  fi
  say ""
  if output=$(./scripts/sproutwall setup kiosk --check 2>&1); then code=0; else code=$?; fi
  printf '%s\n' "$output"
  if [ "$code" = 0 ]; then
    KIOSK_RESULT="on"
  else
    KIOSK_RESULT="attention"
    say "The screen check needs attention (see above). The hub keeps working. Guide step 7: $GUIDE#step-7-set-up-the-screen"
  fi
}

# --- finish -------------------------------------------------------------------------------

finish() {
  local kiosk_flag=off address
  address=$(first_lan_address)
  case "$KIOSK_RESULT" in
    on | attention) kiosk_flag=on ;;
  esac
  say ""
  say "== Sproutwall is installed =="
  say "- Installed: git, Docker Engine with Compose (Docker's apt repository), gh (GitHub's apt repository);"
  say "  your account joined the docker group (undo: sudo gpasswd -d $USER docker)."
  say "- The hub runs the verified preview from ~/sproutwall. Keep that folder: it is the hub's folder."
  say "  The household lives in its Docker volume. Never run docker compose down -v or docker volume rm."
  case "$KIOSK_RESULT" in
    on) say "- Screen: the kiosk is set up ($SCREEN). Undo: $GUIDE#undo-the-kiosk" ;;
    attention) say "- Screen: the kiosk is set up but needs a check after the restart: ./scripts/sproutwall setup kiosk --check. Undo: $GUIDE#undo-the-kiosk" ;;
    *) say "- Screen: no kiosk. To show the hub full screen, set it up by hand: $PI_GUIDE#step-6-show-the-hub-full-screen-on-the-pis-own-screen-optional" ;;
  esac
  say "- Phone check: on a phone on the same Wi-Fi, open http://$address:3847. It must show \"Unlock this screen\""
  say "  and ask for the PIN, never the family. If it shows the family without asking, stop the hub"
  say "  (cd ~/sproutwall && docker compose -f $PREVIEW stop) and get help."
  say "- Undo the other changes: the Undo column of the install plan, $GUIDE#the-install-plan-decision-3"
  say ""
  say "Now restart the device:  sudo reboot"
  say "After the restart, check it once more (guide step 8, the final check):"
  say "  cd ~/sproutwall"
  say "  ./scripts/sproutwall doctor --phase final --tier C --kiosk $kiosk_flag"
  say "It passes with \"Result: pass\", or with \"Result: unknown\" when the only unknown is app_bind / confirm_trusted_lan."
  if [ "$kiosk_flag" = on ]; then
    say "With the kiosk, the hub comes back on the screen by itself, the right way up, and asks once for the parent"
    say "PIN: type it there. Tap the four corners and the centre again. The screen must stay lit."
  else
    say "Without the kiosk, run the guide's two checks. ps must show healthy, and the health check must print \"ok\":true."
    say "Right after the restart, ps can show health: starting for up to a minute: wait 30 seconds and run both again."
    say "  cd ~/sproutwall"
    say "  docker compose -f docker-compose.preview.yml ps"
    say "  curl -fsS --max-time 3 http://127.0.0.1:3847/api/health"
  fi
  say "A phone on the home Wi-Fi must still show \"Unlock this screen\" at http://$address:3847."
  say "Something wrong? $GUIDE#if-something-goes-wrong"
}

# --- main ---------------------------------------------------------------------------------

run_install() {
  # The only folder this script ever removes (on_exit): its own temporary one.
  WORK_DIR=$(mktemp -d)
  ask_screen
  show_plan
  if ! ask_yes_no "Do you approve this plan?"; then
    leave_unchanged "You did not approve the plan, so nothing was changed. You can also follow the guide by hand: $GUIDE#without-ai"
  fi
  check_docker_with_sudo
  ask_home_network_rule
  install_tools
  check_tools
  check_no_existing_hub_again
  get_code
  verify_image
  start_hub
  setup_household
  setup_screen
  finish
}

main() {
  trap on_exit EXIT
  trap on_interrupt INT
  say "Sproutwall install (preview $PINNED_SOURCE_COMMIT)"
  check_not_root
  check_supported_device
  check_preflight_tools
  check_terminal
  check_no_existing_hub_first
  check_home_network_first
  run_install <"$TTY_PATH"
  exit 0
}

# Braces: a download cut off anywhere in this line leaves an unclosed group,
# which bash refuses as a syntax error, so a partial line never runs main.
{ main "$@" </dev/null; }
