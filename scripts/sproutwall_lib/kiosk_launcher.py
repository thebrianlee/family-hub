#!/usr/bin/python3 -I
"""Sproutwall kiosk launcher.

`sproutwall setup kiosk` installs a copy of this file as
~/.local/bin/sproutwall-kiosk and starts it from the desktop's labwc
autostart. Python 3 standard library only; it imports nothing from the
repository, so the copy keeps working if the checkout moves.

What it does, as the logged-in desktop user (never root):
1. Opens the state folder one component at a time without following links,
   takes setup.lock shared (if setup, --off or --undo holds it, it exits at
   once), checks that the record, run/ and browser/ are there, takes the
   lock file setup made in run/ so only one launcher runs, then lets go of
   setup.lock. It creates and writes no files itself. It exits if a kiosk
   browser with its profile is already open.
2. Polls http://127.0.0.1:3847/api/health over a plain socket: a 3 s connect
   timeout and a 5 s deadline for the whole request (each read waits only for
   the time left). Redirects are never followed (a 3xx is "not ready"). The
   hub is ready only on HTTP 200 with a JSON body whose "ok" is true (a
   duplicate key is not ready).
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
    import errno
    import fcntl
    import json
    import os
    import re
    import signal
    import socket
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
MAX_RESPONSE = MAX_BODY + 16 * 1024
FAST_INTERVAL_S = 2.0
FAST_PERIOD_S = 60.0
SLOW_INTERVAL_S = 10.0
HINT_AFTER_S = 90.0
STOP_GRACE_S = 10.0

# Same values as sproutwall_lib/kiosk.py, kiosk_files.py and kiosk_detect.py
# (a test checks).
STATE_DIR = os.path.join(".local", "state", "sproutwall", "kiosk")
MANIFEST = "manifest.json"
SETUP_LOCK = "setup.lock"
RUN_DIR = "run"
BROWSER_PROFILE = "browser"
LOCK_FILE = "launcher.lock"
WAIT_PAGE = "starting.html"
CHROMIUM_CANDIDATES = ("/usr/bin/chromium", "/usr/bin/chromium-browser")
NOFOLLOW = os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW

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


UNSAFE = (
    "sproutwall-kiosk: the kiosk's state folder holds a link or a file setup did not make; not starting. "
    "Run ./scripts/sproutwall setup kiosk --check.\n"
)


class NotSetUp(Exception):
    pass


class Unsafe(Exception):
    """A link, or an entry of the wrong kind, in the state folder."""


# --- pure decisions (unit-tested) -------------------------------------------------


def _no_duplicates(pairs):
    data = {}
    for key, value in pairs:
        if key in data:
            raise ValueError("duplicate key")
        data[key] = value
    return data


def _no_constants(name):
    raise ValueError("not JSON: " + name)


def loads_strict(text):
    """json.loads that rejects duplicate keys and NaN/Infinity (the same as
    sproutwall_lib/kiosk.py loads_strict; a test checks)."""
    return json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_no_constants)


def health_verdict(status, body):
    """True only for HTTP 200 with a JSON object whose "ok" is exactly true."""
    if status != 200 or not isinstance(body, (bytes, bytearray)) or len(body) > MAX_BODY:
        return False
    try:
        data = loads_strict(bytes(body).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return False
    return isinstance(data, dict) and data.get("ok") is True


STATUS_RE = re.compile(rb"HTTP/1\.[01] ([0-9]{3})(?: [^\r\n]*)?")
HEX_RE = re.compile(rb"[0-9A-Fa-f]{1,8}")


def _dechunk(data):
    body = bytearray()
    pos = 0
    while True:
        end = data.find(b"\r\n", pos)
        if end < 0:
            raise ValueError("chunk size")
        size_text = data[pos:end].split(b";", 1)[0].strip()
        if HEX_RE.fullmatch(size_text) is None:
            raise ValueError("chunk size")
        size = int(size_text, 16)
        pos = end + 2
        if size == 0:
            return bytes(body)
        if data[pos + size : pos + size + 2] != b"\r\n":
            raise ValueError("chunk")
        body += data[pos : pos + size]
        if len(body) > MAX_BODY:
            raise ValueError("too large")
        pos += size + 2


def parse_response(data):
    """(status, body) of a complete HTTP/1.x response read until the server
    closed the connection: Content-Length, chunked or close-delimited.
    ValueError for anything malformed."""
    head, sep, rest = data.partition(b"\r\n\r\n")
    if not sep:
        raise ValueError("no end of headers")
    lines = head.split(b"\r\n")
    match = STATUS_RE.fullmatch(lines[0])
    if match is None:
        raise ValueError("status line")
    headers = {}
    for line in lines[1:]:
        name, colon, value = line.partition(b":")
        if not colon or not name or name != name.strip():
            raise ValueError("header")
        name = name.lower()
        if name in headers and name in (b"content-length", b"transfer-encoding"):
            raise ValueError("duplicate header")
        headers[name] = value.strip()
    encoding = headers.get(b"transfer-encoding")
    if encoding is not None:
        if encoding.lower() != b"chunked" or b"content-length" in headers:
            raise ValueError("transfer-encoding")
        return int(match.group(1)), _dechunk(rest)
    length = headers.get(b"content-length")
    if length is not None:
        if not length.isdigit() or len(rest) < int(length):
            raise ValueError("content-length")
        return int(match.group(1)), rest[: int(length)]
    return int(match.group(1)), rest


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

def check_health(address=(HUB_HOST, HUB_PORT), deadline=HEALTH_DEADLINE_S, connect_timeout=HEALTH_TIMEOUT_S):
    """One HTTP/1.0 GET of the health address over a plain socket, with a
    deadline for the whole request: the connect waits at most
    connect_timeout (and never past the deadline), and every send and read
    waits only for the time left, so a server that trickles bytes cannot
    hold it longer. The socket is always closed. Nothing is followed (a 3xx
    is "not ready"). Connection failures, timeouts and malformed answers
    are "not ready"; anything unexpected is raised here, in the caller."""
    end = time.monotonic() + deadline
    sock = None
    try:
        sock = socket.create_connection(address, timeout=max(0.001, min(connect_timeout, deadline)))
        host = "%s:%d" % address
        request = "GET %s HTTP/1.0\r\nHost: %s\r\nAccept: application/json\r\nConnection: close\r\n\r\n" % (HEALTH_PATH, host)
        remaining = end - time.monotonic()
        if remaining <= 0:
            return False
        sock.settimeout(remaining)
        sock.sendall(request.encode("ascii"))
        data = bytearray()
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                return False
            sock.settimeout(remaining)
            chunk = sock.recv(16384)
            if not chunk:
                break
            data += chunk
            if len(data) > MAX_RESPONSE:
                return False
        status, body = parse_response(bytes(data))
        return health_verdict(status, body)
    except (OSError, ValueError):
        return False
    finally:
        if sock is not None:
            sock.close()


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


def _open_at(dir_fd, name, flags, mode_check):
    """fd for name in an open folder, never following a link: NotSetUp if
    missing, Unsafe for a link or the wrong kind of file."""
    try:
        fd = os.open(name, flags, dir_fd=dir_fd)
    except FileNotFoundError as error:
        raise NotSetUp() from error
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EISDIR, errno.ENXIO):
            raise Unsafe() from error
        raise
    try:
        st = os.fstat(fd)
        if not mode_check(st.st_mode) or st.st_uid != os.getuid():
            raise Unsafe()
        if not stat.S_ISDIR(st.st_mode) and st.st_nlink != 1:
            raise Unsafe()
    except BaseException:
        os.close(fd)
        raise
    return fd


def open_state(home):
    """The state folder, reached from home one component at a time (O_NOFOLLOW)."""
    fd = os.open(home, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0))
    try:
        for part in STATE_DIR.split(os.sep):
            nfd = _open_at(fd, part, DIR_FLAGS, stat.S_ISDIR)
            os.close(fd)
            fd = nfd
    except BaseException:
        os.close(fd)
        raise
    return fd


def _same_entry(fd, dir_fd, name):
    """The open file fd is still the one called name in dir_fd."""
    try:
        named = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    held = os.fstat(fd)
    return (held.st_dev, held.st_ino) == (named.st_dev, named.st_ino)


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
        self.home = home
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
        """The page setup wrote to run/ (checked: a regular file of this
        user with one link, reached without following links), or None."""
        try:
            state_fd = open_state(self.home)
            try:
                run_fd = _open_at(state_fd, RUN_DIR, DIR_FLAGS, stat.S_ISDIR)
                try:
                    os.close(_open_at(run_fd, WAIT_PAGE, FILE_FLAGS, stat.S_ISREG))
                finally:
                    os.close(run_fd)
            finally:
                os.close(state_fd)
        except (NotSetUp, Unsafe, OSError):
            return None
        return "file://" + urllib.parse.quote(os.path.join(self.run_dir, WAIT_PAGE))

    def sleep(self, seconds):
        end = time.monotonic() + seconds
        while not self.stopping and time.monotonic() < end:
            time.sleep(min(0.5, max(0.0, end - time.monotonic())))

    def take_lock(self):
        """The launcher lock fd, or None when this launcher should not run
        (setup, --off or --undo is running, or another launcher holds it).

        setup.lock is held shared only while the state is checked and the
        launcher lock is taken, so --off and --undo (which hold it
        exclusive) never meet a launcher that is still starting."""
        state_fd = open_state(self.home)
        try:
            setup_fd = _open_at(state_fd, SETUP_LOCK, FILE_FLAGS, stat.S_ISREG)
            try:
                try:
                    fcntl.flock(setup_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                except BlockingIOError:
                    return None  # setup, --off or --undo is running
                if not _same_entry(setup_fd, state_fd, SETUP_LOCK):
                    return None  # removed by a finishing --undo
                os.close(_open_at(state_fd, MANIFEST, FILE_FLAGS, stat.S_ISREG))
                os.close(_open_at(state_fd, BROWSER_PROFILE, DIR_FLAGS, stat.S_ISDIR))
                run_fd = _open_at(state_fd, RUN_DIR, DIR_FLAGS, stat.S_ISDIR)
                try:
                    lock_fd = _open_at(run_fd, LOCK_FILE, os.O_RDWR | NOFOLLOW, stat.S_ISREG)
                finally:
                    os.close(run_fd)
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    os.close(lock_fd)
                    return None  # another launcher is already running
                return lock_fd
            finally:
                os.close(setup_fd)  # lets go of the shared setup.lock
        finally:
            os.close(state_fd)

    def run(self):
        lock_fd = self.take_lock()
        if lock_fd is None:
            return 0
        try:
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
                page = self.wait_page_url()
                if page is not None:
                    self.start(binary, page)
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
    except Unsafe:
        code = fail_safe(UNSAFE)
    except BaseException:  # noqa: BLE001 - fixed output only
        code = fail_safe()
    return code


if __name__ == "__main__":
    sys.exit(guarded_main())
