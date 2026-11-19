# The install helper: `scripts/sproutwall`

`scripts/sproutwall` is a small Python 3 tool for the guided install. It needs Python 3.11 or newer and uses only the standard library: no pip packages and no Node on the host. It runs system tools (Docker, `ip`, `systemctl`, `dpkg`, `gh`) with fixed argument lists, never through a shell, and never uses `sudo`. It sends no telemetry.

Run it from the hub's folder:

```bash
./scripts/sproutwall doctor --phase running
./scripts/sproutwall verify-image --source-sha <commit>
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
| `temporary_access` | No installation-only assistant CLI, its credentials or autostart entry is left in the home folder, and no SSH session into the Pi is open. From `final`. |

`not_applicable` is used only for the phase omissions marked "From" above.

**`platform`.** It accepts any 64-bit Linux that the image supports: the kernel is `aarch64` or `x86_64`, and the userland is 64-bit too (`dpkg --print-architecture` says `arm64` or `amd64`; on systems without dpkg, how Python was built). A Raspberry Pi 4, 5, 400, 500 or Compute Module 4/5 with 64-bit Raspberry Pi OS passes, as do other arm64 boards and amd64 mini PCs. A 32-bit OS or CPU (`armv7l`, `armv6l`, `i686`, or an `armhf`/`i386` userland on a 64-bit kernel) and non-Linux systems fail with `use_supported_os`. The device model is never read or printed.

**`setup`.** The health answer carries one boolean, `setup`, from the hub's `setup_complete` setting (only when the database is readable; the blocked 503 answer is unchanged). It tells an anonymous visitor nothing new: the setup screen, and `/api/setup` answering 409 once setup is done, already show it. `setup: false` fails with `open_hub`; no answer, or an image from before the field existed, is `unknown`.

**`ssh_policy`.** SSH counts as on if `ssh.service`, `sshd.service`, `ssh.socket` or `sshd.socket` is enabled or active, or if anything listens on port 22 or on a `Port` named in the SSH server config. Any `PasswordAuthentication yes` or `KbdInteractiveAuthentication yes`, also inside a `Match` block, means not key-only, as do `PermitRootLogin yes`, empty passwords and password methods in `AuthenticationMethods`. `Include` paths may be quoted, as sshd allows. If `/etc/ssh/sshd_config` or any file it includes cannot be read, or a folder that an `Include` wildcard has to list cannot be listed, the result is `unknown` (`review_ssh`), because a port or password rule could hide there.

**`kiosk` marker.** The kiosk setup (a later release) adds exactly one launcher line to `~/.config/labwc/autostart`, ending with the comment `# sproutwall:kiosk-launcher`. Doctor counts the lines with that marker that are not commented out: one when `--kiosk on`, none when `--kiosk off`.

### Exposure

Doctor reads the listening sockets (`/proc/net/tcp` and `/proc/net/tcp6`), every interface address (`ip -j addr show`, IPv4 and IPv6) and the container's published ports. Loopback is local; `10/8`, `172.16/12`, `192.168/16`, link-local and `fc00::/7` are the home network; every other address, including a global IPv6 address, is public. A wildcard bind (`0.0.0.0`, `::`) counts on every interface.

- Public exposure fails with `restrict_ports`, even if part of the inspection failed: socket tables are read line by line, and what was already read is kept when a later line or file cannot be read. That only makes the result incomplete.
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
| 2 | Refused before checking: bad arguments, the compose file, or no Docker Compose to read it. |
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
