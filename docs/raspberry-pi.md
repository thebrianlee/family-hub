# Sproutwall on a Raspberry Pi

This guide sets up Sproutwall on a Raspberry Pi, with an optional touchscreen that shows the hub full screen. You do not need to be a programmer. You will copy a few commands into a terminal.

Plan for an evening. Most of the time is waiting for downloads and the first build.

## What works

**Supported:**

- Raspberry Pi 4 or Raspberry Pi 5, with 4 GB of memory or more.
- Raspberry Pi OS **64-bit**, Bookworm or later.
- An SSD on USB (best), or a good microSD card rated **A2**. Cheap cards make the Pi slow and can wear out. 32 GB or larger leaves room for updates and photos.
- The official power supply for your Pi model. A weak supply causes strange crashes.
- Optional: a screen. The official Raspberry Pi touch display or any HDMI monitor works.

**Not supported:**

- 32-bit Raspberry Pi OS. Docker Engine 29 and later no longer ship 32-bit packages for it, and the database library has no ready-made 32-bit version, so it would need a slow compile.
- Raspberry Pi Zero, Pi 1, Pi 2 and Pi 3. They are too old or too small for this app.

## Step 1: Put Raspberry Pi OS on the card

1. On your regular computer, install [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. Plug in the microSD card or SSD.
3. In Imager, choose your Pi model, then **Raspberry Pi OS (64-bit)**. Pick the version with the desktop if you will attach a screen. Then choose the card.
4. When Imager offers to customize the system (the button may say **Edit Settings** or **Customisation**, depending on the Imager version), set:
   - **Hostname:** `hub`. You can then reach the Pi as `hub.local` from many devices.
   - **Username and password.** Write them down.
   - **Wi-Fi** name and password, unless you use a network cable.
   - **Time zone** and keyboard layout.
   - **Enable SSH**, so you can type commands from your regular computer.
5. Write the card. Put it in the Pi and switch it on. The first start takes a few minutes.

## Step 2: Open a terminal on the Pi

Pick one:

- **On the Pi itself,** with a keyboard and screen: open the **Terminal** app.
- **From your regular computer:** open a terminal (on Windows, PowerShell) and type the line below, using the username you chose. Type `yes` if it asks about a fingerprint, then your password.

  ```bash
  ssh <username>@hub.local
  ```

Bring the Pi up to date, then restart it:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

Wait a minute and open the terminal again.

## Step 3: Install Docker

Docker runs Sproutwall in its own container. Use Docker's official instructions. The 64-bit Raspberry Pi OS is based on Debian, so Docker's [Raspberry Pi OS page](https://docs.docker.com/engine/install/raspberry-pi-os/) sends 64-bit users to the Debian steps.

1. Follow **Install using the `apt` repository** on Docker's [Debian install page](https://docs.docker.com/engine/install/debian/). Docker also offers a convenience script on that page, but Docker itself recommends it only for testing.
2. Let your user run Docker without `sudo`, as described in Docker's [post-install steps](https://docs.docker.com/engine/install/linux-postinstall/):

   ```bash
   sudo usermod -aG docker $USER
   ```

   Then log out and back in (or `sudo reboot`) so the change takes effect.
3. Check that it works:

   ```bash
   docker compose version
   ```

## Step 4: Download and start Sproutwall

```bash
sudo apt install -y git
git clone https://github.com/thebrianlee/sproutwall.git sproutwall
cd sproutwall
docker compose up -d --build
```

**The first build on a Pi can take a long time.** It compiles the whole app on the Pi. Leave it running and do not unplug the Pi. If it stops with `Killed`, `exit code: 137` or "out of memory", see [The build runs out of memory](#the-build-runs-out-of-memory).

When the build is done, check it:

```bash
docker compose ps
```

After a short wait the status says `healthy`. To watch the hub's messages, run `docker compose logs -f`. Press Ctrl+C to stop watching. The hub keeps running.

## Step 5: Find the hub's address

On the Pi, run:

```bash
hostname -I
```

The first number is the Pi's address, for example `192.168.1.50`. On a phone or tablet on the same Wi-Fi, open `http://192.168.1.50:3847` (with your number). Many devices can also open `http://hub.local:3847`, but not all.

Ask your router to always give the Pi this address (often called a "DHCP reservation"), so bookmarks keep working.

Now do the first-run setup: choose the parent PIN, your family and your timezone. The [README](../README.md#first-run-setup) explains each field. Do it right away: until setup is done, anyone on your network could choose the PIN.

## Step 6: Show the hub full screen on the Pi's own screen (optional)

This needs the desktop version of Raspberry Pi OS. The attached screen opens the hub from the Pi itself at `http://localhost:3847`.

### Turn off screen blanking

By default the Pi turns its screen off after some idle minutes. Turn that off:

1. Run `sudo raspi-config`.
2. Choose **Display Options**, then **Screen Blanking**, and answer **No**.
3. Finish and reboot.

Sproutwall has its own screensaver instead. After 10 idle minutes it shows your photos and quotes.

### Log in to the desktop automatically

In `sudo raspi-config`, under **System Options**, find the boot or auto-login option (the wording differs between releases) and choose **Desktop Autologin**. This way the screen comes back by itself after a power cut.

### Start Chromium full screen at login

**The exact file differs by Raspberry Pi OS release.** Current releases use a desktop called labwc. Some older Bookworm images use one called wayfire. To see which one you have, run this on the Pi while the desktop is showing:

```bash
ps -e | grep -E 'labwc|wayfire'
```

The browser command also changed name. Current releases call it `chromium`. Older Bookworm images call it `chromium-browser`. Run `command -v chromium chromium-browser` and use the name it prints.

**If you have labwc** (current releases), add this line to the file `~/.config/labwc/autostart`. Create the file if it does not exist, for example with `nano ~/.config/labwc/autostart`:

```bash
chromium http://localhost:3847 --kiosk --noerrdialogs --disable-infobars --no-first-run --start-maximized &
```

The `&` at the end matters. This follows the official Raspberry Pi [kiosk tutorial](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/). On some releases your own `autostart` file replaces the desktop's built-in one, so the taskbar may not appear. That is fine for a wall screen.

**If you have wayfire** (older Bookworm images), open `~/.config/wayfire.ini` and add these lines at the end. If an `[autostart]` section already exists, add only the second line to it:

```ini
[autostart]
sproutwall = chromium-browser http://localhost:3847 --kiosk --noerrdialogs --disable-infobars --no-first-run --start-maximized
```

Reboot. The hub opens full screen and asks once for the parent PIN to unlock the screen. The unlock lasts 30 days.

Do **not** add `--incognito`. Incognito forgets the unlock every time Chromium restarts, so the screen would ask for the PIN again and again.

To leave kiosk mode for a moment, press Alt+F4 with a keyboard attached.

## Keep it running

These run in the hub's folder: `cd ~/sproutwall`, or `cd ~/family-hub` if you installed before the rename to Sproutwall. The [README](../README.md#back-up-and-update) explains each one.

**Back up** the household and photos to one file:

```bash
docker compose stop
docker compose run --rm -T --entrypoint tar family-hub czf - -C / data photos > sproutwall-backup.tgz
docker compose start
```

Copy `sproutwall-backup.tgz` off the Pi, for example to a USB stick. SD cards fail sometimes.

**Update** (back up first):

```bash
git pull && docker compose up -d --build --remove-orphans
```

Updates rebuild the app on the Pi, so they also take a while.

**Forgot the PIN:**

```bash
docker compose exec family-hub node scripts/reset-pin.mjs 4827
```

Use your own new PIN instead of `4827`. Every screen then asks for the new PIN.

## Troubleshooting

### A phone or tablet can't reach the hub

- Is the phone on the same Wi-Fi as the Pi? Guest networks often keep devices apart. So can a VPN app on the phone.
- Did you type `http://` (not `https://`) and `:3847` at the end?
- Did the Pi's address change? Run `hostname -I` again, and set a DHCP reservation in your router.
- Is the hub running? `docker compose ps` should say `healthy`. If not, `docker compose logs` shows why.
- Does the Pi's own screen work with `http://localhost:3847`? If yes, the hub is fine and the problem is the network between the phone and the Pi.

### The screen goes black

- Turn off screen blanking (see [Step 6](#turn-off-screen-blanking)).
- Some monitors and TVs have their own power-saving setting. Check the monitor's menu.
- Sproutwall's own screensaver shows photos and quotes, not a black screen. Tap the screen to go back to the hub.

### The build runs out of memory

Building the app needs a lot of memory. On a 4 GB Pi the build may fail. Adding swap space (disk space used as extra memory) usually helps.

On Bookworm, swap is set in `/etc/dphys-swapfile`:

```bash
sudo dphys-swapfile swapoff
sudo nano /etc/dphys-swapfile
```

Change the line to `CONF_SWAPSIZE=2048`, save (Ctrl+O, Enter) and exit (Ctrl+X). Then:

```bash
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

Run `docker compose up -d --build` again. If `/etc/dphys-swapfile` does not exist, your release manages swap differently. Check the [Raspberry Pi documentation](https://www.raspberrypi.com/documentation/) for your release.

Swap on an SD card is slow and wears the card. An SSD is better if you build often.

### Ask the Hub is slow or does not answer

Running a local language model (Ollama) on the Pi itself is likely to be too slow. The hub gives up on an answer after 40 seconds. Use one of these instead:

- An Anthropic API key (`ANTHROPIC_API_KEY`), or
- Ollama on a faster computer in your home, with `OLLAMA_URL` set to that computer, for example `http://192.168.1.60:11434`. That Ollama must accept connections from the network.

The README explains [how to turn it on](../README.md#ask-the-hub) and what is sent to the model.

### The screen keeps asking for the PIN

- Chromium must not run in incognito mode (see [Step 6](#start-chromium-full-screen-at-login)).
- Changing or resetting the PIN locks every screen once. Enter the new PIN.
- The unlock lasts 30 days. After that the screen asks again.

### The time or date is wrong

The hub uses the timezone chosen at setup, not the Pi's own setting. Open [Settings](../README.md#parent-settings), check **Timezone** under **Household** (for example `America/Chicago`), or tap **Use this device's timezone**, then save.
