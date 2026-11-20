# Manual install: build from source

This builds Sproutwall from source with Docker, on a computer that stays on. It is for developers, and for computers the one-command install does not cover, such as a Mac or a Windows PC.

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

## Next

- Open the hub and do the [first-run setup](../README.md#first-run-setup) right away: until it is done, anyone on your network could choose the PIN.
- [Open it from a phone or tablet](../README.md#open-it-from-a-phone-or-tablet), and read [Keep it safe](../README.md#keep-it-safe).
- [Back up and update](../README.md#back-up-and-update) uses this install's commands.
