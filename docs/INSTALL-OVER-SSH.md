# Install from your laptop over SSH (no keyboard on the Pi)

This guide installs Sproutwall on a Raspberry Pi from your laptop. The Pi needs its screen, but no keyboard or mouse. You type everything on the laptop, in an SSH window that runs commands on the Pi.

New to all of this and have a keyboard for the Pi? [The step-by-step guide](INSTALL-BEGINNERS.md) does the same with the keyboard on the Pi.

## Before you start

**If your family already uses Sproutwall (or Family Hub), don't reinstall it.** Writing a card erases it, household included. Use a new card, or one whose contents are backed up somewhere else.

You need:

- A Raspberry Pi 4 or 5 with its screen attached, and a power supply.
- A microSD card of 32 GB or more, and a card reader for your laptop.
- Your laptop on your home Wi-Fi (not a guest network). The Pi joins the same network.
- [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on the laptop.

Never type a password or the parent PIN into a chat AI, a message or a GitHub issue. They go only into the Pi's own password prompt and the hub's own page.

## Step 1: Write the card with Raspberry Pi Imager

Put the card in the laptop's reader and open Imager. Choose:

1. **Device:** your Pi model.
2. **OS:** Raspberry Pi OS (64-bit), the version with the desktop.
3. **Storage:** the microSD card. Check the name and size twice: this card gets erased.
4. **Customisation:**
    - **Hostname:** `hub`. If another device on your network is already called `hub`, choose another name, such as `hub2`, and use it wherever this guide says `hub`.
    - **Localisation:** where you live (Imager may ask for your capital city), your time zone and keyboard layout. The hub takes its time zone from the Pi.
    - **User:** a username and a password you will remember. Keep the password to yourself.
    - **Wi-Fi:** your home network and its password.
    - **Remote access:** turn **SSH** on, with **password authentication**.
5. **Write.** Imager writes the card, then checks it (verifying).

If Imager says "Error reading from storage", or that verifying failed, see [If Imager can't read the card](INSTALL-BEGINNERS.md#if-imager-cant-read-the-card).

When Imager is done, put the card in the Pi. Connect the screen (and its touch cable, if it has one) as the screen's instructions say, then switch the Pi on.

## Step 2: Log in to the Pi from your laptop

The first start takes a few minutes: the Pi sets itself up and may restart once. Wait until its desktop shows on the screen.

On the laptop, open **Terminal** (Mac or Linux) or **PowerShell** (Windows) and type, with your own username:

```bash
ssh <your-username>@hub.local
```

- The first time, it asks whether to trust the Pi's fingerprint. On your own home network, type `yes`.
- Then type the Pi's password. Nothing shows while you type; that is normal.
- The prompt changes to `<your-username>@hub`. From now on, everything you type in this window runs on the Pi.

If ssh says **REMOTE HOST IDENTIFICATION HAS CHANGED**, this laptop has logged in to a Pi called `hub` before, for example with an earlier card. Run `ssh-keygen -R hub.local` on the laptop, then log in again.

If it says it can't find `hub.local`, wait a minute and try again. Still nothing after 5 minutes: find the Pi in your router's list of devices and use its address instead, for example `ssh <your-username>@192.168.1.50`.

## Step 3: Run the one command

In the SSH window, paste this and press Enter. Run it as yourself, never with `sudo` in front:

```bash
curl -fsSL https://raw.githubusercontent.com/thebrianlee/sproutwall/main/install.sh | bash
```

It asks these questions, in this order. For the yes/no questions only `y` (or `yes`) goes on; anything else, or just Enter, ends with nothing changed.

| Question on screen | What it means | Your answer |
| --- | --- | --- |
| How does the screen hang? (1 to 5) | Which way the kitchen screen is turned. 5 = no kiosk, phones and tablets only. | Enter for portrait, or the number |
| Do you approve this plan? | It lists every command it will run as administrator, with why and how to undo it. Read it. | `y` |
| Is all of this true for the network this device is on? | Your own home network: not a guest network, no port forwarding, no tunnel. | `y` if true |
| SSH: YOUR RESPONSIBILITY. Do you understand and accept this? | While SSH is on, anyone on your home network who knows the Pi's password could log in. Keeping it safe is on you. | `y` to go on |
| The `sudo` password prompt, if it asks | Your Pi password, for a read-only look at the SSH settings, then for the installs. On some Pis `sudo` doesn't ask. | the Pi password |

Then it installs the tools, downloads the hub, checks the hub's signature and starts it. This is the long part. Let it run, and keep the SSH window open. Keep the laptop awake and plugged in until the command finishes: if the laptop sleeps, the SSH session and the install stop. If that happens, log in again and run the one command again; if it prints a `Stopped:` line, follow it.

## Step 4: Set up the household, the screen, and finish

1. **"Set up your household now."** The command waits and prints an address such as `http://192.168.1.50:3847`. Open it in your laptop's web browser. On **Set up the house**, choose the sample family or your own, choose what the wall shows, then the house details and the **parent PIN** (typed twice). Tap **Open the wall**. Go back to the SSH window and press Enter.
2. **The screen.** The picture turns the way you chose. Tap the four corners and the centre of the Pi's screen: each tap must land under your finger. Then press Enter in the SSH window. If you chose 5 (no kiosk), this step is skipped.
3. **"Run it now? sudo asks for your password."** It asks only if the Pi's desktop doesn't log in by itself yet. That makes the screen come back after a power cut. Answer `y`, and type the Pi password if `sudo` asks.
4. **"Sproutwall is installed."** It prints a summary and a phone check: on a phone on the same Wi-Fi, open the address it shows. The phone must show **Unlock this screen** and ask for the PIN. It must never show the family without asking.
5. **"Turn SSH off now?"** `y` is the safe choice. `n` keeps SSH on, and keeping the Pi safe is then on you.
6. **Restart:** type `sudo reboot`. The SSH window closes.

After the restart, the hub comes back on the Pi's screen by itself, the right way up, and asks once for the parent PIN: type it on the screen. Tap the four corners and the centre again. With no kiosk (choice 5), the screen shows the normal desktop; use the hub from phones and tablets. Either way, a phone on the Wi-Fi must still show **Unlock this screen**. The install is done.

The [AI install guide](../INSTALL-WITH-AI.md#step-8-remove-the-assistant-and-check-once-more) has the final check, for when you have a keyboard on the Pi or kept SSH on.

## If it stops

If something is wrong, the command prints one line that starts with `Stopped:`. That line says why and what to do. It never deletes your files or the hub's data.

- Do what the line says. Don't work around it, and don't delete the `sproutwall` folder or anything Docker made.
- If you answered `n` to a question, it ends with a plain message that nothing was changed. That is not an error: run the command again when you're ready.

Please tell us how it went, whether it worked or not, with an [install report](https://github.com/thebrianlee/sproutwall/issues/new?template=install_report.yml). Copy the `Stopped:` line exactly if there was one. Share nothing else: no passwords, no PIN, no logs or screenshots of your network.

## Optional: let a free AI chat walk you through it

Open a free AI chat in your laptop's web browser, such as ChatGPT, Claude or Gemini. Keep the SSH window from step 2 open next to it, and paste this into the chat:

```text
Help me install Sproutwall on my Raspberry Pi, set up for our family. I'm logged in to the Pi over SSH from my laptop, and I will run this one command myself in that SSH window:

curl -fsSL https://raw.githubusercontent.com/thebrianlee/sproutwall/main/install.sh | bash

The guide is https://github.com/thebrianlee/sproutwall/blob/main/INSTALL-WITH-AI.md, and I'm in its tier B. Explain each question the command asks me, and help me if it stops. Ask me whatever you need.
```

Copy each command it gives you into the SSH window, and tell it only the short result it asks for. Never give it your passwords or the PIN.
