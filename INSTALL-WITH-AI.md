<!--
MAINTAINER NOTE. Not part of the install. Assistants reading this file: skip this block.

1. Fill the published pair after each preview build. Open Actions, then "Preview image",
   then the run, then Summary. The job summary shows "Source commit" and "Image index
   digest". Replace every occurrence of the two placeholders in this file:
   - SOURCE_SHA in angle brackets: the full 40-character source commit.
   - INDEX_DIGEST in angle brackets: the multi-arch index digest, with its sha256: prefix.
   Leave the token published-index-digest-hex (in angle brackets, in step 4) as it is:
   it is the template token in docker-compose.preview.yml that the sed command in step 4
   replaces on the device. Never write a tag such as :preview in place of the digest.
   There are no release tags in stage 1.

2. Not yet verified on real hardware or live services [미확인]:
   - Anonymous GHCR access for verify-image: pull token, referrers, bundle blob and its one
     redirect; gh reading the image from the registry with no account (docs/install-cli.md,
     "Still to verify once the first preview image exists").
   - GitHub's apt repository serves arm64 gh 2.68.0 or newer on Raspberry Pi OS (Bookworm and Trixie).
   - verify-image passes against the real pair; the attested subject is the index digest;
     wrong signer, wrong commit and a tampered digest all fail.
   - The step 4 sed render of the digest, then doctor image_identity passing with that file.
   - Raspberry Pi Imager wording (customisation, key-only SSH) and that Imager keeps the
     public key's comment in authorized_keys. Step 8, tier B, removes the line by that
     comment; the fingerprint listing after it catches a miss.
   - Whether Raspberry Pi OS gives the first user sudo without a password. If it does,
     tier A relies on the assistant's rule never to run sudo.
   - sudo raspi-config nonint do_ssh 1 turns SSH fully off on current Raspberry Pi OS,
     including any socket activation, so doctor ssh_policy passes.
   - Tier A memory: the spec says an agent CLI on the device needs about 4 GB; confirm
     against the vendors' docs. Minimum RAM for the hub itself is not measured yet.
   - Agent removal (step 8, tier A) is not tested per CLI. The folder list comes from
     doctor's temporary_access check (scripts/sproutwall_lib/checks.py); the logout and
     uninstall commands are left to each vendor's own instructions.
   - The kiosk items in docs/install-cli.md, "Still to verify on real hardware".
   - Doctor's GET to the container address over Docker's bridge on the Pi.
   - The preview backup command in "Existing install / update" (stage 0.3 restore drill).
   - The supported-device list: Pi 4/5 are the intended tested path; the stage 1 hardware trials (T1, T2)
     have not run yet.
-->

# Install Sproutwall with an AI assistant

This guide puts Sproutwall on a Raspberry Pi (or another 64-bit Linux computer) and ends with the hub on your kitchen screen. An AI assistant can walk you through it, or you can follow the same steps by hand.

The hub needs no cloud account and no subscription. Nothing in this guide signs in to anything. The only GitHub tool used, `gh`, runs without an account.

**This guide installs one published preview:**

| | |
| --- | --- |
| Source commit | `<SOURCE_SHA>` |
| Image index digest | `<INDEX_DIGEST>` |

If those two values still show as `<SOURCE_SHA>` and `<INDEX_DIGEST>`, no preview has been published yet. Stop here and use the [manual install in the README](README.md#install-at-home) instead.

## Start here: what to tell your AI

Give your assistant this prompt:

> Read this repo and install it on the Raspberry Pi I bought, set up for our family. Ask me whatever you need.

A chat-only AI cannot open your Pi. Give it the repository address too, `https://github.com/thebrianlee/sproutwall`, or paste this guide into the chat.

## For the AI reading this

You are helping a parent install a home appliance. Follow these rules for the whole install.

1. **Questions.** Ask at most the [five decisions](#the-five-decisions), each once. Don't ask for model numbers, addresses or anything you can find out yourself. Work out the tier (decision 1) yourself when it is obvious: you run in a terminal on the device (A), you run on another computer with a shell (B), or you can only chat (C).
2. **Privileged commands.** Before the first `sudo`, show the [install plan](#the-install-plan-decision-3): every privileged command, why it is needed, what it changes and how to undo it. One approval covers that plan only. The person types every `sudo` command into the device's own Terminal. You never run `sudo`, even where it would work without a password. If anything needs a privileged change that is not in the plan, stop, explain it and note it. Don't fold it into the earlier approval. Never edit sudoers, and never add any account other than the person's own to the `docker` group.
3. **Secrets.** Never ask for, read, log or repeat a PIN, password, calendar link, token, API key or Wi-Fi password. The person types these only into the hub's own screen, into `sudo`'s prompt or into a tool's own sign-in page. While the person sets up the household and the PIN (step 6), pause: run nothing, read nothing and take no screenshots until they say they are done.
4. **Home network only.** Never expose the hub beyond the home network: no port forwarding, no tunnel, no public server. Never set `REQUIRE_AUTH_FOR_READS` to `0`. Never publish the Ask bridge port `8787`. Don't change the port binding.
5. **The image.** Start only the image that `verify-image` verified, and only after it exits 0. Never skip verification. Never pull or run the `:preview` tag. Never sign in to `gh` and never set a GitHub token. In this install, always run `docker compose` with `-f docker-compose.preview.yml`. The only change to the checkout is the one image line in step 4.
6. **What you see.** Ask for, and share, only `doctor --json` output (safe by design) and the short status each step names, such as an exit code, `healthy` or `Result: ok`. Never paste raw logs, config files, `docker inspect` output or screenshots of the hub.
7. **When to stop.** Stop on any doctor `fail`. Stop on any doctor `unknown`, with one exception: you may continue on exit 2 when the only unknown is `app_bind` with action `confirm_trusted_lan`, and the person confirmed the home-network rule in decision 3. Write that down as a known gap; it is not a clean pass. Also stop when `verify-image` exits non-zero or the health check is not `"ok":true`. Never work around a stop: no new volume, no other port, no disabled check.
8. **Data.** Never run `docker compose down -v` or `docker volume rm`, and never delete the `sproutwall` folder. The household lives in the Docker volume.
9. **Leave.** At the end, remove yourself as step 8 shows for your tier, and say that you did.

With a chat-only AI (tier C), give one block at a time and wait for its short result before the next.

## Supported devices

**Supported (the tested path):**

- Raspberry Pi 5 and Raspberry Pi 4, running Raspberry Pi OS (64-bit) with desktop. This is the path this guide describes, including the screen setup tool.
- amd64 mini PCs and laptops with a 64-bit Linux and Docker. The hub only: set up the screen by hand ([Kiosk on other devices](docs/raspberry-pi.md#kiosk-on-other-devices)).

**Should work, not tested yet:**

- Raspberry Pi 400 and 500, screens built on Compute Module 4 or 5, and other arm64 boards with a 64-bit Linux.

**Not supported:**

- Raspberry Pi 3 and older, any Raspberry Pi Zero, and any 32-bit operating system.

**Memory.** The minimum memory for the hub is not measured yet. Tier A runs the AI tool on the device itself, which needs more memory: plan for about 4 GB or more.

The hub itself runs on any 64-bit Linux with Docker. Only `setup kiosk` (step 7) is specific to Raspberry Pi OS with its standard desktop (labwc). On other devices, set up the screen by hand.

## The five decisions

These are the only questions the install asks.

1. **Who runs the commands?**
   - **A:** an AI tool runs in the device's own Terminal. SSH stays off.
   - **B:** an AI tool on your laptop connects to the device over SSH, with a temporary key, on your home network. The commands still run on the device.
   - **C:** a chat-only AI. You paste one block at a time into the device's Terminal and tell it only the short result. Nothing is installed for the AI.
2. **How does the screen hang?** Portrait is the default and the usual choice for a kitchen wall. You can also pick portrait turned the other way (`portrait-flipped`), `landscape`, `landscape-flipped`, or no kiosk (the hub then serves phones and tablets only). You don't need the screen's model number: the setup tool finds the one connected screen.
3. **Do you approve the install plan?** The AI shows the [whole plan](#the-install-plan-decision-3) once before anything needs your password. It also asks you to confirm the home-network rule below. Your yes covers that plan only.
4. **Your household.** On the hub's own screen, try it with the sample family (the Calders, a made-up family) or set up your own. You accept the device's time zone and choose the parent PIN yourself, privately. If you test a calendar, use a made-up one. The AI looks away during this step.
5. **Which features show?** One screen during setup. **Skip, use recommended** keeps everything except Ask the Hub. Ask the Hub stays off unless you turn it on, because it sends the questions kids type to the AI service you connect. You can change this later in Settings → Modules.

**The home-network rule.** You control this network (it is your own router), it is not a guest or public network, no router port is forwarded to this device, and no tunnel or remote-access service exposes it. Sproutwall is built for a trusted home network ([Keep it safe](README.md#keep-it-safe)).

### The install plan (decision 3)

You type each of these yourself in the device's Terminal; `sudo` asks for your password there. Steps 3, 7 and 8 show them in place.

| Command | Why | Undo |
| --- | --- | --- |
| `sudo apt update && sudo apt full-upgrade -y` | Bring the system up to date. | None needed (normal updates). |
| `sudo apt install -y git` | Download the code. | `sudo apt remove git` |
| Docker Engine and Compose from Docker's apt repository (step 3) | Runs the hub. | The Uninstall section of Docker's install page. Removing Docker's data folders also deletes the household. |
| `sudo usermod -aG docker $USER` | Lets your user run Docker and the checks without `sudo`. Membership in this group is equal to administrator rights. | `sudo gpasswd -d $USER docker` |
| GitHub CLI (`gh`) from GitHub's apt repository (step 3) | Checks the image's signature. No sign-in. | `sudo apt remove gh`, then delete `/etc/apt/sources.list.d/github-cli.list` and `/etc/apt/keyrings/githubcli-archive-keyring.gpg` |
| `sudo reboot` (after step 3) | The `docker` group takes effect. | |
| `sudo raspi-config nonint do_boot_behaviour B4` (step 7, only if `setup kiosk` prints it) | The desktop logs in by itself, so the screen comes back after a power cut. | `sudo raspi-config nonint do_boot_behaviour B3` |
| `sudo reboot` (steps 7 and 8) | Check that everything starts by itself. | |
| Tier B only: `sudo raspi-config nonint do_ssh 1` (step 8) | Turns the temporary SSH access off. | `sudo raspi-config nonint do_ssh 0` |

Other changes, without `sudo`:

- The `sproutwall` folder in your home folder, and the household's Docker volume. Keep both.
- The screen setup (step 7) writes a few files in your home folder. `./scripts/sproutwall setup kiosk --undo` puts them back ([Undo the kiosk](#undo-the-kiosk)).
- Temporary access, removed in step 8: tier A, the AI tool and its settings folders; tier B, the temporary SSH key at both ends and SSH itself; tier C, nothing on the device.

## Step 1: Put the system on the card

1. On another computer, install [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. **Tier B only, first:** on your laptop, make a temporary key. It asks for a passphrase; you may leave it empty, because the key is deleted at the end.

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/sproutwall-install -C sproutwall-install
   cat ~/.ssh/sproutwall-install.pub
   ```

3. In Imager, choose your Pi model, then **Raspberry Pi OS (64-bit)** with the desktop, then the card. Check that it is the card and not another drive: everything on it is erased.
4. When Imager offers to customise the system, set:
   - **Hostname:** `hub`
   - **Username and password.** Keep the password to yourself.
   - **Time zone** and **keyboard layout**
   - **Wi-Fi** country, name and password, unless you use a network cable
   - **SSH:** off for tiers A and C. Tier B: on, with public-key authentication only, and paste the one line that `cat` printed above.
5. Let Imager write and verify the card, then eject it.
6. With the Pi switched off, connect the screen and its touch connection following the screen's own instructions. Insert the card and switch on. The first start takes a few minutes.

**Other devices:** install a 64-bit Linux with its own installer, with SSH off unless you use tier B.

## Step 2: Open the session

**Tier A.** On the Pi's desktop, open **Terminal**. Install the AI tool with its maker's official instructions and sign in on its own sign-in page. This tool is for the install only; step 8 removes it. Then give it the prompt from [Start here](#start-here-what-to-tell-your-ai).

**Tier B.** First, on the Pi's own desktop Terminal, show the Pi's fingerprint:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Then, on your laptop, connect. Use your username in place of `<user>`:

```bash
ssh -i ~/.ssh/sproutwall-install -o IdentitiesOnly=yes -o ForwardAgent=no <user>@hub.local
```

Answer `yes` only if the `ED25519 key fingerprint` it shows is exactly the one the Pi printed. The AI on your laptop uses the same `ssh` options for every command, with no agent forwarding.

**Tier C.** On the Pi's desktop, open **Terminal**. Open your chat AI in the Pi's web browser, so you can copy each block into the Terminal.

**All tiers.** Check that this is a 64-bit system:

```bash
test "$(dpkg --print-architecture)" = arm64 && test "$(uname -m)" = aarch64 && echo "64-bit OK"
tr -d '\0' </proc/device-tree/model; echo
```

It must print `64-bit OK` and a model that starts with `Raspberry Pi 4` or `Raspberry Pi 5`. A Pi 400, 500 or Compute Module is untested. On an amd64 computer, check `amd64` and `x86_64` instead, and skip the model line.

## Step 3: Install the tools and get the code

You run these `sudo` commands yourself, as approved in decision 3. Tier A: open a second Terminal window for them.

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git
```

**Docker.** Install Docker Engine and Compose from Docker's own apt repository, as described in [Step 3 of the Pi guide](docs/raspberry-pi.md#step-3-install-docker). 64-bit Raspberry Pi OS uses Docker's [Debian instructions](https://docs.docker.com/engine/install/debian/), "Install using the `apt` repository". Don't use Docker's convenience script. On another Linux, use Docker's page for your distribution. Then:

```bash
sudo usermod -aG docker $USER
```

**GitHub CLI (`gh`).** The image check needs `gh` 2.68.0 or newer. Debian's and Raspberry Pi OS's own `gh` packages are too old, so install it from GitHub's own apt repository. GitHub's Linux install page is linked from <https://cli.github.com>, and the steps are in [install_linux.md](https://github.com/cli/cli/blob/trunk/docs/install_linux.md), section Debian. Check the current instructions there. At the time of writing they are:

```bash
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && sudo mkdir -p -m 755 /etc/apt/sources.list.d \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install gh -y
```

Don't run `gh auth login`. The check needs no account.

Restart so the `docker` group takes effect:

```bash
sudo reboot
```

After the restart, open the Terminal again. Tier A: start the AI tool again and say "Continue the Sproutwall install at step 3, the checks." Tier B: connect with the same `ssh` command.

**Check the tools:**

```bash
python3 --version
docker compose version
docker info >/dev/null && echo "Docker OK"
gh --version
gh attestation verify --help >/dev/null && echo "gh attestation OK"
```

You need Python 3.11 or newer, Docker Compose v2 or newer, `Docker OK`, `gh` 2.68.0 or newer and `gh attestation OK`.

**Check for an existing hub.** This must print nothing:

```bash
ls -d ~/sproutwall ~/family-hub 2>/dev/null; docker volume ls -q | grep familyhub-data
```

If it prints anything, this device already has a hub. Stop and read [Existing install / update](#existing-install--update).

**Get the code at the published commit:**

```bash
cd ~
git clone https://github.com/thebrianlee/sproutwall.git sproutwall
cd ~/sproutwall
git checkout --detach <SOURCE_SHA>
test "$(git remote get-url origin)" = "https://github.com/thebrianlee/sproutwall.git" && test "$(git rev-parse HEAD)" = "<SOURCE_SHA>" && echo "Source OK"
```

It must print `Source OK`. Don't run anything from the checkout until it does.

## Step 4: Check the image before starting it

The code at this commit holds a template in place of the image digest, because a commit cannot contain the digest of the image built from it. This writes the published digest into that one line:

```bash
cd ~/sproutwall
sed -i 's|@sha256:<published-index-digest-hex>"|@<INDEX_DIGEST>"|' docker-compose.preview.yml
git status --short
```

`git status --short` must list one line only: `M docker-compose.preview.yml`.

Now check the image. Run it from this folder, the checkout's top folder:

```bash
./scripts/sproutwall verify-image --source-sha <SOURCE_SHA> --digest <INDEX_DIGEST>
echo "exit $?"
```

It reads the image that `docker-compose.preview.yml` would start, confirms it is the published digest, downloads the image's signed build record (attestation) without an account, and has `gh` check that GitHub built it from the published commit with this repository's workflow. It starts nothing.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Verified. It prints the digest, the workflow, the commit and the start command. | Go to step 5. |
| 1 | Not verified: the signature check failed or timed out. | Stop. Don't start the hub. |
| 2 | Refused before checking: wrong folder, a mistyped value, or the compose file does not match the published digest. | Check that you are in `~/sproutwall` and copied both values exactly. |
| 3 | `gh` is missing or older than 2.68.0. | Install `gh` from GitHub's repository (step 3). |
| 4 | The signed build record could not be downloaded, or failed its own checks. | Check the internet connection, wait, run it again. |
| 5 | Its temporary files could not be removed. The image counts as not verified. | Delete the `sproutwall-verify-*` folders in the system's temporary folder (usually `/tmp`), then run it again. |

**Nothing may start unless this exits 0.**

## Step 5: Start the hub and claim it right away

Until first-run setup is done, anyone on your network who opens the hub could choose the PIN. So do step 6 straight after this one.

First, check the home-network rule once more on the device:

```bash
hostname -I
```

Every address with dots must start with `192.168.`, `10.`, or `172.16.` to `172.31.`. If any other address shows, stop: the device may be reachable from outside your home.

Start the verified image and check it:

```bash
cd ~/sproutwall
docker compose -f docker-compose.preview.yml up -d --wait
docker compose -f docker-compose.preview.yml ps
curl -fsS --max-time 3 http://127.0.0.1:3847/api/health
```

- `ps` must show the hub as `healthy`.
- The health check must print one line with `"ok":true`. It also shows `version` and `schema`, and `"setup":false` until step 6.
- If `curl` reports error `503` instead, the database is blocked. Stop. Don't start over with a new volume. The hub's own message is in `docker compose -f docker-compose.preview.yml logs`: read it yourself, don't paste it into a chat.

Then run the first check. Put your tier letter after `--tier` (A, B or C; C also when you work without AI):

```bash
./scripts/sproutwall doctor --json --phase running --tier A
```

On a home network the expected result is `"result":"unknown"` (exit 2) with one unknown check, `app_bind` with the action `confirm_trusted_lan`: the device cannot see your router, so it asks you to confirm the home-network rule. Continue only if that is the only unknown and you confirmed the rule in decision 3. Anything else: see [If something goes wrong](#if-something-goes-wrong).

## Step 6: Set up the household, then check

**The AI pauses now.** On the Pi's own screen, open the web browser at `http://localhost:3847`. You see **Set up the house**:

1. **Your family** (decision 4): **Try it with the sample family**, or **Set up my family**.
2. **What should your wall show?** (decision 5): choose, or tap **Skip, use recommended**.
3. **The house:** names, the time zone (filled in from this device; keep it), the location for the weather, and the **Parent PIN**, typed twice.
4. Tap **Open the wall**.

The [README](README.md#first-run-setup) explains each field and the PIN rules. When you are done, tell the AI only "done".

Check it, with your tier letter as before:

```bash
cd ~/sproutwall
./scripts/sproutwall doctor --json --phase configured --tier A
```

Same rule as before: exit 0, or exit 2 with only `app_bind` / `confirm_trusted_lan`.

**Phone check.** Run `hostname -I` and take the first address, for example `192.168.1.50`. On a phone on the same Wi-Fi, open `http://192.168.1.50:3847` (with your address). It must show **Unlock this screen** and ask for the PIN. It must not show the family. If it shows the family without asking, stop. If the phone cannot reach it, see [A phone or tablet can't reach the hub](docs/raspberry-pi.md#a-phone-or-tablet-cant-reach-the-hub). Never forward a port, publish the bridge or turn the lock off to make the phone work.

## Step 7: Set up the screen

Skip this step if you chose no kiosk in decision 2, or on a device other than a Raspberry Pi (set the screen up [by hand](docs/raspberry-pi.md#kiosk-on-other-devices) instead).

Run it as yourself, without `sudo`, while you are logged in to the Pi's desktop:

```bash
cd ~/sproutwall
./scripts/sproutwall setup kiosk
```

That turns the screen to portrait. For decision 2's other choices, add one of `--orientation portrait-flipped`, `--orientation landscape` or `--orientation landscape-flipped`.

1. **Tap the four corners and the centre of the screen.** Each tap must land under your finger. A turned picture alone does not prove that touch is right.
2. If it printed an autologin command, run it yourself (it is in the approved plan):

   ```bash
   sudo raspi-config nonint do_boot_behaviour B4
   ```

3. Check the result. The last line must be `Result: ok (exit 0)`:

   ```bash
   ./scripts/sproutwall setup kiosk --check
   ```

4. Restart with `sudo reboot`, then check by hand:
   - One full-screen hub opens by itself, the right way up. It asks once for the parent PIN to unlock this screen: type it yourself.
   - Tap the four corners and the centre again.
   - Leave it untouched for longer than the desktop's old screen-blanking time (15 minutes if you don't know it). The screen stays lit. The hub's own screensaver, with photos or quotes, is fine.
   - The phone still reaches the locked hub.

If `setup kiosk` stops, it prints one line saying why. Exit 1 after setup means the settings apply at the next login: restart, then run `--check`. Exit 4 usually means the screen or its touch connection was not found, or several were: reconnect the one screen, unplug any other, wait ten seconds and run it again. For any other stop, nothing was changed unless the message says so. Set the screen up [by hand](docs/raspberry-pi.md#set-it-up-by-hand), or choose no kiosk. The hub keeps working either way. [docs/install-cli.md](docs/install-cli.md#setup-kiosk-the-pis-own-touch-screen) lists every exit code.

## Step 8: Remove the assistant and check once more

The AI's last job is to show you this step for your tier. Then it ends its session, and you run the rest yourself.

**Tier A.** In the Pi's Terminal:

1. In the AI tool, use its own logout command, then quit it.
2. Uninstall it the way its maker's instructions say (the same way it was installed).
3. Delete its settings folders, which also hold its sign-in. Run only the one for the tool you used:
   - Claude Code: `rm -rf ~/.claude ~/.claude.json`
   - Codex CLI: `rm -rf ~/.codex`
   - Gemini CLI: `rm -rf ~/.gemini`

The final check below looks for these tools, their folders and any autostart entry for them, and fails if one is left.

**Tier B.**

1. On the laptop, close the AI session and every SSH session to the Pi. Then show the temporary key's fingerprint, and keep it on screen:

   ```bash
   ssh-keygen -lf ~/.ssh/sproutwall-install.pub
   ```

2. On the Pi's own desktop Terminal, remove the temporary key, list the keys still allowed, and turn SSH off:

   ```bash
   sed -i '/ sproutwall-install$/d' ~/.ssh/authorized_keys
   ssh-keygen -lf ~/.ssh/authorized_keys
   sudo raspi-config nonint do_ssh 1
   ```

   The laptop's fingerprint must not be in the list. If no keys are left, `ssh-keygen` says the file is not a public key file; that is fine. If the fingerprint is still listed, open the file with `nano ~/.ssh/authorized_keys` and delete that key's line. Other keys stay. On another Linux, turn SSH off with `sudo systemctl disable --now ssh`.
3. On the laptop, confirm the old key no longer gets in. This must fail:

   ```bash
   ssh -o BatchMode=yes -o ConnectTimeout=5 -i ~/.ssh/sproutwall-install -o IdentitiesOnly=yes <user>@hub.local true
   ```

4. Then delete the key on the laptop:

   ```bash
   rm ~/.ssh/sproutwall-install ~/.ssh/sproutwall-install.pub
   ```

**Tier C.** Nothing was installed for the AI. You may paste the final check's output into the chat, then close the chat.

**The final check, all tiers.** In the Pi's own Terminal, with your tier letter. Use `--kiosk off` instead of `--kiosk on` if you chose no kiosk or set the screen up by hand:

```bash
cd ~/sproutwall
./scripts/sproutwall doctor --json --phase final --tier A --kiosk on
```

It passes with `"result":"pass"` (exit 0), or with `"result":"unknown"` (exit 2) when the only unknown is `app_bind` / `confirm_trusted_lan`. Without `--json` it prints the same result as readable text, ending with `Result:`.

Finally, restart with `sudo reboot`. The hub must come back on the screen by itself, with no assistant. You are done. Keep the `sproutwall` folder: it is the hub's folder.

## If something goes wrong

Each doctor check that is not `pass` names one action:

| Action | What it means | What to do |
| --- | --- | --- |
| `use_supported_os` | Not a 64-bit Linux the image supports. | Put a 64-bit system on the card ([Supported devices](#supported-devices)). |
| `verify_release` | The running image is not the verified preview. | `docker compose -f docker-compose.preview.yml stop`, repeat step 4, start again only after exit 0. |
| `restore_storage` | The data volume or database is not as expected. | Don't start a new volume and don't delete anything. Use the README's [backup and restore](README.md#back-up-and-update), or get help. |
| `restrict_ports` | A port is reachable beyond the home network. | Stop the hub now with `docker compose -f docker-compose.preview.yml stop`. Check the router for port forwards and tunnels. Get help. Don't change the port or turn the check off. |
| `confirm_trusted_lan` | The hub is on your home network, and the device cannot prove the router forwards nothing. | Expected. Continue only if it is the only unknown and you confirmed the home-network rule in decision 3. |
| `review_ssh` | SSH is on, or it allows passwords. | Stop. Tiers A and C expect SSH off; tier B, key-only until step 8, then off. Turning SSH off (`sudo raspi-config nonint do_ssh 1`) is a privileged change outside the approved plan for A and C, so it needs your own new decision. |
| `open_hub` | First-run setup is not finished. | Open the hub on the Pi and finish setup (step 6). |
| `repair_kiosk` | The screen launcher is not in the state you chose. | `./scripts/sproutwall setup kiosk --check`, then `setup kiosk` (on) or `setup kiosk --off`. Check that `--kiosk` matches your choice. |
| `remove_agent` | The AI tool, its folders or autostart entry, or an SSH session is still there. | Repeat step 8 for your tier, and close every SSH session. |
| `retry_local` | The check could not finish. | Wait a minute and run it again in the Pi's own Terminal, as your user. If it repeats, stop and get help. Don't work around it. |

To get help, open an issue in the repository with the `doctor --json` output only: no logs, names or links. Report security problems privately as [SECURITY.md](SECURITY.md) says.

## Existing install / update

**This device already runs Sproutwall (or Family Hub).** Don't use this guide on it, and never start a second, fresh Compose project next to it: a new project starts with an empty household. Keep the existing folder and its data volume. Back up, then update in place, as the README's [Back up and update](README.md#back-up-and-update) and [Installed before the rename](README.md#installed-before-the-rename) describe.

**Updating a hub installed with this guide.** A step-by-step update to a newer preview is not written yet. Don't run the README's update command in this folder: it builds locally from a different compose file. Keep the folder and the volume, and back up regularly. The README's backup, with this install's compose file:

```bash
cd ~/sproutwall
docker compose -f docker-compose.preview.yml stop
docker compose -f docker-compose.preview.yml run --rm -T --entrypoint tar family-hub czf - -C / data photos > sproutwall-backup.tgz
docker compose -f docker-compose.preview.yml start
```

Copy `sproutwall-backup.tgz` off the device, for example to a USB stick, and keep it private: it holds the household and the hub's secret keys.

## Undo the kiosk

In `~/sproutwall`, on the Pi's desktop:

- **Pause it:** `./scripts/sproutwall setup kiosk --off` closes the kiosk browser and stops it starting at login. The hub keeps running and phones still reach it. Turn it back on with `./scripts/sproutwall setup kiosk`.
- **Remove it:** `./scripts/sproutwall setup kiosk --undo` puts back every file as it was before setup. If autologin was off before, it prints the command that turns it off again: `sudo raspi-config nonint do_boot_behaviour B3`.

If `--undo` refuses because a file was changed after setup (for example in Control Centre), follow [Remove the kiosk by hand](docs/raspberry-pi.md#remove-the-kiosk-by-hand). The hub and its data are not touched either way.

## Without AI

Everything above works by hand. Make the five decisions yourself, skip the tier A and B parts, and run each block in order in the Pi's own Terminal. Use `--tier C` in the doctor commands. The rules in [For the AI reading this](#for-the-ai-reading-this) are good rules for you too: stop where they say stop.

For a hub that builds on the device instead of using the published image, see the [Raspberry Pi guide](docs/raspberry-pi.md).
