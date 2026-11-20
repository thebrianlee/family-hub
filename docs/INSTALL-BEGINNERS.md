# Install Sproutwall: a step-by-step guide for beginners

This guide is for you if you have never used a Raspberry Pi, a Terminal or GitHub. If you can use a laptop, a web browser and a chat AI (an AI assistant you talk to on a web page), you can do this.

It takes you from "I have a Pi, a screen and an SD card" to Sproutwall on your kitchen screen. In this guide, "the hub" means Sproutwall running on your Pi. You prepare the card and start the Pi yourself. Then a chat AI walks you through the install, one command at a time, using [INSTALL-WITH-AI.md](../INSTALL-WITH-AI.md). That page stays the full reference. This one gets you to the point where the AI takes over, tells you what you will see on the way, and lists what never to share.

> **Early preview.** The guided install is new. It has been tested once, with a chat AI, in a Debian 13 virtual machine (a computer simulated inside another computer). It has not yet been tested end to end on a real Raspberry Pi. If you try it, please tell us how it went with an [install report](https://github.com/thebrianlee/sproutwall/issues/new?template=install_report.yml), whether it worked or not.

## 1. What you need

- [ ] A **Raspberry Pi 4 or Raspberry Pi 5**, with its power supply. The official power supply for your model is the safe choice: a weak one causes strange crashes.
- [ ] A **screen**. A touch screen is best for a kitchen. Connect it the way the screen's own instructions say: many HDMI touch screens need a second, USB cable for touch. The automatic screen setup needs a touch screen. Any other screen works too, but is set up [by hand](raspberry-pi.md#set-it-up-by-hand).
- [ ] A **microSD card of 32 GB or more**, and an **SD card reader** for your laptop (a slot in the laptop, or a small USB reader).
- [ ] A **USB keyboard**. Strongly recommended for the setup: you will paste commands and type passwords. A mouse helps too, and a touch screen also works as a mouse.
- [ ] Your **home Wi-Fi name and password**. Use your own home network, not a guest network. A network cable works too.
- [ ] **About an hour.** Much of it is waiting for downloads.

If this Pi already runs something you care about, use a different card and keep the old one safe. The next section erases everything on the card you use.

## 2. Put Raspberry Pi OS on the card

Raspberry Pi OS is the Pi's operating system, like Windows or macOS on a laptop. You put it on the card from your laptop with Raspberry Pi Imager, the official free tool.

1. On your laptop, download and install [Raspberry Pi Imager](https://www.raspberrypi.com/software/). This guide follows Imager 2. If your Imager looks very different, get the current version from that page.
2. Put the microSD card in your laptop and open Imager. It walks you through six screens: **Device**, **OS**, **Storage**, **Customisation**, **Writing** and **Done**. Raspberry Pi's [Getting started](https://www.raspberrypi.com/documentation/computers/getting-started.html) page shows each screen with pictures.

- **Device:** choose your Pi model.
- **OS:** choose **Raspberry Pi OS (64-bit)**, the version with the desktop. Not "Lite": Lite has no desktop, and you need one for the web browser and the kitchen screen.
- **Storage:** choose the microSD card. **Double-check that it is the card and not another drive: everything on it is erased.** Leave **Exclude system drives** switched on. It hides your laptop's own drives from the list.
- **Customisation:** fill this in; don't skip it. These settings match [step 1 of the install guide](../INSTALL-WITH-AI.md#step-1-put-the-system-on-the-card):
  - **Hostname:** `hub`. This is the Pi's name on your home network.
  - **Localisation:** Imager asks for a capital city and fills in the time zone and keyboard layout from it. Check both, and change the time zone if yours is different. The hub takes its time zone from the Pi later.
  - **User:** a username (lowercase letters and numbers) and a password. Keep the password to yourself. You type it into the Pi when a command asks for it.
  - **Wi-Fi:** your home network's name and password.
  - **Remote Access:** leave **Enable SSH** off. SSH lets another computer control the Pi over the network. This install doesn't use it.
  - **Raspberry Pi Connect:** if Imager shows it, leave it off. It is a service for reaching your Pi from outside your home, and the hub stays on your home network.
- **Writing:** check the summary and choose **Write**. Imager warns that it will erase the card. Confirm (**I understand, erase and write**) only if you chose the right card. Imager then writes the card and checks it. This can take a while.
- **Done:** choose **Finish**, then take the card out of the laptop.

**On a Mac:** after writing, macOS may say the disk is not readable. Choose **Ignore**. Don't choose Initialize: that would erase the card. Part of the card uses a Linux format that macOS can't read, and that is normal. **On Windows,** if it offers to format the card, choose Cancel, for the same reason.

## 3. Start the Pi

1. With the Pi unplugged, connect the screen (and its touch cable, if it has one) as the screen's instructions say.
2. Put the microSD card in the Pi's card slot.
3. Plug in the keyboard, and a mouse if you have one.
4. Plug in the power last. The Pi switches on by itself.

The first start takes a few minutes, and the Pi may restart once by itself. Wait for the desktop to appear. Because you filled in the settings in Imager, it should not ask setup questions. If it does, give the same answers you gave in Imager. If it shows a login screen, log in with the username and password you chose.

**Open the Terminal.** The Terminal is a window where you type commands for the Pi. Click the Raspberry Pi icon in the top-left corner of the screen to open the main menu, then choose **Accessories**, then **Terminal**. There may also be a Terminal button on the bar at the top of the screen.

**Open the web browser.** Click the web browser button on the bar at the top of the screen, or find the browser in the main menu. Raspberry Pi OS comes with Chromium and Firefox. Either one is fine.

Tip: put the browser and the Terminal side by side, so you can copy from one and paste into the other.

## 4. Terminal basics in five lines

- **Paste** into the Terminal with **Ctrl+Shift+V**. Plain Ctrl+V doesn't paste there.
- **Enter** runs the command you pasted. Wait until it finishes before the next one.
- When a command asks for your **password**, typing shows nothing, not even dots. That's normal: type it and press Enter.
- When a command asks `[Y/n]`, press **Enter** to answer yes.
- **Never type commands by hand.** Copy them from the browser, so no letter is wrong.

## 5. Install with your AI assistant

From here a chat AI guides you through [INSTALL-WITH-AI.md](../INSTALL-WITH-AI.md). That guide calls this **tier C**: the AI only chats, and you paste each command into the Pi's Terminal yourself. Nothing is installed for the AI on the Pi.

1. **Open your chat AI** in the Pi's web browser and sign in.
2. **Paste this prompt** from the guide's [Start here](../INSTALL-WITH-AI.md#start-here-what-to-tell-your-ai), together with the repository address:

   ```text
   Read this repo and install it on the Raspberry Pi I bought, set up for our family. Ask me whatever you need.
   https://github.com/thebrianlee/sproutwall
   ```

   A chat AI can't see your Pi, so the address matters. If your AI can't open web pages, paste the text of [INSTALL-WITH-AI.md](../INSTALL-WITH-AI.md) into the chat instead.

3. **The AI asks first** whether the card might hold another household's data, such as a hub that was set up before. It may not decide this itself. For the card you just wrote in section 2, tell it in your own words that the card is new.
4. **Then it asks at most five questions**, each once ([the five decisions](../INSTALL-WITH-AI.md#the-five-decisions)):
   - **Who runs the commands?** You, pasting into the Terminal (tier C). The AI may work this out itself.
   - **How does the screen hang?** Portrait (tall) is the usual choice for a kitchen wall. Landscape (wide), either one turned upside down, or no full-screen setup at all also work.
   - **Do you approve the install plan?** See the next point. It also asks you to confirm the home-network rule: this is your own router, it is not a guest or public network, nothing on the router forwards a port to the Pi (port forwarding lets the internet reach a device at home), and no tunnel or remote-access service exposes it.
   - **Your household:** the sample family or your own. You set this up yourself on the hub's screen (point 7).
   - **Which features show?** One screen during setup. **Skip, use recommended** keeps everything except Ask the Hub. Ask the Hub stays off unless you turn it on, because it sends the questions kids type to an AI service. You can change this later in Settings → Modules.
5. **The install plan comes before any password.** The AI shows every command that runs as administrator once, before the first one: what it does, why it is needed and how to undo it. These commands start with `sudo` ("run as administrator") and ask for the Pi's password in the Terminal. Read the plan, then say yes or ask questions. Your yes covers that plan only.
6. **One block at a time.** The AI gives you one block of commands. Copy it, paste it into the Terminal, press Enter and wait until it finishes. Then tell the AI only the short result it asks for, such as `64-bit OK`, `exit 0` or `healthy`. Don't paste long output, logs or screenshots.
7. **Household setup: you do this alone.** When the AI reaches this step, it waits and doesn't look. On the Pi's own screen, open the web browser at `http://localhost:3847` (the hub on this Pi). You see **Set up the house**:
   1. Pick **Set up my family**, or **Try it with the sample family** (the Calders, a made-up family) for a first look.
   2. **What should your wall show?** Choose, or tap **Skip, use recommended**.
   3. **The house:** names, the time zone (filled in from the Pi; keep it), the location for the weather (a nearby town center is close enough), and the **Parent PIN**, typed twice.
   4. Tap **Open the wall**. Then tell the AI only "done".

   Choose the PIN yourself and never tell it to the AI. It must be 4 to 8 digits. Easy PINs such as `1234`, `0000` or `7777` are refused. Use 6 or more digits if people you don't fully trust, such as guests, use your Wi-Fi. The README's [First-run setup](../README.md#first-run-setup) explains every field.

**What you will see on the way.** The AI follows the guide's steps:

- **Step 2:** a check that the Pi runs a 64-bit system.
- **Step 3:** system updates, then three tools: git (downloads the code), Docker (runs the hub in its own sealed box, called a container) and the GitHub CLI, `gh` (only checks the hub's download; it never signs in). Then a restart, and the code goes into a folder named `sproutwall`. Updates and downloads can take a while.
- **Step 4:** a check that the hub's ready-made app (the image) really was built by the project from the published code. Nothing starts unless this check passes.
- **Step 5:** the hub starts.
- **Step 6:** you set up the household (point 7 above). Then the AI asks you to open the hub on a phone: it must ask for the PIN and must not show the family.
- **Step 7:** the screen setup. The picture turns the way you chose, and you tap the corners to check touch.
- **Step 8:** a last check and a restart.

In steps 5, 6 and 8 the AI has you run a status check called `doctor`. On a home network, one check normally comes back `unknown`: `app_bind`, with the action `confirm_trusted_lan`. The Pi can't see inside your router, so it asks you to confirm the home-network rule. That one is expected. Any `fail`, or any other `unknown`, means stop, and the AI tells you what to do.

## 6. Never share

Never paste these into a chat, an issue or a screenshot, not even for the AI that is helping you:

- the parent PIN;
- the Pi's password;
- the Wi-Fi password;
- calendar links (the secret calendar addresses the hub reads);
- tokens and API keys (secret codes that let a program use an account).

Type them only into the hub's own screen, into the Terminal when a command asks, or into a service's own sign-in page.

Never run these, even if an AI suggests them:

- `docker compose down -v`: it deletes the household's data;
- `docker volume rm`: it can delete the household's data too;
- deleting the `sproutwall` folder: it is the hub's folder;
- anything that "turns off a check", skips the image check, turns the screen lock off or opens the hub to the internet.

If an AI suggests something that is not in the guide, stop and ask in [Discussions](https://github.com/thebrianlee/sproutwall/discussions) before you run it.

## 7. When it's done

- After the screen setup, the Pi restarts into the full-screen hub by itself. It asks once for the parent PIN to unlock this screen: type it yourself. The unlock lasts 30 days on that screen. From then on, the hub comes back by itself every time the Pi starts.
- **Tap the four corners and the center of the screen.** Each tap must land under your finger. If it doesn't, see section 8.
- Phones, tablets and laptops on the same Wi-Fi can open the hub too. The README's [Open it from a phone or tablet](../README.md#open-it-from-a-phone-or-tablet) shows how. Each new screen asks for the PIN once.
- Close the chat, and sign out of your chat AI in the Pi's browser.
- Keep the `sproutwall` folder. It is the hub's folder.
- For backups, and before any update, read [Existing install / update](../INSTALL-WITH-AI.md#existing-install--update). Don't use the README's update command on this install: it builds the hub differently.

## 8. If you get stuck

- **Copy the last lines the Terminal printed**, usually the error message, and remove any secrets first (see section 6). Never paste the hub's logs, config files or screenshots of the hub.
- **The safe status check.** Once step 3 has put the `sproutwall` folder on the Pi and the hub has started, run this. It only reads and changes nothing, and its output is safe to share by design:

  ```bash
  cd ~/sproutwall && ./scripts/sproutwall doctor --json --phase running --tier C
  ```

  Each check that does not pass names an action. [If something goes wrong](../INSTALL-WITH-AI.md#if-something-goes-wrong) explains each one.
- **Starting over** with a freshly written card (section 2) is often the fastest fix on a new setup. Do it only while the hub holds nothing you want to keep: writing the card erases everything on it.
- **Where to ask:** send an [install report](https://github.com/thebrianlee/sproutwall/issues/new?template=install_report.yml) (whether it worked or not), and ask questions in [Discussions](https://github.com/thebrianlee/sproutwall/discussions). Share only the status check's output: no logs, names or links. Report security problems privately, as [SECURITY.md](../SECURITY.md) says.

## 9. Undo

To go back to the setup the Pi had before:

1. If the hub is full screen, press **Alt+F4** on the keyboard to close it.
2. Shut the Pi down from the main menu (the Raspberry Pi icon in the top-left corner). When the screen goes dark, wait a few seconds, then unplug the power.
3. Swap the card for your old one and plug the power back in.

Your Sproutwall card keeps the hub and its household. Put it back in the same way to return to the hub.

- To stop the full-screen hub but keep the hub running for phones: [Undo the kiosk](../INSTALL-WITH-AI.md#undo-the-kiosk).
- If a Pi already runs Sproutwall, or to back up a hub you installed with this guide: [Existing install / update](../INSTALL-WITH-AI.md#existing-install--update).
