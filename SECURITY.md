# Security

Family Hub is a household appliance for your home network. This page says exactly what it protects and what it does not.

## Report a vulnerability

Open a private security advisory on this repository. Please do not file a public issue. Do not include calendar links, tokens, or family details in the report.

## Who can do what

- **Before setup:** the setup screen is open. Finish setup right after the first start. Once one setup succeeds, `/api/setup` refuses every later attempt.
- **Locked screens (`REQUIRE_AUTH_FOR_READS=1`, the Docker Compose default):** every page, API route and household image (photos, headshots, book covers) needs an unlocked screen. Built app files and the sample family's cartoon avatars are served without it. A screen unlocks with the parent PIN and then stays unlocked for 30 days (a device cookie). The only routes open without it are the unlock page, PIN submit, and a health check that returns only `{ok}`.
- **Open screens (`REQUIRE_AUTH_FOR_READS=0`):** anyone who can reach the port can read the household. The server logs a warning at startup when it runs this way. Use it only for a single screen that nobody else on the network can reach.
- **Kid actions** need an unlocked screen and no PIN. They are checking off routines, logging mood, reading and practice, lists, meals, adding events, picking goals and asking for rewards, editing routines, and Ask the Hub.
- **Parent actions** need the parent PIN. Entering it starts a 15-minute parent session on that screen (a separate parent cookie). The screens still ask for the PIN before each parent action. Parent actions are:
  - redeeming and pricing rewards;
  - rules, settings and status;
  - removing activities and deleting events;
  - calendar refresh and cover backfill.
  
  Any write route not listed as a kid action is parent-only by default. The route handlers check this again on their own, so the access layer (`src/proxy.ts`) is not the only gate.
- **Writes from other sites are refused.** Every write must be JSON with an `Origin` that matches the hub.

## How the PIN and cookies work

- There is no default PIN. Setup rejects short, repeated and straight-line PINs, including common keypad patterns.
- PINs are 4 to 8 digits and are stored as an scrypt hash.
- Wrong PINs are limited in layers. Each screen gets 5 free tries, then waits 1 minute, then 2, 4, 8 and at most 15 minutes per wrong try. Because a device can disguise which screen it is, two hub-wide ceilings do the real work: one for screens that are not unlocked yet, one for screens that are. 30 wrong tries within an hour lock PIN entry for that kind of screen for 15 minutes, and each repeat doubles the lock, up to 24 hours. Separately, once 60 wrong tries have been made in a day, however slowly, no PIN is checked for that kind of screen until 24 hours after the first of them. A lock only blocks typing the PIN: kids can still use an unlocked screen, and a stranger on your Wi-Fi cannot lock out the family's unlocked screens. That is at most 60 wrong guesses a day for each kind of screen (120 in all), so a determined person on your network could still guess a 4-digit PIN within weeks to months; choose 6 or more digits if the hub is reachable by people you don't trust. Known trade-off: someone on your network can keep re-tripping the limit for screens that are not unlocked yet, so a new screen may not unlock for up to a day; unlocked screens are unaffected. Restarting the hub clears a single screen's own wait (at most 15 minutes).
- There is deliberately no way to reset the PIN from the web page.
- The device and parent cookies are signed (HMAC), HttpOnly and SameSite=Strict. They are marked Secure when `PUBLIC_URL` starts with `https://`. Changing the PIN invalidates every cookie on every screen.
- **Plain http on a home network does not encrypt the PIN or the cookies.** Anyone who can watch your Wi-Fi traffic could capture them. For anything beyond a trusted home network, put the hub behind HTTPS (for example a private VPN such as WireGuard, or a reverse proxy with a certificate) and set `PUBLIC_URL`.

## Outbound requests

- **Calendar links:** must be public `http`, `https` or `webcal` addresses (`webcal` is fetched as `https`). The address check happens when the connection is made, so a name that resolves to a private, loopback, link-local or IPv4-mapped address is refused, including after a DNS change. Up to 3 redirects are followed, each checked the same way, and an `https` link is never followed to `http`. Responses are capped at 10 MB, and a response that is not a calendar counts as an error, so that person keeps their previous events. Links are stored on the hub.
- **Book covers:** downloaded only from Open Library, its archive.org storage, and Google Books. The download must be https, each redirect is re-checked, the response must be an image, and the size is capped at 5 MB.
- **Ask the Hub:** the bridge binds to `127.0.0.1` unless `BRIDGE_ALLOW_LAN=1`, and it refuses to start without a `BRIDGE_TOKEN` of at least 16 printable ASCII characters with no spaces.
  - The hub limits questions per minute, per day and at once (`ASK_MAX_PER_MINUTE`, `ASK_MAX_PER_DAY`).
  - Questions go to the provider you configure (Anthropic or Ollama). The prompt includes the child's age band (not the exact age), not their name, unless a parent turns on `ask_share_first_name`.
  - The bridge does not log question text. The hub stores questions and answers in its own database so the family can see them on the Ask tab.

## Files and secrets

- Photos, avatars and covers are served only by strict file names from their folders. A symlink that points outside its folder is refused, and the file is opened without following a symlink, so one swapped in after the check is refused too. Cover downloads replace the file by renaming a new one into place, never writing through what is there. A local process that can already write to the data folder is out of scope.
- `SESSION_SECRET` and `BRIDGE_TOKEN` are generated into the data volume on first start (mode 0600). Each file is written in full under a temporary name and then linked into place, so a second process starting at the same time never reads a half-written secret. A secret must be printable ASCII with no spaces or control characters, in a file or in the environment. A corrupt or short secret file stops startup with a clear message, rather than being used silently.

## What you should do when you host it

- Do not publish port 3847 on the public internet. Keep it on the home network, or use a VPN.
- Treat calendar links as secrets.
- Keep `REQUIRE_AUTH_FOR_READS=1` unless the screen is truly private.
- The parent PIN is a gate for a shared screen. It is not a substitute for disk encryption or an account system.

## Optional sign-in

Per-person accounts (for example Google sign-in) are not implemented. The parent PIN is the access control in this version.
