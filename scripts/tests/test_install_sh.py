"""install.sh, the one-command install, run against PATH shims.

Nothing here touches the host: every command install.sh may run is either a
fake in a private bin folder (sudo, apt, apt-get, docker, sg, git, curl, gh,
wget, hostname, uname, dpkg, id) or a plain text tool linked from the host
(ls, grep, sed, cat, mktemp, rm, tr, python3). Any other command is "not
found". /etc/os-release, /etc/rpi-issue and the device-tree model come from a
fake root folder, and the answers from a file instead of the terminal
(SPROUTWALL_INSTALL_TEST_ROOT and SPROUTWALL_INSTALL_TEST_TTY). The script is
fed to bash on stdin, as `curl ... | bash` does.
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest

from sproutwall_lib import schema

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(SCRIPTS)
INSTALL_SH = os.path.join(ROOT, "install.sh")
GUIDE = os.path.join(ROOT, "INSTALL-WITH-AI.md")
COMPOSE_TEMPLATE = os.path.join(ROOT, "docker-compose.preview.yml")
BASH = shutil.which("bash")

# Answers are followed by this line. A fictional PIN: if the script ever read
# one line more than it asked for, the flow tests would see it.
FAKE_PIN = "2468"
PROMPT_MARKERS = ("[y/N]", "[1-5, Enter = 1]", "(press Enter)")
HOST_TOOLS = ("ls", "grep", "sed", "cat", "mktemp", "rm", "tr", "python3", "cmp", "diff", "mkdir", "cp")


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def pinned_pair_in_script():
    text = read(INSTALL_SH)
    commit = re.search(r'^PINNED_SOURCE_COMMIT="([^"]*)"$', text, re.M).group(1)
    digest = re.search(r'^PINNED_IMAGE_DIGEST="([^"]*)"$', text, re.M).group(1)
    return commit, digest


def pinned_pair_in_guide():
    text = read(GUIDE)
    commit = re.search(r"^\| Source commit \| `([^`]*)` \|$", text, re.M).group(1)
    digest = re.search(r"^\| Image index digest \| `([^`]*)` \|$", text, re.M).group(1)
    return commit, digest


COMMIT, DIGEST = pinned_pair_in_script()


def doctor_json(phase, **overrides):
    """A real closed-schema doctor report: every check passes except overrides."""
    outcomes = {check_id: schema.PASS for check_id in schema.CHECK_IDS}
    outcomes.update(overrides)
    report = schema.build_report(phase, outcomes)
    return schema.serialize(report), schema.exit_code(report)


TRUSTED_LAN = {"app_bind": ("unknown", "confirm_trusted_lan")}

SHIMS = {
    "sudo": r"""#!/bin/bash
printf 'sudo %s\n' "$*" >>"$FAKE_LOG"
if [ "$1" = tee ]; then cat >/dev/null; fi
if [ -n "${FAKE_SUDO_FAIL:-}" ] && [ "$*" = "$FAKE_SUDO_FAIL" ]; then exit 100; fi
exit 0
""",
    "apt": "#!/bin/bash\nprintf 'apt %s\\n' \"$*\" >>\"$FAKE_LOG\"\nexit 0\n",
    "apt-get": "#!/bin/bash\nprintf 'apt-get %s\\n' \"$*\" >>\"$FAKE_LOG\"\nexit 0\n",
    "id": r"""#!/bin/bash
printf 'id %s\n' "$*" >>"$FAKE_LOG"
case "$1" in
  -u) echo "${FAKE_UID:-1000}" ;;
  -un) echo parent ;;
  *) echo "uid=1000(parent) gid=1000(parent)" ;;
esac
""",
    "uname": r"""#!/bin/bash
printf 'uname %s\n' "$*" >>"$FAKE_LOG"
case "$1" in
  -s) echo "${FAKE_KERNEL:-Linux}" ;;
  -m) echo "${FAKE_MACHINE:-aarch64}" ;;
  *) echo Linux ;;
esac
""",
    "dpkg": r"""#!/bin/bash
printf 'dpkg %s\n' "$*" >>"$FAKE_LOG"
[ "$1" = --print-architecture ] || exit 99
echo "${FAKE_ARCH:-arm64}"
""",
    "hostname": r"""#!/bin/bash
printf 'hostname %s\n' "$*" >>"$FAKE_LOG"
[ "$1" = -I ] || exit 99
count=$(( $(cat "$FAKE_STATE/hostname.count" 2>/dev/null || echo 0) + 1 ))
echo "$count" >"$FAKE_STATE/hostname.count"
if [ "$count" -gt 1 ] && [ -n "${FAKE_HOSTNAME_LATER:-}" ]; then
  echo "$FAKE_HOSTNAME_LATER"
else
  echo "${FAKE_HOSTNAME:-192.168.1.50 172.17.0.1 fd12:3456::50}"
fi
""",
    "sg": r"""#!/bin/bash
printf 'sg %s\n' "$*" >>"$FAKE_LOG"
[ "$1" = docker ] && [ "$2" = -c ] && [ "$#" = 3 ] || exit 98
export FAKE_IN_SG=1
exec /bin/sh -c "$3"
""",
    "docker": r"""#!/bin/bash
printf 'docker %s\n' "$*" >>"$FAKE_LOG"
if [ -n "${FAKE_DOCKER_DENIED_OUTSIDE_SG:-}" ] && [ -z "${FAKE_IN_SG:-}" ]; then
  echo "permission denied while trying to connect to the Docker daemon socket" >&2
  exit 1
fi
case "$*" in
  "ps -a --format {{.Names}}") printf '%s' "${FAKE_CONTAINERS:-}" ;;
  "volume ls -q") printf '%s' "${FAKE_VOLUMES:-}" ;;
  "volume ls -q --filter name=familyhub-data") printf '%s' "${FAKE_VOLUMES:-}" | grep familyhub-data || true ;;
  "compose version") echo "Docker Compose version v2.39.1" ;;
  "info") echo "Server Version: 29.0.0" ;;
  "compose -f docker-compose.preview.yml up -d --wait") exit "${FAKE_UP_EXIT:-0}" ;;
  "compose -f docker-compose.preview.yml ps")
    echo "NAME                      IMAGE      SERVICE      STATUS"
    echo "sproutwall-family-hub-1   ghcr.io    family-hub   Up 12 seconds (${FAKE_PS_HEALTH:-healthy})"
    ;;
  *) echo "fake docker: unexpected call" >&2; exit 99 ;;
esac
""",
    "gh": r"""#!/bin/bash
printf 'gh %s\n' "$*" >>"$FAKE_LOG"
case "$*" in
  --version) echo "gh version ${FAKE_GH_VERSION:-2.105.0} (2026-01-01)"; echo "https://github.com/cli/cli/releases/tag/v2.105.0" ;;
  "attestation verify --help") exit 0 ;;
  *) exit 99 ;;
esac
""",
    "wget": r"""#!/bin/bash
printf 'wget %s\n' "$*" >>"$FAKE_LOG"
for arg in "$@"; do
  case "$arg" in -O*) echo "fake keyring" >"${arg#-O}" ;; esac
done
""",
    "curl": r"""#!/bin/bash
printf 'curl %s\n' "$*" >>"$FAKE_LOG"
case "$*" in
  "-fsS --max-time 3 http://127.0.0.1:3847/api/health")
    case "${FAKE_HEALTH:-ok}" in
      ok) echo '{"ok":true,"version":"0.1.0-preview.0","schema":12,"setup":false}' ;;
      503) echo "curl: (22) The requested URL returned error: 503" >&2; exit 22 ;;
      *) echo "curl: (7) Failed to connect" >&2; exit 7 ;;
    esac
    ;;
  *) exit 99 ;;
esac
""",
    "git": r"""#!/bin/bash
printf 'git %s\n' "$*" >>"$FAKE_LOG"
case "$1" in
  clone)
    [ "$#" = 3 ] && [ "$2" = "https://github.com/thebrianlee/sproutwall.git" ] || exit 99
    mkdir "$3" || exit 128
    mkdir -p "$3/.git" "$3/scripts"
    cp "$FAKE_COMPOSE_TEMPLATE" "$3/docker-compose.preview.yml"
    cp "$FAKE_COMPOSE_TEMPLATE" "$3/.git/original-compose"
    cp "$FAKE_SPROUTWALL" "$3/scripts/sproutwall"
    echo "$2" >"$3/.git/origin"
    echo 0000000000000000000000000000000000000000 >"$3/.git/head"
    ;;
  checkout) [ "$2" = --detach ] && echo "${FAKE_CHECKOUT_HEAD:-$3}" >.git/head ;;
  remote) [ "$2 $3" = "get-url origin" ] && cat .git/origin ;;
  rev-parse) [ "$2" = HEAD ] && cat .git/head ;;
  status)
    [ "$2" = --short ] || exit 99
    cmp -s .git/original-compose docker-compose.preview.yml || echo " M docker-compose.preview.yml"
    ;;
  diff)
    [ "$2" = --numstat ] || exit 99
    if ! cmp -s .git/original-compose docker-compose.preview.yml; then
      removed=$(diff .git/original-compose docker-compose.preview.yml | grep -c '^<')
      added=$(diff .git/original-compose docker-compose.preview.yml | grep -c '^>')
      printf '%s\t%s\tdocker-compose.preview.yml\n' "$added" "$removed"
    fi
    ;;
  *) exit 99 ;;
esac
""",
}

# The fake scripts/sproutwall that the fake clone puts in the checkout.
FAKE_SPROUTWALL = r"""#!/bin/bash
printf 'sproutwall %s\n' "$*" >>"$FAKE_LOG"
if [ "$1" = verify-image ]; then
  digest=$5
  grep -q "@${digest}\"" docker-compose.preview.yml || exit 2
  exit "${FAKE_VERIFY_EXIT:-0}"
fi
if [ "$1" = doctor ] && [ "$2" = --json ]; then
  phase=$4
  count=$(( $(cat "$FAKE_STATE/doctor-$phase.count" 2>/dev/null || echo 0) + 1 ))
  echo "$count" >"$FAKE_STATE/doctor-$phase.count"
  base="$FAKE_STATE/doctor-$phase"
  [ -e "$base-$count.json" ] && base="$base-$count"
  cat "$base.json"
  exit "$(cat "$base.exit")"
fi
if [ "$1" = doctor ]; then
  echo "Result: unknown (exit 2)"
  exit 2
fi
if [ "$1 $2" = "setup kiosk" ] && [ "${3:-}" = --check ]; then
  echo "Result: ok (exit 0)"
  exit 0
fi
if [ "$1 $2" = "setup kiosk" ]; then
  count=$(( $(cat "$FAKE_STATE/kiosk.count" 2>/dev/null || echo 0) + 1 ))
  echo "$count" >"$FAKE_STATE/kiosk.count"
  if [ -n "${FAKE_KIOSK_EXIT:-}" ] && [ "$FAKE_KIOSK_EXIT" != 0 ]; then
    echo "Stopped: no connected screen was found." >&2
    exit "$FAKE_KIOSK_EXIT"
  fi
  echo "Kiosk set up on the HDMI screen: portrait (output transform 90)."
  echo "Autologin: off. This step needs administrator rights, so this tool does not do it. Run it yourself in the Pi's terminal; sudo asks for your password:"
  echo "  sudo raspi-config nonint do_boot_behaviour B4"
  echo ""
  echo "Then restart to start the kiosk: sudo reboot"
  exit 0
fi
exit 99
"""


class Run:
    def __init__(self, code, out, err, log, home, prompts):
        self.code = code
        self.out = out
        self.err = err
        self.log = log
        self.home = home
        self.prompts = prompts

    def commands(self):
        return {line.split(" ", 1)[0] for line in self.log}

    def index(self, line):
        return self.log.index(line)


class InstallShTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="install-sh-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.state = os.path.join(self.tmp, "state")
        self.sysroot = os.path.join(self.tmp, "root")
        bin_dir = os.path.join(self.tmp, "bin")
        host_dir = os.path.join(self.tmp, "hostbin")
        for path in (self.home, self.state, bin_dir, host_dir, os.path.join(self.tmp, "tmp")):
            os.makedirs(path)
        for name, body in SHIMS.items():
            self.write(os.path.join(bin_dir, name), body, 0o755)
        for name in HOST_TOOLS:
            found = shutil.which(name)
            self.assertIsNotNone(found, name)
            os.symlink(found, os.path.join(host_dir, name))
        self.fake_sproutwall = self.write(os.path.join(self.state, "fake-sproutwall"), FAKE_SPROUTWALL, 0o755)
        self.log_path = os.path.join(self.state, "log")
        self.tty = os.path.join(self.tmp, "tty")
        self.env = {
            "PATH": bin_dir + ":" + host_dir,
            "HOME": self.home,
            "USER": "parent",
            "LANG": "C.UTF-8",
            "TMPDIR": os.path.join(self.tmp, "tmp"),
            "PYTHONDONTWRITEBYTECODE": "1",
            "FAKE_LOG": self.log_path,
            "FAKE_STATE": self.state,
            "FAKE_COMPOSE_TEMPLATE": COMPOSE_TEMPLATE,
            "FAKE_SPROUTWALL": self.fake_sproutwall,
            "SPROUTWALL_INSTALL_TEST_ROOT": self.sysroot,
            "SPROUTWALL_INSTALL_TEST_TTY": self.tty,
        }
        self.raspberry_pi_os()
        self.doctor("running", **TRUSTED_LAN)
        self.doctor("configured", **TRUSTED_LAN)

    def write(self, path, text, mode=0o644):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(path, mode)
        return path

    def raspberry_pi_os(self, model="Raspberry Pi 5 Model B Rev 1.0"):
        self.write(
            os.path.join(self.sysroot, "etc/os-release"),
            'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_CODENAME=trixie\n',
        )
        self.write(os.path.join(self.sysroot, "etc/rpi-issue"), "Raspberry Pi reference 2026-10-01\n")
        self.write(os.path.join(self.sysroot, "proc/device-tree/model"), model + "\0")

    def ubuntu_pc(self):
        shutil.rmtree(self.sysroot)
        self.write(
            os.path.join(self.sysroot, "etc/os-release"),
            'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n',
        )
        self.env.update(FAKE_ARCH="amd64", FAKE_MACHINE="x86_64")

    def doctor(self, phase, number=None, **overrides):
        text, code = doctor_json(phase, **overrides)
        base = os.path.join(self.state, "doctor-%s%s" % (phase, "" if number is None else "-%d" % number))
        self.write(base + ".json", text + "\n")
        self.write(base + ".exit", "%d\n" % code)

    def run_install(self, answers, **env):
        self.write(self.tty, "".join(line + "\n" for line in answers) + FAKE_PIN + "\n")
        full_env = dict(self.env)
        full_env.update(env)
        proc = subprocess.run(
            [BASH],
            input=read(INSTALL_SH).encode(),
            env=full_env,
            cwd=self.tmp,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            check=False,
        )
        log = read(self.log_path).splitlines() if os.path.exists(self.log_path) else []
        out, err = proc.stdout.decode(), proc.stderr.decode()
        prompts = sum(out.count(marker) for marker in PROMPT_MARKERS)
        for text in (out, err, "\n".join(log)):
            self.assertNotIn(FAKE_PIN, text)
        return Run(proc.returncode, out, err, log, self.home, prompts)

    def assert_stopped_before_changes(self, run):
        self.assertEqual(run.code, 1, run.out + run.err)
        self.assertEqual(run.err.count("Stopped:"), 1, run.err)
        self.assertLessEqual(run.commands(), {"id", "uname", "dpkg", "docker", "hostname"}, run.log)
        self.assertEqual(run.prompts, 0, run.out)
        self.assertFalse(os.path.exists(os.path.join(run.home, "sproutwall")))

    def assert_never_destructive(self, run):
        joined = "\n".join(run.log)
        for pattern in (r"\bdown\b", r"volume rm", r"\bprune\b", r"gh auth", r"\bpull\b", r"(?m)^(sudo )?rm\b", r":preview"):
            self.assertNotRegex(joined, pattern)


HAPPY_ANSWERS = ["", "y", "y", "", "", "y"]  # portrait, plan, home network, setup done, taps, autologin


class PinnedPairTests(unittest.TestCase):
    def test_pinned_pair_equals_the_guides_table(self):
        self.assertEqual(pinned_pair_in_script(), pinned_pair_in_guide())

    def test_pinned_pair_is_well_formed(self):
        commit, digest = pinned_pair_in_script()
        self.assertRegex(commit, r"^[0-9a-f]{40}$")
        self.assertRegex(digest, r"^sha256:[0-9a-f]{64}$")

    def test_guide_uses_the_same_pair_in_steps_3_and_4(self):
        commit, digest = pinned_pair_in_guide()
        guide = read(GUIDE)
        self.assertEqual(set(re.findall(r"checkout --detach (\S+)", guide)), {commit})
        self.assertEqual(set(re.findall(r"--source-sha ([0-9a-f]{40})", guide)), {commit})
        self.assertEqual(set(re.findall(r"@sha256:([0-9a-f]{64})", guide)), {digest[len("sha256:"):]})


class MirrorsTheGuideTests(unittest.TestCase):
    def guide_block_after(self, marker):
        guide = read(GUIDE)
        start = guide.index("```bash", guide.index(marker)) + len("```bash")
        return [line.strip() for line in guide[start : guide.index("```", start)].strip().splitlines()]

    def test_github_cli_block_is_the_guides_block(self):
        script = [line.strip() for line in read(INSTALL_SH).splitlines()]
        block = self.guide_block_after("**GitHub CLI (`gh`).**")
        self.assertGreater(len(block), 5)
        for line in block:
            # Once where it runs (install_gh) and once in the printed plan.
            self.assertGreaterEqual(script.count(line), 2, line)

    def test_step_3_and_4_commands_are_the_guides(self):
        script = read(INSTALL_SH)
        for line in self.guide_block_after("### Install the tools"):
            self.assertIn(line, script)
        self.assertIn("sudo usermod -aG docker", script)
        self.assertIn("""sed -i 's|@sha256:<published-index-digest-hex>"|@sha256:'"$hex"'"|'""", script)
        self.assertIn('test "$(git remote get-url origin)" = "https://github.com/thebrianlee/sproutwall.git"', script)
        self.assertIn('docker compose -f "$PREVIEW" up -d --wait', script)
        self.assertIn("curl -fsS --max-time 3", script)

    def test_links_point_to_existing_sections(self):
        def anchors(path):
            found = set()
            for heading in re.findall(r"(?m)^#+ (.+)$", read(path)):
                slug = re.sub(r"[^a-z0-9 -]", "", heading.replace("`", "").lower()).replace(" ", "-")
                found.add(slug)
            return found

        script = read(INSTALL_SH)
        targets = {
            "INSTALL-WITH-AI.md": (GUIDE, re.findall(r"\$GUIDE#([a-z0-9-]+)", script)),
            "docs/raspberry-pi.md": (os.path.join(ROOT, "docs", "raspberry-pi.md"), re.findall(r"\$PI_GUIDE#([a-z0-9-]+)", script)),
        }
        for name, (path, links) in targets.items():
            self.assertTrue(links, name)
            for link in links:
                self.assertIn(link, anchors(path), name)
        self.assertIn("with-one-command", anchors(os.path.join(ROOT, "README.md")))

    def test_no_destructive_or_unsafe_command(self):
        script = read(INSTALL_SH)
        for word in ("prune", "sudoers", "REQUIRE_AUTH_FOR_READS", "8787", "GH_TOKEN", "GITHUB_TOKEN"):
            self.assertNotIn(word, script)
        # "down -v" and "volume rm" appear only in the advice never to run them.
        for word in ("down -v", "volume rm"):
            lines = [line.strip() for line in script.splitlines() if word in line]
            self.assertEqual(lines, ['say "  The household lives in its Docker volume. Never run docker compose down -v or docker volume rm."'])
        removals = re.findall(r"\brm -rf? [^\n]*", script)
        self.assertEqual(removals, ['rm -rf "$tmp_dir"'])
        self.assertNotRegex(script, r"(?m)^\s*(sudo )?gh auth")
        self.assertNotRegex(script, r"(?m)^\s*docker[^\n]*:preview")


class PreflightTests(InstallShTestCase):
    def test_existing_sproutwall_folder_stops_in_preflight(self):
        os.mkdir(os.path.join(self.home, "sproutwall"))
        run = self.run_install(HAPPY_ANSWERS)
        self.assertEqual(run.code, 1)
        self.assertIn("#existing-install--update", run.err)
        self.assertLessEqual(run.commands(), {"id", "uname", "dpkg"}, run.log)
        self.assertEqual(run.prompts, 0)

    def test_existing_family_hub_folder_stops(self):
        os.mkdir(os.path.join(self.home, "family-hub"))
        run = self.run_install(HAPPY_ANSWERS)
        self.assertIn("#existing-install--update", run.err)
        self.assertLessEqual(run.commands(), {"id", "uname", "dpkg"}, run.log)

    def test_existing_docker_volume_stops(self):
        run = self.run_install(HAPPY_ANSWERS, FAKE_VOLUMES="family-hub_familyhub-data\n")
        self.assert_stopped_before_changes(run)
        self.assertIn("#existing-install--update", run.err)
        self.assertIn("docker volume ls -q", run.log)

    def test_existing_container_stops(self):
        run = self.run_install(HAPPY_ANSWERS, FAKE_CONTAINERS="sproutwall-family-hub-1\n")
        self.assert_stopped_before_changes(run)
        self.assertIn("#existing-install--update", run.err)

    def test_volume_seen_only_once_docker_is_reachable_stops_before_the_code(self):
        run = self.run_install(
            HAPPY_ANSWERS[:3], FAKE_DOCKER_DENIED_OUTSIDE_SG="1", FAKE_VOLUMES="sproutwall_familyhub-data\n"
        )
        self.assertEqual(run.code, 1, run.err)
        self.assertIn("#existing-install--update", run.err)
        self.assertIn("docker volume ls -q --filter name=familyhub-data", run.log)
        self.assertNotIn("git", run.commands())
        self.assertFalse(os.path.exists(os.path.join(self.home, "sproutwall")))

    def test_root_stops(self):
        for env in ({"FAKE_UID": "0"}, {"SUDO_USER": "parent"}):
            with self.subTest(env=env):
                run = self.run_install(HAPPY_ANSWERS, **env)
                self.assert_stopped_before_changes(run)
                self.assertIn("not as root", run.err)
                self.assertEqual(run.commands(), {"id"})

    def test_unsupported_systems_stop(self):
        cases = {
            "fedora": ("etc/os-release", "ID=fedora\nVERSION_ID=43\n"),
            "32-bit Raspberry Pi OS": ("etc/os-release", "ID=raspbian\nVERSION_CODENAME=trixie\n"),
            "Raspberry Pi 3": ("proc/device-tree/model", "Raspberry Pi 3 Model B Plus Rev 1.3\0"),
        }
        for name, (path, text) in cases.items():
            with self.subTest(name):
                self.raspberry_pi_os()
                self.write(os.path.join(self.sysroot, path), text)
                run = self.run_install(HAPPY_ANSWERS)
                self.assert_stopped_before_changes(run)
                self.assertIn("#supported-devices", run.err)
        with self.subTest("32-bit userland"):
            self.raspberry_pi_os()
            run = self.run_install(HAPPY_ANSWERS, FAKE_ARCH="armhf")
            self.assert_stopped_before_changes(run)
            self.assertIn("64-bit", run.err)
        with self.subTest("not Linux"):
            run = self.run_install(HAPPY_ANSWERS, FAKE_KERNEL="Darwin")
            self.assert_stopped_before_changes(run)

    def test_no_terminal_prints_the_manual_guide(self):
        self.env["SPROUTWALL_INSTALL_TEST_TTY"] = os.path.join(self.tmp, "no-such-tty")
        run = self.run_install([])
        self.assert_stopped_before_changes(run)
        self.assertIn("INSTALL-WITH-AI.md#without-ai", run.err)

    def test_public_address_stops_before_any_change(self):
        run = self.run_install(HAPPY_ANSWERS, FAKE_HOSTNAME="203.0.113.7 192.168.1.50")
        self.assert_stopped_before_changes(run)
        self.assertIn("hostname -I", run.log)
        self.assertIn("home network", run.err)


class ConsentTests(InstallShTestCase):
    def test_no_at_the_plan_prompt_changes_nothing(self):
        for answer in ("n", "", "maybe", "no"):
            with self.subTest(answer=answer):
                if os.path.exists(self.log_path):
                    os.remove(self.log_path)
                run = self.run_install(["", answer])
                self.assertEqual(run.code, 0, run.err)
                self.assertIn("THE INSTALL PLAN", run.out)
                self.assertIn("nothing was changed", run.out)
                self.assertNotIn("sudo", run.commands())
                self.assertEqual(run.prompts, 2)

    def test_no_at_the_home_network_rule_changes_nothing(self):
        run = self.run_install(["", "y", "n"])
        self.assertEqual(run.code, 0, run.err)
        self.assertIn("trusted home network", run.out)
        self.assertNotIn("sudo", run.commands())

    def test_no_answer_at_all_changes_nothing(self):
        self.write(self.tty, "")
        full_env = dict(self.env)
        proc = subprocess.run(
            [BASH], input=read(INSTALL_SH).encode(), env=full_env, cwd=self.tmp, capture_output=True, timeout=60
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("sudo ", read(self.log_path))


class FailureTests(InstallShTestCase):
    def test_verify_image_failure_stops_before_compose_up(self):
        for code, words in ((1, "not verified"), (4, "internet connection"), (5, "sproutwall-verify-")):
            with self.subTest(code=code):
                shutil.rmtree(self.home)
                os.mkdir(self.home)
                if os.path.exists(self.log_path):
                    os.remove(self.log_path)
                run = self.run_install(HAPPY_ANSWERS, FAKE_VERIFY_EXIT=str(code))
                self.assertEqual(run.code, 1, run.out + run.err)
                self.assertIn(words, run.err)
                self.assertIn("sproutwall verify-image --source-sha %s --digest %s" % (COMMIT, DIGEST), run.log)
                self.assertFalse([line for line in run.log if " up " in line or line.startswith("curl")], run.log)
                self.assert_never_destructive(run)

    def test_public_address_at_start_stops_before_compose_up(self):
        run = self.run_install(HAPPY_ANSWERS, FAKE_HOSTNAME_LATER="192.168.1.50 198.51.100.20")
        self.assertEqual(run.code, 1, run.out + run.err)
        self.assertIn("home-network ranges", run.err)
        verify = run.index("sproutwall verify-image --source-sha %s --digest %s" % (COMMIT, DIGEST))
        self.assertEqual(run.log[verify + 1 :], ["hostname -I"])

    def test_health_503_stops_with_the_guides_message(self):
        run = self.run_install(HAPPY_ANSWERS, FAKE_HEALTH="503")
        self.assertEqual(run.code, 1, run.out + run.err)
        self.assertIn("the database is blocked", run.err)
        self.assertIn("Don't start over with a new volume", run.err)
        self.assertIn("docker compose -f docker-compose.preview.yml logs", run.err)
        self.assertEqual(run.err.count("Stopped:"), 1)
        self.assertNotIn("sproutwall doctor --json --phase running --tier C", run.log)
        self.assert_never_destructive(run)

    def test_compose_up_failure_with_503_stops_with_the_guides_message(self):
        run = self.run_install(HAPPY_ANSWERS, FAKE_UP_EXIT="1", FAKE_HEALTH="503")
        self.assertEqual(run.code, 1)
        self.assertIn("the database is blocked", run.err)
        self.assert_never_destructive(run)

    def test_unhealthy_hub_stops(self):
        run = self.run_install(HAPPY_ANSWERS, FAKE_PS_HEALTH="health: starting")
        self.assertEqual(run.code, 1)
        self.assertIn("not reported healthy", run.err)
        self.assert_never_destructive(run)

    def test_doctor_unknown_other_than_trusted_lan_stops(self):
        self.doctor("running", ssh_policy=("unknown", "review_ssh"), **TRUSTED_LAN)
        run = self.run_install(HAPPY_ANSWERS)
        self.assertEqual(run.code, 1, run.out + run.err)
        self.assertIn("#if-something-goes-wrong", run.err)
        self.assertIn("sproutwall doctor --phase running --tier C", run.log)
        self.assertNotIn("sproutwall setup kiosk", run.log)
        self.assertEqual(run.prompts, 3)

    def test_doctor_fail_stops(self):
        self.doctor("running", app_bind=("fail", "restrict_ports"))
        run = self.run_install(HAPPY_ANSWERS)
        self.assertEqual(run.code, 1)
        self.assertNotIn("sproutwall setup kiosk", run.log)

    def test_failed_system_update_stops_before_the_code(self):
        run = self.run_install(HAPPY_ANSWERS, FAKE_SUDO_FAIL="apt full-upgrade -y")
        self.assertEqual(run.code, 1)
        self.assertIn("safe to run this script again", run.err)
        self.assertNotIn("git", run.commands())
        self.assertEqual(run.log.count("sudo apt install -y git"), 0)

    def test_old_gh_stops_before_the_code(self):
        run = self.run_install(HAPPY_ANSWERS, FAKE_GH_VERSION="2.46.0")
        self.assertEqual(run.code, 1)
        self.assertIn("gh 2.68.0 or newer", run.err)
        self.assertNotIn("git", run.commands())


class HappyPathTests(InstallShTestCase):
    def test_calls_happen_in_the_documented_order(self):
        run = self.run_install(HAPPY_ANSWERS)
        self.assertEqual(run.code, 0, run.out + run.err)
        self.assertEqual(run.err, "")
        # Every answer was asked for, and nothing more was read: the line
        # after the answers (a PIN) was never consumed.
        self.assertEqual(run.prompts, len(HAPPY_ANSWERS))
        expected = [
            "sudo apt update",
            "sudo apt full-upgrade -y",
            "sudo apt install -y git",
            "sudo apt install ca-certificates curl",
            "sudo install -m 0755 -d /etc/apt/keyrings",
            "sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc",
            "sudo chmod a+r /etc/apt/keyrings/docker.asc",
            "sudo tee /etc/apt/sources.list.d/docker.sources",
            "sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
            "sudo usermod -aG docker parent",
            "sudo mkdir -p -m 755 /etc/apt/keyrings",
            "sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg",
            "sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
            "sudo tee /etc/apt/sources.list.d/github-cli.list",
            "sudo apt install gh -y",
            "docker compose version",
            "docker info",
            "gh --version",
            "gh attestation verify --help",
            "docker volume ls -q --filter name=familyhub-data",
            "git clone https://github.com/thebrianlee/sproutwall.git sproutwall",
            "git checkout --detach " + COMMIT,
            "git remote get-url origin",
            "git rev-parse HEAD",
            "git status --short",
            "git diff --numstat",
            "sproutwall verify-image --source-sha %s --digest %s" % (COMMIT, DIGEST),
            "hostname -I",
            "docker compose -f docker-compose.preview.yml up -d --wait",
            "curl -fsS --max-time 3 http://127.0.0.1:3847/api/health",
            "docker compose -f docker-compose.preview.yml ps",
            "sproutwall doctor --json --phase running --tier C",
            "sproutwall doctor --json --phase configured --tier C",
            "sproutwall setup kiosk",
            "sudo raspi-config nonint do_boot_behaviour B4",
            "sproutwall setup kiosk --check",
        ]
        position = 0
        for line in expected:
            self.assertIn(line, run.log[position:], "%r missing or out of order" % line)
            position = run.log.index(line, position) + 1

        # Docker, verify-image and doctor run with the docker group (sg), no re-login.
        for index, line in enumerate(run.log):
            if line.startswith(("docker compose", "sproutwall verify-image", "sproutwall doctor")):
                self.assertTrue(run.log[index - 1].startswith("sg docker -c "), line)
        # After the hub starts, the only sudo is the approved autologin line.
        up = run.index("docker compose -f docker-compose.preview.yml up -d --wait")
        self.assertEqual(
            [line for line in run.log[up:] if line.startswith("sudo")],
            ["sudo raspi-config nonint do_boot_behaviour B4"],
        )
        # Every sudo command that ran was shown in the plan before the first sudo.
        plan = run.out[run.out.index("THE INSTALL PLAN") : run.out.index("Do you approve this plan?")]
        for line in run.log:
            if line.startswith("sudo"):
                self.assertIn(line, plan)
        self.assertNotIn("apt", run.commands())
        self.assertNotIn("apt-get", run.commands())
        self.assert_never_destructive(run)

        compose = read(os.path.join(self.home, "sproutwall", "docker-compose.preview.yml"))
        self.assertEqual(compose.count('@%s"' % DIGEST), 1)
        self.assertNotIn('@sha256:<published-index-digest-hex>"', compose)
        self.assertIn("Source OK", run.out)
        self.assertIn("app_bind / confirm_trusted_lan", run.out)
        self.assertIn("http://localhost:3847", run.out)
        self.assertIn("http://192.168.1.50:3847", run.out)
        self.assertIn("sudo reboot", run.out)
        self.assertIn("doctor --phase final --tier C --kiosk on", run.out)
        self.assertIn("never asks for it", run.out)

    def test_a_second_run_hits_the_existing_install_stop(self):
        first = self.run_install(HAPPY_ANSWERS)
        self.assertEqual(first.code, 0, first.err)
        os.remove(self.log_path)
        second = self.run_install(HAPPY_ANSWERS, FAKE_VOLUMES="sproutwall_familyhub-data\n")
        self.assertEqual(second.code, 1)
        self.assertIn("#existing-install--update", second.err)
        self.assertNotIn("sudo", second.commands())

    def test_landscape_and_no_kiosk(self):
        run = self.run_install(["3", "y", "y", "", "", "y"])
        self.assertEqual(run.code, 0, run.err)
        self.assertIn("sproutwall setup kiosk --orientation landscape", run.log)
        os.remove(self.log_path)
        shutil.rmtree(self.home)
        os.mkdir(self.home)
        for name in os.listdir(self.state):
            if name.endswith(".count"):
                os.remove(os.path.join(self.state, name))
        run = self.run_install(["5", "y", "y", ""])
        self.assertEqual(run.code, 0, run.err)
        self.assertEqual(run.prompts, 4)
        self.assertFalse([line for line in run.log if "setup kiosk" in line or "raspi-config" in line])
        self.assertNotIn("do_boot_behaviour", run.out[: run.out.index("Do you approve this plan?")])
        self.assertIn("--kiosk off", run.out)

    def test_ubuntu_pc_uses_dockers_ubuntu_commands_and_no_kiosk(self):
        self.ubuntu_pc()
        run = self.run_install(["y", "y", ""])
        self.assertEqual(run.code, 0, run.out + run.err)
        self.assertEqual(run.prompts, 3)
        self.assertIn(
            "sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc", run.log
        )
        self.assertFalse([line for line in run.log if "setup kiosk" in line])
        self.assertIn("kiosk-on-other-devices", run.out)
        self.assertIn("--kiosk off", run.out)

    def test_waits_until_household_setup_is_finished(self):
        self.doctor("configured", 1, setup=("fail", "open_hub"), read_guard=("fail", "open_hub"), **TRUSTED_LAN)
        run = self.run_install(["", "y", "y", "", "", "", "y"])
        self.assertEqual(run.code, 0, run.out + run.err)
        self.assertEqual(run.prompts, 7)
        self.assertIn("Setup is not finished yet", run.out)
        self.assertEqual(run.log.count("sproutwall doctor --json --phase configured --tier C"), 2)

    def test_kiosk_screen_not_found_can_be_skipped(self):
        run = self.run_install(["", "y", "y", "", "n"], FAKE_KIOSK_EXIT="4")
        self.assertEqual(run.code, 0, run.out + run.err)
        self.assertEqual(run.prompts, 5)
        self.assertIn("reconnect the one screen", run.out)
        self.assertNotIn("sudo raspi-config nonint do_boot_behaviour B4", run.log)
        self.assertIn("--kiosk off", run.out)

    def test_declined_autologin_is_not_run(self):
        run = self.run_install(["", "y", "y", "", "", "n"])
        self.assertEqual(run.code, 0, run.err)
        self.assertNotIn("sudo raspi-config nonint do_boot_behaviour B4", run.log)
        self.assertIn("sproutwall setup kiosk --check", run.log)


if __name__ == "__main__":
    unittest.main()
