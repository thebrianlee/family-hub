#!/usr/bin/python3 -I
"""Sproutwall kiosk launcher.

`sproutwall setup kiosk` installs a copy of this file as
~/.local/bin/sproutwall-kiosk and starts it from the desktop's labwc
autostart. Python 3 standard library only; it imports nothing from the
repository, so the copy keeps working if the checkout moves.

What it does, as the logged-in desktop user (never root):
1. Takes a lock in the state folder's run/ (made by setup), so only one
   launcher runs; exits if a kiosk browser with its profile is already open.
2. Polls http://127.0.0.1:3847/api/health: a 3 s socket timeout and a 5 s
   deadline for the whole request. Redirects are never followed (a 3xx is
   "not ready"). The hub is ready only on HTTP 200 with a JSON body whose
   "ok" is true.
3. Polls every 2 s for the first minute, then every 10 s. After 90 s without
   a ready hub it shows a local page that says the hub is starting, and
   keeps polling every 10 s.
4. When the hub is ready, closes that page and starts one Chromium in kiosk
   mode at http://127.0.0.1:3847 with the persistent profile setup made. No
   incognito (the screen's unlock lives in that profile), no sandbox bypass
   and no remote debugging.
5. Exits when that Chromium exits; the next login starts it again. On
   SIGTERM (`setup kiosk --off` or `--undo`) it closes Chromium and exits.

It needs no Docker access: only the hub's health address on loopback.

Like scripts/sproutwall, it is guarded: any failure prints one fixed line
to stderr (never a traceback, path or error text), stops any Chromium it
started, and exits 1.
"""

import sys

FAILED = "sproutwall-kiosk: stopped by an unexpected error.\n"
NOT_SET_UP = "sproutwall-kiosk: the kiosk is not set up here. Run ./scripts/sproutwall setup kiosk.\n"

if __name__ == "__main__":
    sys.dont_write_bytecode = True
    import warnings

    warnings.simplefilter("ignore")

try:
    import fcntl
    import http.client
    import json
    import os
    import signal
    import stat
    import threading
    import time
    import urllib.parse
except BaseException:  # noqa: BLE001 - before the guard exists
    if __name__ == "__main__":
        sys.stderr.write(FAILED)
        sys.exit(1)
    raise

HUB_HOST = "127.0.0.1"
HUB_PORT = 3847
HUB_URL = "http://127.0.0.1:3847/"
HEALTH_PATH = "/api/health"
HEALTH_TIMEOUT_S = 3.0
HEALTH_DEADLINE_S = 5.0
MAX_BODY = 64 * 1024
FAST_INTERVAL_S = 2.0
FAST_PERIOD_S = 60.0
SLOW_INTERVAL_S = 10.0
HINT_AFTER_S = 90.0
STOP_GRACE_S = 10.0

# Same values as sproutwall_lib/kiosk.py, kiosk_files.py and kiosk_detect.py
# (a test checks).
STATE_DIR = os.path.join(".local", "state", "sproutwall", "kiosk")
RUN_DIR = "run"
BROWSER_PROFILE = "browser"
LOCK_FILE = "launcher.lock"
WAIT_PAGE = "starting.html"
CHROMIUM_CANDIDATES = ("/usr/bin/chromium", "/usr/bin/chromium-browser")
NOFOLLOW = os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)

WAIT_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sproutwall is starting</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
font:24px/1.5 sans-serif;background:#f6f4ee;color:#2d3a2e;text-align:center}
main{max-width:32em;padding:2em}h1{font-size:1.6em}</style></head>
<body><main><h1>Sproutwall is starting</h1>
<p>This screen checks again every few seconds and opens the hub by itself when it is ready.</p>
<p>If this stays for more than ten minutes, check the hub from a phone on the home Wi-Fi,
or run <code>./scripts/sproutwall doctor --phase running</code> in the hub's folder on this Pi.</p>
</main></body></html>
"""

# Every Chromium this process started, so the guard can stop them.
STARTED = []


class NotSetUp(Exception):
    pass


# --- pure decisions (unit-tested) -------------------------------------------------


def health_verdict(status, body):
    """True only for HTTP 200 with a JSON object whose "ok" is exactly true."""
    if status != 200 or not isinstance(body, (bytes, bytearray)) or len(body) > MAX_BODY:
        return False
    try:
        data = json.loads(bytes(body).decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return False
    return isinstance(data, dict) and data.get("ok") is True


def next_delay(elapsed):
    """Seconds until the next health poll: bounded, never below 2 s."""
    return FAST_INTERVAL_S if elapsed < FAST_PERIOD_S else SLOW_INTERVAL_S


def decide(elapsed, healthy, hint_shown):
    """"open_hub", "show_hint" or "wait"."""
    if healthy:
        return "open_hub"
    if not hint_shown and elapsed >= HINT_AFTER_S:
        return "show_hint"
    return "wait"


def chromium_argv(binary, profile, url):
    return [
        binary,
        "--kiosk",
        "--no-first-run",
        "--noerrdialogs",
        "--disable-infobars",
        # After a power cut, open the page without a "restore pages?" bubble.
        "--hide-crash-restore-bubble",
        # Autologin never unlocks the desktop keyring; without this Chromium
        # can stop at a keyring password prompt. The profile is private (0700).
        "--password-store=basic",
        "--user-data-dir=" + profile,
        url,
    ]


# --- host access -------------------------------------------------------------------

EXPECTED_HEALTH_ERRORS = (OSError, http.client.HTTPException, ValueError)


def check_health(connect=None, timeout=HEALTH_TIMEOUT_S, deadline=HEALTH_DEADLINE_S):
    """One GET of the health address, with a deadline for the whole request.

    The request runs in a helper thread; if connect, headers and body
    together take longer than deadline (a server that trickles bytes), the
    connection is closed and the answer is "not ready". http.client never
    follows redirects, so a 3xx is just "not ready". connect(host, port,
    timeout) makes the connection (tests pass a fake). Connection failures
    are "not ready"; anything unexpected is raised here, in the caller."""
    connect = connect or http.client.HTTPConnection
    box = {}

    def attempt():
        try:
            conn = connect(HUB_HOST, HUB_PORT, timeout=timeout)
            box["conn"] = conn
            try:
                conn.request("GET", HEALTH_PATH, headers={"Accept": "application/json"})
                resp = conn.getresponse()
                box["ok"] = health_verdict(resp.status, resp.read(MAX_BODY + 1))
            finally:
                conn.close()
        except BaseException as error:  # noqa: BLE001 - handed to the caller below
            box["error"] = error

    worker = threading.Thread(target=attempt, name="health", daemon=True)
    worker.start()
    worker.join(deadline)
    if worker.is_alive():
        conn = box.get("conn")
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - the answer is "not ready" either way
                pass
        return False
    error = box.get("error")
    if error is not None:
        if isinstance(error, EXPECTED_HEALTH_ERRORS):
            return False
        raise error
    return box.get("ok", False)


def find_chromium():
    for path in CHROMIUM_CANDIDATES:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def browser_running(profile):
    """True if a process of this user already runs with this browser profile."""
    flag = ("--user-data-dir=" + profile).encode("utf-8", "surrogateescape")
    uid = os.getuid()
    for name in os.listdir("/proc"):
        if not name.isascii() or not name.isdigit():
            continue
        try:
            if os.stat("/proc/" + name).st_uid != uid:
                continue
            with open("/proc/%s/cmdline" % name, "rb") as handle:
                args = handle.read(64 * 1024).split(b"\0")
        except OSError:
            continue  # exited meanwhile, or not ours
        if flag in args:
            return True
    return False


def _folder(path):
    """A real folder that setup made, or NotSetUp."""
    try:
        st = os.lstat(path)
    except FileNotFoundError as error:
        raise NotSetUp() from error
    if not stat.S_ISDIR(st.st_mode):
        raise NotSetUp()


def stop_children():
    """Terminate, then kill, every Chromium this process started."""
    for child in list(STARTED):
        try:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(STOP_GRACE_S)
                except Exception:  # noqa: BLE001 - a browser that ignores SIGTERM
                    child.kill()
                    child.wait(5)
        except BaseException:  # noqa: BLE001 - keep stopping the others
            pass


class Launcher:
    def __init__(self, home):
        self.state = os.path.join(home, STATE_DIR)
        self.run_dir = os.path.join(self.state, RUN_DIR)
        self.profile = os.path.join(self.state, BROWSER_PROFILE)
        self.child = None
        self.stopping = False

    def on_signal(self, signum, frame):
        self.stopping = True
        self.stop_child()

    def stop_child(self):
        child, self.child = self.child, None
        if child is None or child.poll() is not None:
            return
        child.terminate()
        try:
            child.wait(STOP_GRACE_S)
        except Exception:  # noqa: BLE001 - a browser that ignores SIGTERM
            child.kill()
            child.wait()

    def start(self, binary, url):
        import subprocess

        self.child = subprocess.Popen(
            chromium_argv(binary, self.profile, url),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        STARTED.append(self.child)

    def wait_page_url(self):
        path = os.path.join(self.run_dir, WAIT_PAGE)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(WAIT_HTML)
        return "file://" + urllib.parse.quote(path)

    def sleep(self, seconds):
        end = time.monotonic() + seconds
        while not self.stopping and time.monotonic() < end:
            time.sleep(min(0.5, max(0.0, end - time.monotonic())))

    def run(self):
        _folder(self.state)
        _folder(self.run_dir)
        _folder(self.profile)
        lock_fd = os.open(os.path.join(self.run_dir, LOCK_FILE), os.O_WRONLY | os.O_CREAT | NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0  # another launcher is already running
            return self.run_locked()
        finally:
            os.close(lock_fd)

    def run_locked(self):
        if browser_running(self.profile):
            return 0  # a kiosk browser from this launcher is already open
        binary = find_chromium()
        if binary is None:
            return 1
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, self.on_signal)
        started = time.monotonic()
        hint_shown = False
        while not self.stopping:
            elapsed = time.monotonic() - started
            action = decide(elapsed, check_health(), hint_shown)
            if action == "open_hub":
                self.stop_child()
                if self.stopping:
                    break
                self.start(binary, HUB_URL)
                while not self.stopping and self.child is not None and self.child.poll() is None:
                    self.sleep(1.0)
                break
            if action == "show_hint":
                hint_shown = True
                self.start(binary, self.wait_page_url())
            self.sleep(next_delay(elapsed))
        self.stop_child()
        return 0


def main():
    if os.geteuid() == 0:
        return 1  # never as root
    return Launcher(os.path.expanduser("~")).run()


# --- the guard (as in scripts/sproutwall) -------------------------------------------------


def fail_safe(line=FAILED):
    """Stop any Chromium this process started, print one fixed line, return 1."""
    stop_children()
    try:
        sys.stderr.write(line)
        sys.stderr.flush()
    except BaseException:  # noqa: BLE001 - nothing more can be said safely
        pass
    return 1


def _exit_now(*_args):
    fail_safe()
    os._exit(1)


def install_guards():
    sys.excepthook = _exit_now
    sys.unraisablehook = lambda _unraisable: None
    threading.excepthook = _exit_now


def guarded_main():
    try:
        install_guards()
        code = main()
    except SystemExit as exit_request:
        code = exit_request.code if isinstance(exit_request.code, int) or exit_request.code is None else fail_safe()
    except NotSetUp:
        code = fail_safe(NOT_SET_UP)
    except BaseException:  # noqa: BLE001 - fixed output only
        code = fail_safe()
    return code


if __name__ == "__main__":
    sys.exit(guarded_main())
