# Install at home

The manual install builds Sproutwall from source with Docker, on a computer that stays on. It is for developers, and for computers the one-command install does not cover, such as a Mac or a Windows PC.

**For a family's kitchen screen on a Raspberry Pi, use the [one-command install](../README.md#with-one-command) instead.** It installs the published preview image only after checking that the project built it, and sets up the screen. This page builds the image on your own computer and does neither.

## What you need

- A computer that stays on: a Linux PC, a Mac, a Windows PC with Docker Desktop, or a Raspberry Pi 4 or 5 ([Pi guide](raspberry-pi.md)).
- [Docker](https://docs.docker.com/get-docker/) with Compose. Check with `docker compose version`.
- [git](https://git-scm.com/downloads), to download Sproutwall and get updates.

## Start it

Open a terminal and run:

```bash
git clone https://github.com/thebrianlee/sproutwall.git sproutwall
cd sproutwall
docker compose up -d --build
```

This makes a folder named `sproutwall`, the hub's folder. The commands in the README run there. Installed before the rename? See [Installed before the rename](../README.md#installed-before-the-rename).

The first start builds the app. That takes a while, and much longer on a Raspberry Pi. `-d` keeps it running in the background. It starts again by itself after a reboot, as long as Docker starts at boot.

Check that it is running:

```bash
docker compose ps
```

After a short wait the status says `healthy`. If something goes wrong, `docker compose logs` shows what happened.

## Keep it safe on a manual install

The README's [Keep it safe](../README.md#keep-it-safe) applies. These points are for the manual install only:

- **For access from outside the house,** use a private VPN such as WireGuard, or a reverse proxy with HTTPS. With HTTPS, set `PUBLIC_URL` (see [Settings outside the app](#settings-outside-the-app)) so the unlock cookies are marked Secure. The proxy must pass the original `Host` (or `X-Forwarded-Host`) header, or the hub refuses changes as cross-site. It should also pass `X-Forwarded-For`, so each screen gets its own wrong-PIN count.
- **Docker gets around your firewall.** On Linux, ports that Docker publishes bypass `ufw` and `firewalld` rules. To limit who can connect, [bind the port to one address](#limit-who-can-connect) instead of relying on firewall rules.
- **Keep screens locked.** Leave `REQUIRE_AUTH_FOR_READS` at `1`. `REQUIRE_AUTH_FOR_READS: "0"` lets anyone who can reach the port read the household. Use it only for a single screen that nobody else on the network can reach.

### Limit who can connect

Create a file named `docker-compose.override.yml` in the hub's folder. Compose reads it automatically.

```yaml
services:
  family-hub:
    ports: !override
      - "127.0.0.1:3847:3847"
```

Then run `docker compose up -d`.

- `127.0.0.1` means only the computer itself can open the hub, for example a Raspberry Pi with its own touchscreen. Phones can no longer reach it.
- To allow your home network but not other networks the computer is on, use the computer's LAN address instead, for example `"192.168.1.50:3847:3847"`.
- `!override` needs Docker Compose 2.24.4 or newer.
- git does not track this file, so updates leave it alone.

### Settings outside the app

A few settings are environment variables. With Docker, add them to the same `docker-compose.override.yml` under `environment:`, then run `docker compose up -d`. Keep API keys in a file named `.env` in the same folder (git ignores it) and refer to them by name:

```yaml
services:
  family-hub:
    environment:
      PUBLIC_URL: https://hub.example
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
```

```bash
# .env, next to docker-compose.yml
ANTHROPIC_API_KEY=paste-your-key-here
```

| Variable | Docker default | What it does |
| --- | --- | --- |
| `REQUIRE_AUTH_FOR_READS` | `1` | `1` locks every screen until it is unlocked with the parent PIN. |
| `PUBLIC_URL` | not set | Set it to your `https://` address when the hub is served over HTTPS. The unlock cookies are then marked Secure. |
| `ANTHROPIC_API_KEY` | not set | Turns on Ask the Hub with Claude. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Which Claude model the bridge asks. |
| `OLLAMA_URL` | not set | Turns on Ask the Hub with a local [Ollama](https://ollama.com/) server. |
| `OLLAMA_MODEL` | `llama3.2` | Which Ollama model to use. |
| `ASK_MAX_PER_MINUTE` | `6` | Most questions the hub sends per minute. |
| `ASK_MAX_PER_DAY` | `100` | Most questions the hub sends per day. |
| `SESSION_SECRET`, `BRIDGE_TOKEN` | generated | Leave these unset. The hub creates random ones in its data volume on first start. |

## Next

- Open the hub and do the [first-run setup](../README.md#first-run-setup) right away: until it is done, anyone on your network could choose the PIN.
- [Open it from a phone or tablet](../README.md#open-it-from-a-phone-or-tablet), and read [Keep it safe](../README.md#keep-it-safe).
- [Back up and update](../README.md#back-up-and-update) uses this install's commands, and so does [turning on Ask the Hub](../README.md#turn-it-on).
