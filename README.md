# Sproutwall

**Install:** [guided, with or without an AI assistant](INSTALL-WITH-AI.md) · [manual install](#install-at-home)

New to Raspberry Pi? Start with [the step-by-step guide](docs/INSTALL-BEGINNERS.md).

> **Early preview.** Sproutwall started as one family's kitchen screen and runs there every day, but the guided install is new. We have tested the tier C guided install several times in fresh Debian 13 arm64 VMs, most recently with household setup and the screen unlock done through the screen itself. We haven't tested the guided install on a Raspberry Pi yet. If you try it, please tell us how it went with an [install report](https://github.com/thebrianlee/sproutwall/issues/new?template=install_report.yml), whether it worked or not. Bugs are welcome as [issues](https://github.com/thebrianlee/sproutwall/issues/new/choose), and ideas and questions in [Discussions](https://github.com/thebrianlee/sproutwall/discussions).

Sproutwall (formerly Family Hub) is a family dashboard for a screen in your kitchen. It shows the day at a glance: weather, the family calendar, routines, meals, lists, a reading shelf, a points jar (Family Bucks), and Ask the Hub, a question wall for kids. It runs on a computer in your home, such as a Raspberry Pi, and keeps the household's data on that computer. There is no cloud account and no subscription.

Turn features on or off in Settings → Modules.

![The Today screen, showing the fictional Calder family](docs/screenshots/today.png)

The screenshots show the Calders, a made-up sample family. They are not a real household.

**Contents:**
[Install at home](#install-at-home) ·
[Keep it safe](#keep-it-safe) ·
[Back up and update](#back-up-and-update) ·
[Forgot the PIN](#forgot-the-pin) ·
[Ask the Hub](#ask-the-hub) ·
[Calendars](#calendars) ·
[Photos](#photos) ·
[Raspberry Pi](#raspberry-pi) ·
[For developers](#for-developers) ·
[Contributing](#contributing) ·
[License](#license)

## Install at home

New to Raspberry Pi, the Terminal or GitHub? The [step-by-step guide for beginners](docs/INSTALL-BEGINNERS.md) takes you from a blank card to the hub on your kitchen screen, with a chat AI.

### What you need

- A computer that stays on: a Linux PC, a Mac, a Windows PC with Docker Desktop, or a Raspberry Pi 4 or 5 ([Pi guide](docs/raspberry-pi.md)).
- [Docker](https://docs.docker.com/get-docker/) with Compose. Check with `docker compose version`.
- [git](https://git-scm.com/downloads), to download Sproutwall and get updates.

### Start it

Open a terminal and run:

```bash
git clone https://github.com/thebrianlee/sproutwall.git sproutwall
cd sproutwall
docker compose up -d --build
```

This makes a folder named `sproutwall`, the hub's folder. The commands on this page run there. Installed before the rename? See [Installed before the rename](#installed-before-the-rename).

The first start builds the app. That takes a while, and much longer on a Raspberry Pi. `-d` keeps it running in the background. It starts again by itself after a reboot, as long as Docker starts at boot.

Check that it is running:

```bash
docker compose ps
```

After a short wait the status says `healthy`. If something goes wrong, `docker compose logs` shows what happened.

### Open it from a phone or tablet

The hub uses port 3847.

- On the computer that runs it: <http://localhost:3847>
- On a phone, tablet or laptop on the same Wi-Fi: `http://<lan-ip>:3847`, for example `http://192.168.1.50:3847`

To find the computer's LAN address (`<lan-ip>`):

- Linux or Raspberry Pi: run `hostname -I`. Use the first number.
- Mac: System Settings, then Wi-Fi, then Details next to your network.
- Windows: run `ipconfig` and look for "IPv4 Address".

Tips:

- Ask your router to always give this computer the same address (often called a "DHCP reservation"). Otherwise the address can change and the bookmark on your phone stops working.
- Some devices can also use the computer's name, for example `http://hub.local:3847`. This may not work on every phone.
- Use `http://`, not `https://`, unless you set up HTTPS yourself (see [Keep it safe](#keep-it-safe)).

### First-run setup

The first visit shows **Set up the house**. Finish it right away. Until setup is done, anyone on your network who opens the page could choose the PIN. After the first setup succeeds, the setup page is closed for good.

**Your family.** Choose one:

- **Try it with the sample family** keeps the Calders, a made-up family, with their sample routines, events and points. Good for a first look.
- **Set up my family** asks for 1 to 8 kids and 1 to 4 parents. Each kid has a name, an age (0 to 18), and a **Doesn't read yet** box for kids who need bigger pictures and fewer words. Each parent has a name. Everyone gets a color from a fixed set. The sample family and everything of theirs is removed.

You can change the family later in [Settings](#parent-settings), including starting over.

**The house:**

- **Household name**, **Greeting name**, and **Points name** (what the kids earn, for example "Family Bucks").
- **Timezone.** It is filled in from the device you are using. Use a name like `America/Chicago` or `Europe/Berlin`. The hub keeps its clock and "today" in this timezone, also inside Docker.
- **Latitude** and **Longitude** for the weather. The sample values point at a city downtown, not a home. A nearby town center is close enough. Weather comes from [Open-Meteo](https://open-meteo.com/) and is shown in °F.
- **Parent PIN**, typed twice.

PIN rules:

- 4 to 8 digits. There is no default PIN.
- Easy PINs are refused: well-known ones like `1234`, `0000`, `1212` and `2580`, the same digit over and over (`7777`), and straight runs up or down (`3456`, `9876`).
- Choose 6 or more digits if people you don't fully trust can reach the hub, for example guests on your Wi-Fi. A 4-digit PIN can be guessed in time (see the wrong-PIN limits below).
- The hub stores only a scrambled form of the PIN (an scrypt hash). Nobody can read it back. If you forget it, see [Forgot the PIN](#forgot-the-pin).

### Unlocking each screen

With Docker, every screen is locked until a parent unlocks it. That is the `REQUIRE_AUTH_FOR_READS: "1"` line in `docker-compose.yml`.

| | What it allows | How long it lasts |
| --- | --- | --- |
| **Screen unlock** | Seeing the hub, and kid actions: checking off routines, logging mood, reading and practice, lists, meals, adding events, picking goals, asking for rewards, editing routines, and Ask the Hub. | 30 days on that screen and browser. |
| **Parent actions** | Redeeming and pricing rewards, rules and status, deleting events, removing activities, and everything in [Settings](#parent-settings). | The hub asks for the PIN each time. Behind the scenes, a correct PIN opens a 15-minute parent session on that screen only. |

- The first time a new screen opens the hub, it shows **Unlock this screen**. Enter the parent PIN once. Entering the PIN again later, for example for a parent action, starts a fresh 30 days.
- The unlock belongs to one browser on one device. A private or incognito window, or clearing the browser's cookies, asks again.
- Resetting the PIN locks every screen. Changing it in Settings locks every screen except the one used to change it. Each locked screen asks for the new PIN.

**Wrong PINs.** The hub slows down guessing in layers:

- Each screen gets 5 tries. After that it must wait 1 minute, then 2, 4, 8, and at most 15 minutes after each wrong try.
- A device can pretend to be a new screen, so two hub-wide limits do the real work: one for screens that are not unlocked yet, and one for screens that are. 30 wrong tries in one hour lock PIN entry for that kind of screen for 15 minutes, and each repeat doubles the wait, up to 24 hours. Once 60 wrong tries have been made in a day, however slowly, PIN entry for that kind of screen stays locked until 24 hours after the first of them.
- A lock only stops people typing the PIN. Kids can keep using an unlocked screen, and a stranger on your Wi-Fi cannot lock the family's unlocked screens.
- That allows at most 60 wrong guesses a day for each kind of screen (120 in all). A 4-digit PIN could still be guessed within weeks to months, which is why 6 or more digits are safer.
- Someone on your network who keeps guessing can keep *new* screens from being unlocked for a day at a time. Screens that are already unlocked are not affected.
- [Resetting the PIN](#forgot-the-pin) clears the hub-wide locks. A single screen that is waiting out its own wrong tries (at most 15 minutes) keeps waiting until the hub restarts.

### Parent settings

Tap the gear button in the tab bar to open **Settings** (the page is `/settings`). It asks for the parent PIN. Tap **Done** when you finish: it ends the parent session on that screen. Typing is easier from a phone or laptop on your home Wi-Fi: open the same page there.

- **Household:** household name, greeting, the name for points, timezone (with a **Use this device's timezone** button), and latitude and longitude for the weather.
- **Family:** change a person's name, age, **Doesn't read yet** box or color; add a kid or a parent; or remove someone. Removing hides the person and keeps their history, but deletes their calendar link and calendar events. The hub always keeps at least one kid and one parent. **Start over with a different family** replaces everyone, with their routines, points, books, calendar links and history, after you confirm. Family-wide rewards, meals, lists and rules stay.
- **Calendars:** a link for each person and one for the kids' shared calendar. See [Calendars](#calendars).
- **Ask the Hub privacy:** the switch that sends kids' first names with their questions. See [Ask the Hub](#ask-the-hub).
- **Parent PIN:** change the PIN. It needs the current PIN and signs out every other screen.

The parent session lasts 15 minutes. If it ends while you are in Settings, the PIN keypad comes back: enter the PIN and tap **Save** again. What you typed is kept.

## Keep it safe

Sproutwall is built for a trusted home network. The short version:

- **It is a home-network appliance.** Anyone who can reach port 3847 sees the unlock screen and can try PINs. Only devices in your home should be able to reach it.
- **Never port-forward it.** Do not open port 3847, or any port that leads to it, on your router. Do not run it on a public server.
- **For access from outside the house,** use a private VPN such as WireGuard, or a reverse proxy with HTTPS. With HTTPS, set `PUBLIC_URL` (see [Settings outside the app](#settings-outside-the-app)) so the unlock cookies are marked Secure. The proxy must pass the original `Host` (or `X-Forwarded-Host`) header, or the hub refuses changes as cross-site. It should also pass `X-Forwarded-For`, so each screen gets its own wrong-PIN count.
- **Plain `http://` does not encrypt anything.** On home Wi-Fi the PIN and the unlock cookies travel unencrypted. Someone who can watch your network traffic could copy them.
- **Docker gets around your firewall.** On Linux, ports that Docker publishes bypass `ufw` and `firewalld` rules. To limit who can connect, [bind the port to one address](#limit-who-can-connect) instead of relying on firewall rules.
- **Keep screens locked.** `REQUIRE_AUTH_FOR_READS: "0"` lets anyone who can reach the port read the household. Use it only for a single screen that nobody else on the network can reach.
- **Treat calendar links and backups as secrets.** A secret iCal link lets anyone read that calendar. A backup holds the household database and the hub's secret keys.

Kids' data stays on your computer. The one exception is Ask the Hub, and only if you turn it on (see [Ask the Hub](#ask-the-hub)).

Running your own copy for your own family is different from running it as a service for other families. Someone who hosts Sproutwall for other households takes on legal duties, such as COPPA for children's data in the US. This is not legal advice.

[SECURITY.md](SECURITY.md) has the full details and says how to report a security problem privately.

There are no per-person accounts. Google sign-in is not built. The parent PIN is the access control in this version. Sign-in may come later as an option that is off by default.

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

## Back up and update

### Back up

Run these in the hub's folder. The hub stops for a moment so the database is saved in a consistent state.

```bash
docker compose stop
docker compose run --rm -T --entrypoint tar family-hub czf - -C / data photos > sproutwall-backup.tgz
docker compose start
```

`sproutwall-backup.tgz` now holds the whole household (the Docker volume whose name ends in `familyhub-data`) and your `photos` folder. Copy it somewhere safe, such as a USB stick. Keep it private: it holds the database and the hub's secret keys.

### Restore

On the same computer, or on a new one after the [install steps](#start-it). Restoring replaces the household on this computer with the one in the backup, so back up first if the hub holds anything you want to keep.

```bash
docker compose stop
docker compose run --rm -T --entrypoint sh family-hub -c 'rm -f /data/sproutwall.db* /data/family-hub.db* && tar xzf - -C /' < sproutwall-backup.tgz
docker compose start
```

The `rm` first removes the hub's current database and its temporary side files, so only the database from the backup is left. This also works with a backup made before the rename to Sproutwall (`family-hub-backup.tgz`, which holds `family-hub.db`). The hub's automatic safety copies (the volume's `backups` folder, made before each database upgrade) are not removed by a restore. After a restore they can still hold the household that was on this computer before; if that household should not stay on this computer, delete that folder once the restored hub works: `docker compose exec family-hub sh -c 'rm -rf /data/backups'`.

### Update

Back up first. Then, in the hub's folder:

```bash
git pull && docker compose up -d --build --remove-orphans
```

Your household data stays in its Docker volume (`docker volume ls` shows a name ending in `familyhub-data`). The hub updates its database by itself when it starts. Before it changes the database, it saves a copy in the volume's `backups` folder and keeps the last five.

### Installed before the rename

Sproutwall used to be called Family Hub. If you installed it then, there is nothing to change:

- Keep using your `family-hub` folder, and update with the command above. GitHub forwards the old address.
- The hub keeps using your existing database (`family-hub.db`), volume and commands.
- Do not clone the project again into a new folder. Docker names the data volume after the folder, so a new folder starts with an empty household. To move to a new folder anyway, [back up](#back-up) in the old folder, then [restore](#restore) in the new one.

## Forgot the PIN

There is no way to reset the PIN from the web page. That is on purpose. On the computer that runs the hub, in the hub's folder, run:

```bash
docker compose exec family-hub node scripts/reset-pin.mjs 4827
```

Use your own new PIN instead of `4827`. The same PIN rules apply. Every screen then asks for the new PIN. If a screen still says to wait after too many wrong tries, restart the hub with `docker compose restart`.

Without Docker, run `npm run reset-pin -- 4827` in the project folder.

## Ask the Hub

Kids type a question and get a short, kid-friendly answer. It is **off until a parent turns it on**. Until then, questions are saved on the Ask tab with a note that no model is connected.

### Turn it on

Pick one and add it as described in [Settings outside the app](#settings-outside-the-app):

- **Claude:** set `ANTHROPIC_API_KEY` to your own key from Anthropic. You pay for what the family asks.
- **A local model:** set `OLLAMA_URL` to an Ollama server, for example `http://192.168.1.60:11434` for Ollama on another computer. That Ollama must accept connections from the network. On a Raspberry Pi a local model is likely to be very slow (see the [Pi guide](docs/raspberry-pi.md#ask-the-hub-is-slow-or-does-not-answer)).

Then run `docker compose up -d`.

### What is sent, and where

- **Where:** to Anthropic's API (`api.anthropic.com`) when `ANTHROPIC_API_KEY` is set. Otherwise to your Ollama server. If Claude fails and `OLLAMA_URL` is also set, the question goes to Ollama instead.
- **Each question:** the question text (up to 500 characters), the hub's safety rules, and the child's age band (under 6, 6-7, 8-12, or 13 or older) or "very young, may not read yet". The exact age is not sent. A question asked as a guest sends no age.
- **Names:** the child's first name is **not** sent, unless a parent turns on first-name sharing (below).
- **Daily tiles:** when a model is connected, the hub also asks it to write the daily quote, fact, mindset prompt and dinner question for the next few days. Those requests contain dates and the quotes already shown. They contain no family data.
- **What stays home:** every question and answer is saved in the hub's own database and shown on the Ask tab of any unlocked screen. The bridge that talks to the model does not log question text.
- **Limits:** at most 6 questions a minute, 100 a day, and 2 at the same time (`ASK_MAX_PER_MINUTE`, `ASK_MAX_PER_DAY`). A model that takes longer than 40 seconds counts as no answer.

### Share first names (optional)

Kids' first names are not sent unless you turn this on. In [Settings](#parent-settings), under **Ask the Hub privacy**, tick **Include the child's first name so answers can be personal**. Untick it to stop.

## Calendars

Sproutwall shows each person's calendar from a secret iCal link. It only reads. Events added on the wall stay on the wall.

### Add a link

1. **Find the link.** In Google Calendar, open the calendar's settings and copy **Secret address in iCal format**. In Apple Calendar, share the calendar as a public calendar and copy its `webcal://` link. Other calendar apps call it a published or shared `.ics` link.
2. Open [Settings](#parent-settings) and go to **Calendars**. Each person has a row, and there is one more row for the **Kids' shared calendar**.
3. Paste the link into the person's row and tap **Save**. The hub fetches the link once to check it is a calendar before saving it.
4. After saving, the row shows only **Linked** and the calendar service's name, for example `calendar.google.com`. The full link is never shown again. To change it, paste a new link. To stop using it, tap **Remove**: the events it brought in are removed with it.

If Settings says the link sends the hub somewhere it won't follow (more than 3 redirects, or from `https://` down to `http://`), copy the final secret address from your calendar app and paste that instead.

**Kids' shared calendar.** One calendar can hold all the kids' events. An event whose title starts with a kid's name and a dash or colon, like "Riley - Swim" or "Riley: Swim", goes to that kid only. Other events go to every kid. The names come from your Family list. If one kid's name starts another's, like "Jo" and "Jo-Ann", the longer name wins.

### How it works

- **How often:** the hub checks the links about every 15 minutes while a screen shows Today or Calendar, and right after you save a new link. It shows events from 2 weeks back to about 4 months ahead.
- **Which links:** `https://`, `webcal://` (treated as `https://`) and plain `http://` addresses on the public internet. Links to private network addresses are refused.
- **Redirects:** the hub follows up to 3 redirects and checks each new address the same way. It never follows an `https://` link to a plain `http://` one.
- **Size:** calendars larger than 10 MB are refused. A repeating event shows at most its first 500 times in that window, and one calendar at most its first 5,000 entries.
- **When a link stops working:** if the answer is not a calendar (for example an expired-link page or a sign-in page), the hub treats it as an error. That person keeps the events the hub already had until the link works again.

## Photos

The screensaver shows your photos. It starts after 10 idle minutes, or when someone taps the moon button.

- Put `.jpg`, `.jpeg`, `.png` or `.webp` files in the `photos` folder inside the hub's folder.
- Use file names with only letters, numbers, dots, dashes and underscores. Files with spaces or other characters in the name are skipped.
- New photos show up without a restart.
- Without photos, the screensaver shows quotes.

**Headshots.** Each person can have a square JPEG photo named `<member id>.jpg` in the `avatars` folder of the data volume:

```bash
docker compose exec family-hub mkdir -p /data/avatars
docker compose cp riley.jpg family-hub:/data/avatars/riley.jpg
```

A person's member id comes from their name when they are added:

- lowercase, accents removed, and dashes instead of spaces and other characters, up to 24 characters. "Ana Lucía" becomes `ana-lucia`;
- a name that starts with a digit gets `m-` in front;
- a name with no Latin letters at all (for example one written only in Korean or Arabic script) becomes `member`;
- if the id is taken, or is one of the reserved words `guest`, `auto` and `px`, the hub adds `-2`, `-3` and so on;
- the sample family's ids are `riley`, `quinn`, `sam`, `avery` and `jordan`.

Without a headshot, the sample family shows cartoon avatars, and everyone else shows the first letter of their name in a circle.

## Raspberry Pi

A Raspberry Pi 4 or 5 with a touchscreen makes a good kitchen hub. The [Raspberry Pi guide](docs/raspberry-pi.md) walks through it step by step: flashing the card, installing Docker, starting the hub, and running the screen full screen at boot.

## For developers

Requirements: Node.js 22 (`engines` says `>=22`; CI and the Docker image use 22). If `better-sqlite3` has no prebuilt binary for your platform, you also need `python3`, `make` and a C++ compiler.

```bash
npm ci
cp .env.example .env
npm run dev
```

`npm run dev` (`scripts/dev.mjs`) starts the web app on port 3847 (listening on all interfaces) and the Ask the Hub bridge on `127.0.0.1:8787`. Missing secrets are generated into `data/` (`session-secret`, `bridge-token`), which git ignores. The database is `data/sproutwall.db` (`data/family-hub.db` in a checkout from before the rename). `.env.example` sets `REQUIRE_AUTH_FOR_READS=0`, so screens are not locked in development. Open <http://127.0.0.1:3847>.

Checks (CI runs all of them in one job named `check`):

```bash
npm run lint -- --max-warnings 0
npm run typecheck
npm test
npm run build
node scripts/check-pii.mjs
```

Other scripts: `npm run bridge` starts only the bridge, and `npm run reset-pin -- <PIN>` resets the PIN in `data/`.

**Next.js 16.** This is not the Next.js in older tutorials. APIs and file conventions changed. For example, request middleware is now `src/proxy.ts` (the `middleware` file convention was renamed to `proxy`). Read the guide for what you are changing in `node_modules/next/dist/docs/` first. See [AGENTS.md](AGENTS.md).

### Project layout

| Path | What is there |
| --- | --- |
| `src/app/<screen>/page.tsx` | Screens: `today`, `calendar`, `my-day` (Routines), `meals`, `lists`, `ask`, `reading`, `balance`, `level-up`, `progress`, `unlock` |
| `src/app/settings/` | The parent Settings screen (household, family, calendars, Ask privacy, PIN change) |
| `src/app/api/` | Route handlers. Routes with parent-only actions check the parent session again themselves (`src/lib/guard.ts`). Parent settings are `src/app/api/settings/parent/`. |
| `src/proxy.ts` | Access policy for every request: same-origin writes, screen unlock, kid writes vs parent writes |
| `src/lib/session.ts`, `guard.ts`, `auth.ts` | Signed device (30 days) and parent (15 minutes) cookies, route-level checks, PIN hashing |
| `src/lib/pin-attempts.ts`, `weak-pin.ts` | Wrong-PIN limits (per screen, plus two hub-wide ceilings) and PIN rules |
| `src/lib/safe-next.ts` | Keeps the after-unlock redirect on this hub |
| `src/lib/household.ts` | The `members` table: validation, member ids, add, hide, replace the household |
| `src/lib/member-theme.ts` | The member color palette and per-member CSS variables |
| `src/lib/household-settings.ts` | Validation and saving for parent settings, including the calendar-link check |
| `src/lib/family.ts` | Member types and the household model shared with the client |
| `src/lib/safe-fetch.ts` | Outbound fetch guard (public addresses only, size caps) used for calendars and covers |
| `src/lib/ics.ts`, `calendar.ts` | iCal import (redirects, shared kids' feed) and the calendar model |
| `src/lib/db.ts` | SQLite schema, migrations and the sample family seed |
| `src/lib/queries.ts` | Most data access (ledger, routines, meals, books). Large; planned to be split by domain. |
| `src/lib/paths.ts` | Where files live (`DATA_DIR`, `PHOTO_DIR`) |
| `src/components/` | UI components, including `PersonEditor.tsx` (one person's name, age, reading box and color) and `MembersProvider.tsx` (the household for client components) |
| `bridge/` | Ask the Hub bridge (`ask-bridge.mjs`) and its prompts (`prompt.mjs`) |
| `scripts/` | Dev and production start, secret generation, `reset-pin`, the PII check |
| `Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml` | Container build and start |
| `tests/` | Vitest tests. `tests/setup.ts` gives each test file its own temporary data folder. |
| `docs/` | This guide's longer pages and the [skills proposal](docs/architecture/skills.md) |

## Contributing

Contributions are welcome, including small ones. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
