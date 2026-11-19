# The install helper: `scripts/sproutwall`

`scripts/sproutwall` is a small Python 3 tool for the guided install. It needs Python 3.11 or newer and uses only the standard library: no pip packages and no Node on the host. It runs system tools (Docker, `ip`, `systemctl`, `dpkg`, `gh`, `wlr-randr`) with fixed argument lists, never through a shell, and never uses `sudo`. It sends no telemetry.

Run it from the hub's folder:

```bash
./scripts/sproutwall doctor --phase running
./scripts/sproutwall verify-image --source-sha <commit>
./scripts/sproutwall setup kiosk
```

## `doctor`: read-only checks

```text
sproutwall doctor [--json] --phase running|configured|final [--tier A|B|C] [--kiosk on|off]
```

- `--phase`: `running` after the hub starts, `configured` after first-run setup, `final` after the assistant is removed.
- `--tier`: who operated the terminal. A (agent on the Pi) and C (chat only) expect SSH off. B (laptop agent over SSH) allows temporary key-only SSH on the home network until the final phase. Default: A.
- `--kiosk`: the screen choice from the install (decision 2). Default: on.

Doctor only reads. It changes nothing on the Pi or in the hub. It sends the hub `GET` requests only, and only to the hub container itself:

- One `docker inspect` of the preview project's single hub container, by its full id, reads its id, Docker's health state, its network mode and its network addresses, and nothing else.
- The container must be `running` and `healthy`. Its own healthcheck has then already opened the database, so a request from doctor is never the one that creates, migrates or seeds it.
- Doctor sends its requests to that container's own bridge address (`http://<container address>:3847`), never to `127.0.0.1`, so the answer comes from the container whose health it read and not from some other program on port 3847. There must be exactly one address, and it must be private (RFC 1918 or `fc00::/7`).
- Otherwise `health`, `setup` and `read_guard` are `unknown` with `retry_local`, and no request is sent at all. That covers a container that is starting, unhealthy or missing; host networking; no address or several; and an address that does not answer. There is no second try at another address. Rootless Docker, where the host cannot reach container addresses, therefore gets `unknown`.
- The container address is never printed. A blocked database also makes the container unhealthy, so it shows up here as `unknown`; `docker compose -f docker-compose.preview.yml logs` says why.

### Checks

Each check reports `pass`, `fail`, `unknown` or `not_applicable`, and one action. They always appear in this order:

| Check | Passes when |
| --- | --- |
| `platform` | 64-bit Linux the image is built for (see below). |
| `docker` | Docker Compose v2 or newer is installed and this user can reach the Docker daemon. |
| `image_identity` | The hub's container runs the image Compose would start from `docker-compose.preview.yml` (see [verify-image](#verify-image-check-the-image-before-starting-it)), for this computer's architecture. A tag is never trusted. |
| `storage` | `/data` is the named `familyhub-data` volume, `/photos` is mounted, and the app user can write `/data` and the database (`sproutwall.db`, or `family-hub.db` from before the rename). |
| `health` | Docker reports the container healthy, and then `GET /api/health` at the container's own address answers HTTP 200 with JSON `ok: true`. Redirects are not followed. |
| `app_bind` | Port 3847 is reachable only on loopback. See [Exposure](#exposure). |
| `bridge_bind` | The Ask bridge port 8787 is not published and listens only on loopback inside the container. Both address families must be read; a missing IPv6 table counts only when IPv6 is off in the container. |
| `ssh_policy` | SSH is off, or (tier B, before `final`) it is key-only and not listening on a public address. See below. |
| `setup` | `/api/health` reports `setup: true` (first-run setup is finished). From `configured`. |
| `read_guard` | An anonymous `GET /api/modules` (no cookie) is refused with 401. From `configured`. |
| `kiosk` | The kiosk launcher matches `--kiosk`. From `final`. |
| `temporary_access` | No installation-only assistant CLI, its credentials or autostart entry is left in the home folder, and no SSH session into the Pi is open. A location that cannot be checked makes it `unknown`, but anything found still fails. From `final`. |

`not_applicable` is used only for the phase omissions marked "From" above.

**`platform`.** It accepts any 64-bit Linux that the image supports: the kernel is `aarch64` or `x86_64`, and the userland is 64-bit too (`dpkg --print-architecture` says `arm64` or `amd64`; on systems without dpkg, how Python was built). A Raspberry Pi 4, 5, 400, 500 or Compute Module 4/5 with 64-bit Raspberry Pi OS passes, as do other arm64 boards and amd64 mini PCs. A 32-bit OS or CPU (`armv7l`, `armv6l`, `i686`, or an `armhf`/`i386` userland on a 64-bit kernel) and non-Linux systems fail with `use_supported_os`. The device model is never read or printed.

**`setup`.** The health answer carries one boolean, `setup`, from the hub's `setup_complete` setting. On the success path that is one extra read-only settings lookup; the blocked 503 answer is unchanged and reads nothing more. It tells an anonymous visitor nothing new: the setup screen, and `/api/setup` answering 409 once setup is done, already show it. `setup: false` fails with `open_hub`; no answer, or an image from before the field existed, is `unknown`.

**`ssh_policy`.** SSH counts as on if `ssh.service`, `sshd.service`, `ssh.socket` or `sshd.socket` is enabled or active, or if anything listens on port 22 or on a `Port` named in the SSH server config. Any `PasswordAuthentication yes` or `KbdInteractiveAuthentication yes`, also inside a `Match` block, means not key-only, as do `PermitRootLogin yes`, empty passwords and password methods in `AuthenticationMethods`. `Include` paths may be quoted, as sshd allows. Only a path that does not exist is skipped, as sshd skips it (also when its folder does not exist). Wildcards are matched against a folder listing that reports its errors (an I/O error or a permission change is never read as "no matches"), sorted, and, as sshd's glob does, a name starting with `.` matches only a pattern starting with `.`. Any other problem makes the result `unknown` (`review_ssh`), because a port or password rule could hide there: a config file or included file that cannot be read, a folder that cannot be entered or that an `Include` wildcard cannot list, a path part that is a file, or an included path that is a folder. Each path is checked with a lookup that says why it failed, so "permission denied" is never mistaken for "not there".

**`kiosk` marker.** [`setup kiosk`](#setup-kiosk-the-pis-own-touch-screen) adds exactly one launcher line to `~/.config/labwc/autostart`, ending with the comment `# sproutwall:kiosk-launcher`; `setup kiosk --off` turns it into a comment. Doctor counts the lines with that marker that are not commented out: one when `--kiosk on`, none when `--kiosk off`.

### Exposure

Doctor reads the listening sockets (`/proc/net/tcp` and `/proc/net/tcp6`), every interface address (`ip -j addr show`, IPv4 and IPv6) and the container's published ports. Loopback is local; `10/8`, `172.16/12`, `192.168/16`, link-local and `fc00::/7` are the home network; every other address, including a global IPv6 address, is public. A wildcard bind (`0.0.0.0`, `::`) counts on every interface.

- Public exposure fails with `restrict_ports`, even if part of the inspection failed: socket tables are read line by line, and what was already read is kept when a later line or file cannot be read. That only makes the result incomplete.
- A socket table row counts only if its addresses have the table's length (8 hex digits in `tcp`, 32 in `tcp6`), each port is exactly 4 hex digits, and its state is one of the kernel's 11 TCP states (`01` to `0B`). Any other row makes that table incomplete. This applies to the host's tables and to the container's tables that `bridge_bind` reads.
- A home-network publication, such as the default `3847:3847`, is `unknown` with `confirm_trusted_lan`. Local checks cannot prove that the router forwards nothing, that no tunnel exists or that everyone on the network is trusted, so this is never reported as safe.
- If any part of the inspection did not complete, the result is `unknown` with `retry_local`.

**Why the preview publishes IPv4 only.** Many home networks give the computer a global IPv6 address as well as a private IPv4 one, and the global address can be reachable from the internet. A plain `3847:3847` publication also listens on IPv6 (`::`), so doctor fails it on such a network. `docker-compose.preview.yml` therefore publishes `0.0.0.0:3847:3847`: Docker then creates no IPv6 listener, phones on the home Wi-Fi reach the hub over IPv4, and a dual-stack network gets `unknown` with `confirm_trusted_lan` as long as the computer's IPv4 addresses are private. (`docker-compose.yml`, which builds locally, keeps `3847:3847` for existing installs; on a dual-stack network bind it to the LAN IPv4 address, README "Limit who can connect".)

If `app_bind` still fails with the preview, some interface has a public IPv4 address, or another program publishes the port. Stop there and ask for help. Do not change the port or turn the check off to get past it.

### Output and exit codes

With `--json` anywhere on the command line, stdout is exactly one JSON object on every path. Help, usage errors and crashes print the fixed object with `result` `unknown` and every check `unknown` / `retry_local`, and exit 2:

```json
{"schema":1,"phase":"running","result":"unknown","checks":[{"id":"platform","status":"pass","action":"none"}, "..."]}
```

| Exit | Result | Meaning |
| --- | --- | --- |
| 0 | `pass` | Every applicable check passed. |
| 1 | `fail` | At least one check failed. |
| 2 | `unknown` | No failure, but at least one applicable check is unknown. A usage error also exits 2. |

**Trials T1 and T2.** Continue on exit 2 only when the only unknown is `app_bind` with `confirm_trusted_lan` (inspection completed and found no public exposure) and the operator affirmed the trusted-network prerequisite in decision 3. Record that residual unknown; it is not a clean pass. Any other unknown or any failure stops.

### Redaction

`scripts/sproutwall` is a small bootstrap that sets this up before anything else runs: it turns off warnings and bytecode files, installs handlers for uncaught exceptions in the main thread and in other threads, and runs every import and the whole command inside one guard. If anything fails, even importing the tool's own code, a `--json` run prints the fixed object above (exit 2) and any other run prints one fixed line to stderr. Never a traceback or a path.

The JSON is built only from the fixed check ids, the status and action names and the schema number, and is checked against the closed schema before it is printed. Doctor never prints command output or error text, file contents, paths, names, addresses, URLs, tokens, PINs, cookies, environment values or exception messages. Container details are read with a format that requests only the fields doctor needs, so the container's environment never reaches doctor at all. Without `--json`, doctor prints fixed text for each action. The unit tests seed fictional names, an iCal URL with a token, a PIN, an API key and a cookie into every input, on success and failure paths, and check that none of them appears on stdout or stderr.

## `verify-image`: check the image before starting it

```text
sproutwall verify-image --source-sha <40-hex commit> [--digest sha256:<64-hex>] [--bundle FILE] [--trusted-root FILE]
```

Run it from the top folder of the checkout; anywhere else it refuses (exit 2) with "Run this from the top folder of the Sproutwall checkout." That way the start command it prints, which names the compose file relative to the current folder, is always the file it checked, and it never prints an absolute path.

It takes the digest of the image that `docker compose -f docker-compose.preview.yml up` would start, and checks that GitHub's build attestation for that digest was signed by `.github/workflows/image.yml` in `thebrianlee/sproutwall`, built from the published commit `--source-sha`. It starts nothing. On success it prints the start command, `docker compose -f docker-compose.preview.yml up -d --wait`, for exactly the file it checked.

1. Refuses a placeholder digest, a tag-only reference (such as `:preview`), another repository, a SHA that is not exactly 40 lowercase hex characters (nothing before or after, not even a newline), and a `--digest` that differs from the compose file. The committed `docker-compose.preview.yml` holds a placeholder until the first preview is published, so it is always refused, and Docker rejects it too.
2. Reads the image two ways, and both must agree: the file's one literal `image:` line (a line with a variable, `$`, is refused), and the effective configuration from `docker compose -f docker-compose.preview.yml --profile "*" config --format json`, which applies interpolation, includes and extends. That configuration must have exactly one service, `family-hub`, counting every profile, with no `build`, and an image `ghcr.io/thebrianlee/sproutwall[:tag]@sha256:<64 hex>`. `COMPOSE_FILE` and `COMPOSE_PROFILES` are removed from Docker's environment, so only this file is read; the start command passes the same `-f`, which Compose prefers over `COMPOSE_FILE`. Without Docker Compose it refuses.
3. Requires `gh` 2.68.0 or newer (the first with `--source-digest`). Debian's own `gh` packages are older; install `gh` from GitHub's package repository.
4. Downloads the attestation bundle with no account: an anonymous pull token from `ghcr.io`, the OCI referrers of the digest, then each Sigstore bundle. Only HTTPS, with timeouts, size limits and a sha256 check of every manifest and bundle. Redirects are never followed, with one exception: a bundle download may take exactly one hop to `https://pkg-containers.githubusercontent.com`, where GHCR serves blobs from signed links. That request carries no authorization header and may not redirect again; the sha256 check of the bytes is what makes it safe. The bundle is written to a private temporary file (mode 0600) that is deleted afterwards.
5. Runs, with a fresh empty `GH_CONFIG_DIR` and without `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` or `GH_HOST`, so the result never depends on a login:

   ```bash
   gh attestation verify "oci://ghcr.io/thebrianlee/sproutwall@$DIGEST" -R thebrianlee/sproutwall \
     --signer-workflow thebrianlee/sproutwall/.github/workflows/image.yml \
     --source-digest "$SOURCE_SHA" --bundle <temporary file>
   ```

- `--bundle FILE` uses a bundle obtained another way and skips the download. A bundle proves nothing by itself; gh checks it.
- `--trusted-root FILE` passes `--custom-trusted-root FILE`, for a Pi that cannot reach Sigstore. This file decides which signatures are trusted: make it with `gh attestation trusted-root` on a computer you control, and never take it from the same place as the bundle.

| Exit | Meaning |
| --- | --- |
| 0 | Verified. It prints the digest, the signer workflow and the commit, then the start command. |
| 1 | Not verified: gh refused the attestation, or timed out. |
| 2 | Refused before checking: not run from the checkout's top folder, bad arguments, the compose file, or no Docker Compose to read it. |
| 3 | `gh` is missing or older than 2.68.0. |
| 4 | The attestation bundle could not be downloaded, or failed its digest or size checks. |
| 5 | Its temporary files could not be removed. This wins in every case, even over a successful check or an unexpected error, and the image counts as not verified: remove the `sproutwall-verify-*` folders in the system's temporary folder, then run it again. |

Messages are fixed text. gh's own output is never printed.

### Still to verify once the first preview image exists

The sandbox that wrote this could not reach GHCR, Sigstore or GitHub's package repository. A maintainer runs these on a clean 64-bit Raspberry Pi OS with no `~/.config/gh` and no `GH_TOKEN`:

1. Anonymous GHCR access: the pull token, the referrers list (or the `sha256-<hex>` tag fallback) and the bundle blob are served without an account.
2. [미확인] (unverified): GHCR answers the blob request with a single redirect to `pkg-containers.githubusercontent.com` (`BLOB_REDIRECT_HOST` in `scripts/sproutwall_lib/attestation.py`), and the signed link there needs no further redirect.
3. With an `oci://` subject, gh also reads the image from the registry: check that this works anonymously.
4. GitHub's apt repository has arm64 packages, and `gh --version` there is 2.68.0 or newer.
5. The attested subject is the multi-arch index digest that `docker-compose.preview.yml` pins.
6. `verify-image` passes against the real pair, then once more with `--trusted-root` and no network.
7. Negative tests fail with a non-zero exit: wrong signer workflow, wrong `--source-sha`, a tampered digest.
8. [미확인] (unverified) on the Pi: Docker's bridge routes from the host to the container address, so doctor's `GET` to `http://<container address>:3847/api/health` answers. Rootless Docker is expected to give `unknown` instead.
9. On a dual-stack network, `0.0.0.0:3847:3847` creates no IPv6 listener (`ss -ltn` shows no `[::]:3847`) and doctor reports `app_bind` as `unknown` / `confirm_trusted_lan`.

## `setup kiosk`: the Pi's own touch screen

```text
sproutwall setup kiosk [--orientation portrait|portrait-flipped|landscape|landscape-flipped]
sproutwall setup kiosk --check [--json]
sproutwall setup kiosk --off
sproutwall setup kiosk --undo
```

It shows the hub full screen on the Pi's own screen, turned the way the screen hangs, with touch mapped to that screen. Run it as the desktop user (not with `sudo`), while that user is logged in to the Pi's desktop: from the desktop's Terminal, or from an SSH login of the same user. It finds the desktop session from the process table, not from the SSH login's environment.

### The one supported path

The hub runs on any 64-bit Linux, but this tool supports exactly one setup:

**Raspberry Pi OS 64-bit with the desktop → the Wayland desktop (labwc) → exactly one connected HDMI or DSI screen → one touch input → Chromium.**

Before it changes anything it checks, in this order, and stops at the first that fails:

1. Not running as root.
2. A Raspberry Pi running 64-bit Raspberry Pi OS (`aarch64` kernel, `arm64` userland, `/etc/rpi-issue`, a `Raspberry Pi` device-tree model, which is never printed).
3. This user's labwc session as Raspberry Pi OS starts it: one `labwc` process with `-m` (merged configuration, so the user's files add to the system defaults instead of replacing them), and a `kanshi` started by that labwc. Both must read the default places: no `-c`/`-C`/`--config`/`--config-dir` option on labwc, no `-c`/`--config` on kanshi, `XDG_CONFIG_HOME` unset or exactly `~/.config`, and `HOME` this home folder, in the environments of both (read from `/proc`; an unreadable environment means it cannot tell). Otherwise the files this tool writes would not be read, so it refuses. X11, Wayfire and images without the desktop (Lite) are refused; the tool never configures them.
4. Chromium is installed (`/usr/bin/chromium`, or `/usr/bin/chromium-browser` on older images).
5. No managed file, and no folder on the way to one, is a link. The state folder and the launcher belong to this tool: if either exists without the record this tool writes, it refuses (see below). No other `setup kiosk` run holds the lock, and no managed file was changed since the last setup.
6. No system-wide screen blanking in `/etc/xdg/labwc/autostart` (the tool only changes the user's own files).
7. Exactly one connected screen, on HDMI or DSI. `wlr-randr --json` is asked first; older `wlr-randr` without `--json` is read in its plain format. Every output it lists counts, including a virtual one (`NOOP-1`), because kanshi applies a profile only when the connected outputs match it exactly. A screen that is connected but switched off counts as none.
8. Exactly one touch input (see below), and a panel mode that is known for certain: its one preferred mode, or else its one current mode. If neither is certain, it cannot tell (no landscape panel is assumed).
9. labwc autostart does not already start Chromium (a kiosk line added by hand), and labwc `rc.xml` can be merged safely.

Everything else stops with fixed text, changes nothing, and points to the manual steps in [raspberry-pi.md](raspberry-pi.md#step-6-show-the-hub-full-screen-on-the-pis-own-screen-optional). Zero or several screens give one fixed hint: reconnect or switch on the screen you want, unplug any other screen, wait ten seconds, run it again.

**An error is never read as "missing" or "off".** Only "no such file" (or a process that has just exited) counts as absent. Any other failure, such as a permission error, an I/O error or a path part that is a file, and any input that does not have exactly the expected form, means the tool cannot tell. It then stops before any edit with exit 6, and `--check` reports that item as `unknown`. This covers the process table and `/proc/<pid>/environ`, `/proc/bus/input/devices`, the output of `wlr-randr` and `dpkg`, `/etc/rpi-issue`, the device-tree model, the labwc and lightdm files, the managed files in the home folder and the state folder. Values such as hashes, connector names and the Wayland socket name are matched in full against ASCII-only patterns, so a trailing newline, a leading space or a non-ASCII digit is rejected.

**The touch input.** It reads `/proc/bus/input/devices`, which every user can read and which needs no extra package, no `input` group and no root. Every record must be complete, as the kernel prints it: the `I`, `N`, `P`, `S`, `U` and `H` lines, the `PROP` and `EV` bitmaps, and each type bitmap (`KEY`, `ABS`, `REL`, ...) exactly when its `EV` bit is set; anything else means it cannot tell. A device counts as touch by the rule udev uses for `ID_INPUT_TOUCHSCREEN`, which is what libinput, and so labwc, treats as touch: absolute X/Y or multitouch axes, a touch button or the "direct" property, an event node, and not a pen tablet, touchpad, absolute mouse or accelerometer. The device's name there is the name labwc matches in `<touch deviceName="…">`. Exactly one touch device is required: two, even with the same name, could be two panels, so the run stops. The name is stored in the private state folder and never printed. (`libinput list-devices` gives the same names but may need root, and `udevadm` adds nothing here.)

**Orientation.** `portrait` is the default and the first choice for a kitchen screen. For a screen whose own mode is landscape (wider than tall), portrait is output transform `90`, `portrait-flipped` is `270`, `landscape` is `normal` and `landscape-flipped` is `180`. For a screen whose own mode is already portrait (taller than wide), the table turns by 90 degrees: portrait is `normal`, `portrait-flipped` `180`, `landscape` `90`, `landscape-flipped` `270`. Running setup again without `--orientation` keeps the last orientation.

### What it writes, and how each is undone

| File (in the home folder) | Change | `--off` | `--undo` |
| --- | --- | --- | --- |
| `.config/kanshi/config` | A profile `sproutwall-kiosk` with `output <CONNECTOR> enable transform <T>`, placed first between `# sproutwall:kiosk-output` comments. Other profiles stay below, unchanged. Mode, position and scale are not set. | kept | original bytes back (or the file removed if it did not exist) |
| `.config/labwc/rc.xml` | One `<touch deviceName="…" mapToOutput="<CONNECTOR>" />` line, after a `<!-- sproutwall:kiosk-touch -->` comment, just above the closing tag. A new file has only that entry. | kept | original bytes back (or removed) |
| `.config/labwc/autostart` | Active `swayidle` lines (desktop screen blanking, as Control Centre and `raspi-config` write it) removed; one launcher line added at the end. | the launcher line becomes a comment | original bytes back (or removed), so blanking returns as it was |
| `.local/bin/sproutwall-kiosk` | The launcher (a copy of `scripts/sproutwall_lib/kiosk_launcher.py`), mode 0755. Setup refuses if a file is already there without its record. | kept | removed |
| `.local/state/sproutwall/kiosk/` | Private state, mode 0700: `manifest.json` (the record: for each managed file its original, and what the last run left or, during a run, what it held before and what the run writes, each as existence, sha256 and mode; the orientation, connector and touch device; the autologin state before setup; the folders and files setup created), `original/` (copies of the original files), `setup.lock`, `run/` (the launcher's lock and waiting page) and `browser/` (the kiosk browser's profile). | kept | the files setup created and the launcher's files are deleted one by one, `browser/` is emptied, then each folder setup created is removed if it is empty |

The managed files keep their original permissions. Each is written to a new temporary file in the same folder, flushed to disk with fsync, renamed over the old file, and then read back and compared with what was meant to be written (bytes and mode). The old file stays whole until the rename, so a failure never leaves a half-written `rc.xml`, kanshi config or autostart. Every run rebuilds each file from its original, so running setup twice gives the same bytes and never a second launcher line or touch entry.

**One run at a time.** Setup, `--off` and `--undo` hold an exclusive lock on `setup.lock` in the state folder for the whole run, and check after locking that the path still names the locked file. A second run stops at once with exit 4. `--check` only reads and takes no lock.

**A write-ahead record.** Before it writes anything, a run saves the record with phase `writing` and, for each managed file, `previous` (what the file holds now) and `target` (what this run writes); the folders and files it will create are recorded before they are created. Then it writes the files, then saves phase `done` with `installed` set to the targets. If a run stops halfway (a full disk, a power cut), every file is at its previous state, its original or its target; while the phase is `writing` all three are accepted, so running the same command again finishes the job, and `--undo` restores the originals. The unit tests stop each operation (first setup, a new orientation, `--off`, re-enabling, `--undo`) right after each single file write and check both ways out.

**Edits made after setup.** Setup, `--off` and `--undo` compare every managed file with the record first: its existence, sha256 and permission bits, and that it is a regular file, not a link. A file that was edited, deleted or `chmod`-ed after setup, by Control Centre or by hand, stops the run with exit 5 and nothing is changed; `--check` reports `files changed`. The files are observed once, then again right before the first write (after detecting the screen and stopping the browser), and each file once more right before it is replaced (bytes, mode, inode and change times). A change at any of these points stops the run with exit 5 and nothing more is written. A very small window remains between that last check and the rename itself: an editor that saves inside it loses to this write.

**Ownership.** The state folder and the launcher belong to this tool only with its record. A state folder that exists without `manifest.json` (other than one holding nothing but an empty `setup.lock`, as an interrupted first run leaves it), or a `~/.local/bin/sproutwall-kiosk` without the record, stops every command with exit 5 before anything is changed: check them and remove them by hand. `--undo` deletes only the files the record lists as created by setup (the original copies and `setup.lock`) and the launcher's own `run/` files, one by one; it never deletes a folder with its contents. The one folder it empties is `browser/`, which setup created empty for the kiosk browser and which holds the screen's unlock; links inside it are removed, never followed. Folders setup created are then removed only if they are empty, so anything else left in the state folder stays, and `--undo` says so.

**Why a text merge for `rc.xml`.** Python's ElementTree would rewrite the whole file: the default namespace becomes `ns0:`, the XML declaration, attribute quoting and spacing change. The tool therefore inserts its two lines as text and leaves every other byte alone. ElementTree is used only to check that the original and the result are well-formed with a labwc root (`openbox_config` or `labwc_config`), and that the last `<touch>` entry for the device maps to the connector. labwc searches its touch entries from the end, and with `-m` reads `/etc/xdg/labwc/rc.xml` before the user's file, so the managed entry wins. It has no `mouseEmulation`, so labwc's default applies (real touch events, so swiping scrolls in Chromium). For Raspberry Pi's own DSI displays, whose system entries set `mouseEmulation="yes"`, this is a change that `--undo` reverts.

**Applying it.** After writing, it sends `SIGHUP` to this session's kanshi (it re-reads its configuration and applies the first matching profile) and to labwc (the same signal `labwc --reconfigure` sends: it re-reads `rc.xml` and remaps touch inputs). It then reads the transform back with `wlr-randr` for up to three seconds and says whether the rotation is in effect. labwc cannot report its touch mapping, so the tool asks you to tap the four corners and the centre: a rotated picture alone does not prove touch is right.

**Sources for these paths.** The Raspberry Pi documentation says to set orientation in Control Centre (Screens) and lists [raindrop](https://github.com/raspberrypi-ui/raindrop) as Control Centre's screen configuration plugin. raindrop's labwc backend writes the output layout as a kanshi profile in `~/.config/kanshi/config` (reloaded with `SIGHUP`) and touch mappings as `<touch deviceName mapToOutput>` in `~/.config/labwc/rc.xml` (reloaded with `labwc --reconfigure`). Raspberry Pi's desktop package starts the session with `labwc -m`, creates an empty `~/.config/kanshi/config` at login and starts kanshi from `/etc/xdg/labwc/autostart`. Desktop screen blanking is a `swayidle` line in `~/.config/labwc/autostart` (documentation: Configure screen blanking). The exact commits are cited in `scripts/sproutwall_lib/kiosk_files.py` and `kiosk_detect.py`.

### Autologin: printed, not run

The screen must come back by itself after a power cut, so the desktop user must log in automatically. On Raspberry Pi OS that is `autologin-user` in lightdm's configuration, which needs root. **The tool never runs `sudo`.** It reads the current state as lightdm does: the `*.conf` files in `/usr/share/lightdm/lightdm.conf.d`, `/usr/local/share/lightdm/lightdm.conf.d`, `/etc/xdg/lightdm/lightdm.conf.d` and `/etc/lightdm/lightdm.conf.d`, in name order, then `/etc/lightdm/lightdm.conf`, later files winning. Only `autologin-user` in `[Seat:*]` (or its old name `[SeatDefaults]`) counts, overridden by a `[Seat:<pattern>]` section matching the Pi's seat, `seat0`. A file that cannot be read or has a malformed line makes the state `unknown`, never `off`. Then, unless autologin is already on for this user, prints the one command for you to run yourself:

```bash
sudo raspi-config nonint do_boot_behaviour B4
```

Why not run it after a confirmation: during an assisted install (tier A) an assistant drives this tool, and the guide never gives an assistant sudo; you type your password only into sudo's own prompt, in a command you can read first. `raspi-config` is Raspberry Pi's own tool for this change, and a tool that cannot become root cannot make an unexpected privileged change. `--check` shows `autologin off` until it is done. If autologin was not on for this user before setup and is on after `--undo`, `--undo` prints the command that turns it off again: `sudo raspi-config nonint do_boot_behaviour B3`.

### The launcher

`~/.local/bin/sproutwall-kiosk` starts from labwc autostart after the desktop login, as the desktop user. It needs no Docker access.

- It needs the state folder's `run/` and `browser/`, which setup creates, and otherwise says that the kiosk is not set up. It takes a lock in `run/`, so a second launcher exits at once, and it exits if a Chromium with its profile is already running. It never starts a second browser.
- It asks `GET http://127.0.0.1:3847/api/health` with a 3-second socket timeout and a 5-second deadline for the whole request (connect, headers and body), every 2 seconds for the first minute and then every 10 seconds. A server that trickles bytes is cut off at the deadline. Redirects are never followed. It opens the hub only on HTTP 200 with JSON `ok: true`.
- After 90 seconds without that answer it shows a local page saying the hub is starting, and keeps checking every 10 seconds. When the hub is ready it closes that page and opens the hub.
- It starts one Chromium: `--kiosk --no-first-run --noerrdialogs --disable-infobars --hide-crash-restore-bubble --password-store=basic --user-data-dir=<state>/browser http://127.0.0.1:3847/`. The profile is persistent, so the screen's unlock lasts. There is no incognito, no `--no-sandbox` and no remote debugging. `--password-store=basic` keeps Chromium from stopping at a keyring password prompt, which autologin never unlocks; the profile folder is private (0700).
- When Chromium exits (for example Alt+F4 with a keyboard), the launcher exits; the next login starts it again. On `SIGTERM` it closes Chromium first. `--off` and `--undo` send `SIGTERM` and, if the launcher or browser is still there after ten seconds, `SIGKILL`.
- It is guarded like `scripts/sproutwall`: warnings are off, `sys.excepthook` and `threading.excepthook` are set, and any failure (an unusable state folder, a lock or waiting-page error, anything unexpected) prints one fixed line to stderr, never a traceback, path or error text, stops any Chromium it started (terminate, then kill) and exits 1.
- Its health check has no host dependency in the tests: the unit tests replace the connection, so a real hub (or anything else) listening on port 3847 does not change their result.

The hub's own screensaver is part of the app and is not affected by any of this.

### `--check`, `--off`, `--undo`

`--check` reads, changes nothing, and prints one line per item (with `--json`, exactly one JSON object with these keys in this order and only these values):

| Key | Values |
| --- | --- |
| `schema` | `1` |
| `result` | `ok`, `attention`, `not_installed`, `unsupported`, `unknown` |
| `reason` | `none`, `root`, `unsupported_os`, `no_desktop`, `other_desktop`, `session`, `config_path`, `no_chromium`, `cannot_tell`, `unknown` |
| `installed` | `yes`, `no`, `damaged`, `unknown` (`damaged`: a record that does not validate, or a state folder or launcher without one) |
| `launch` | `on`, `off`, `duplicate`, `none`, `unknown` (launcher lines in labwc autostart) |
| `files` | `as_set_up`, `partial`, `changed`, `none`, `unknown` (managed files against the record: bytes, mode, type; `partial` while a run is unfinished) |
| `running` | `yes`, `no`, `unknown` |
| `output` | `one`, `none`, `several`, `unsupported_connector`, `unknown` |
| `orientation` | `portrait`, `portrait-flipped`, `landscape`, `landscape-flipped`, `none`, `unknown` |
| `rotation` | `applied`, `not_applied`, `unknown` (the live transform of the configured connector) |
| `touch` | `mapped`, `not_mapped`, `unknown` (the effective labwc entry for the stored device) |
| `blanking` | `off`, `on`, `system`, `unknown` |
| `autologin` | `on`, `off`, `other_user`, `unknown` |

`ok` means everything is as setup left it, with the launch on or off as last chosen, and autologin on. Anything that could not be read is `unknown`, never a guess; with no definite problem but an unknown item the result is `unknown` (exit 6). Without the desktop session (for example over SSH while nobody is logged in), the live items are `unknown`. A refused check (for example as root or on another device) reports `unknown` for every item, because it looked at none. With `--json`, help and usage errors print the same object with every value `unknown` (exit 2), and so does `scripts/sproutwall` itself if the library cannot even be loaded.

`--off` stops the running launcher and its browser (`SIGTERM`), turns the launcher line into a comment and keeps everything else, so `doctor --kiosk off` passes. The hub keeps running and phones still reach it. `setup kiosk` turns it back on with the same files as before.

`--undo` compares each managed file with the record first. If any was changed after setup, for example by Control Centre or by hand, it stops and changes nothing; put the change back or remove the kiosk by hand. Otherwise it stops the launcher, restores the original bytes and permissions of every file (and removes files that did not exist) as one recorded run, checks each one, removes what setup created as described under Ownership, and reloads kanshi and labwc. Setup refuses to run over changed files in the same way. Setup after `--undo` starts fresh with a new record.

| Exit | Meaning |
| --- | --- |
| 0 | Done; or `--check` found everything as set up; or `--off`/`--undo` with nothing set up. |
| 1 | `--check` needs attention, or nothing is set up yet. |
| 2 | Usage error, or an unexpected error. The message says whether writing had started; it never claims that nothing changed. |
| 3 | Refused: not the supported path, a link in the way, or an `rc.xml` that cannot be merged. Nothing was changed. |
| 4 | Stopped: the screen or touch input is not ready (none, several), a hand-made kiosk line is present, or another `setup kiosk` run is in progress. Nothing was changed. |
| 5 | Stopped: managed files were changed after setup (bytes, mode or type), the record or snapshot is damaged, or the state folder or launcher exists without a record: nothing was changed. Or a file changed while it was being updated: that file was left as it is and nothing more was written. |
| 6 | Stopped: something it must read could not be read or did not parse, so it cannot tell whether an edit is safe. Nothing was changed. (`--check`: an item is `unknown`.) |

Messages are fixed text chosen by these outcomes. The screen is named only by its kind (HDMI or DSI); its connector name, the touch device name, paths, user names and command output are written to the config files where needed but never printed, in text or JSON. The unit tests seed a fictional user name, home path, touch device name and connector names into every input and run every subcommand in process and through the real `scripts/sproutwall` in a subprocess, capturing the real output streams, a DEBUG root logger and warnings; none of the seeded values may appear.

### Still to verify on real hardware

The sandbox that wrote this had no Raspberry Pi, display or touch panel. On the acceptance screen of the first physical trial, record the observed connector, native mode, touch input and OS build, then check:

1. [미확인] `wlr-randr --json` on current Raspberry Pi OS prints the fields the parser reads (`name`, `enabled`, `modes[].width/height/preferred/current`, `transform`); otherwise the plain-format fallback is used.
2. [미확인] The touch input is found and mapped: tap all four corners and the centre in the chosen orientation, after setup and again after a reboot.
3. [미확인] kanshi applies the profile at login and after `SIGHUP`, and the rotation survives a reboot.
4. [미확인] The panel's own mode decides portrait correctly (a natively portrait DSI panel stays at `normal`).
5. [미확인] With autologin on, Chromium opens without a keyring prompt and without a "restore pages" bubble after a power cut; the unlock survives a reboot.
6. [미확인] The screen stays lit past the old blanking interval; the hub's screensaver still starts.
7. [미확인] `--off` plus reboot opens no browser, `--undo` brings back the earlier desktop behaviour, and re-enabling gives one browser after a cold boot.
