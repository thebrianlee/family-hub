"""The only place that touches the host: commands, files and HTTP to the hub container.

Checks receive a System and never call subprocess, open() or sockets
themselves, so tests can replace it with canned outputs. Command output and
error text is returned to the caller for parsing and is never printed.

`setup kiosk` also asks it for the process table, signals and the user's
identity. Its own files under the home folder are read and written directly
(kiosk_files.py); tests point the home folder at a temporary directory.
"""

import http.client
import ipaddress
import os
import platform
import pwd
import re
import shutil
import stat
import subprocess
import time
from dataclasses import dataclass

HUB_PORT = 3847
MAX_HTTP_BODY = 64 * 1024
PID_RE = re.compile(r"[1-9][0-9]{0,9}", re.ASCII)  # use with fullmatch


@dataclass(frozen=True)
class CommandResult:
    """rc is None when the command could not run (missing, timeout, OS error)."""

    rc: object
    out: str = ""
    err: str = ""
    missing: bool = False
    timed_out: bool = False


@dataclass(frozen=True)
class HttpResponse:
    """status is None when no HTTP answer arrived; error is then refused, timeout or error."""

    status: object
    body: bytes = b""
    error: object = None


def command_env():
    """The environment for every command: the user's, with a fixed locale and no prompts."""
    env = dict(os.environ)
    env.update(
        {
            "LC_ALL": "C",
            "LANG": "C",
            "NO_COLOR": "1",
            "SYSTEMD_COLORS": "0",
            "SYSTEMD_PAGER": "",
            "PAGER": "cat",
            "DOCKER_CLI_HINTS": "false",
            "GH_PROMPT_DISABLED": "1",
            "GH_NO_UPDATE_NOTIFIER": "1",
        }
    )
    return env


class System:
    """The real host."""

    def run(self, argv, timeout=15.0, env=None):
        argv = [str(part) for part in argv]
        try:
            proc = subprocess.run(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                env=command_env() if env is None else env,
                check=False,
            )
        except FileNotFoundError:
            return CommandResult(None, missing=True)
        except subprocess.TimeoutExpired:
            return CommandResult(None, timed_out=True)
        except (OSError, ValueError, subprocess.SubprocessError):
            return CommandResult(None)
        return CommandResult(
            proc.returncode,
            proc.stdout.decode("utf-8", "replace"),
            proc.stderr.decode("utf-8", "replace"),
        )

    def read_bytes(self, path):
        with open(path, "rb") as handle:
            return handle.read(1024 * 1024)

    def read_text(self, path):
        return self.read_bytes(path).decode("utf-8", "replace")

    def is_file(self, path):
        return os.path.isfile(path)

    def probe(self, path):
        """What a stat of path says: "file", "dir", "missing" (ENOENT only,
        also for a missing parent folder) or "error" (permission denied, a
        path part that is not a folder, I/O errors, loops...)."""
        try:
            mode = os.stat(path).st_mode
        except FileNotFoundError:
            return "missing"
        except (OSError, ValueError):
            return "error"
        return "dir" if stat.S_ISDIR(mode) else "file"

    def cwd(self):
        return os.getcwd()

    def same_dir(self, first, second):
        try:
            return os.path.samefile(first, second)
        except (OSError, ValueError):
            return False

    def listdir(self, path):
        """The names in a folder. Raises OSError on any failure (never an empty answer)."""
        return os.listdir(path)

    def which(self, name, extra_dirs=()):
        dirs = os.environ.get("PATH", "").split(os.pathsep) + [d for d in extra_dirs if d]
        return shutil.which(name, path=os.pathsep.join(d for d in dirs if d))

    def home(self):
        return os.path.expanduser("~")

    def sysname(self):
        return os.uname().sysname

    def machine(self):
        return os.uname().machine

    def userland_bits(self):
        """"64bit" or "32bit": how this Python (a userland program) was built."""
        return platform.architecture()[0]

    # setup kiosk -----------------------------------------------------------
    def uid(self):
        return os.getuid()

    def euid(self):
        return os.geteuid()

    def username(self):
        """This user's login name. Compared with config values; never printed."""
        return pwd.getpwuid(os.getuid()).pw_name

    def environ(self):
        return dict(os.environ)

    def is_executable(self, path):
        """True if this user may run path (call after probe() said "file")."""
        return os.access(path, os.X_OK)

    def processes(self):
        """[(pid, uid, comm, argv)] for every process.

        Raises OSError when /proc cannot be listed, or when one of this
        user's own processes cannot be read for any reason other than having
        just exited. Another user's process that cannot be read is left out:
        the kiosk only looks at its own user's processes.
        """
        me = os.getuid()
        found = []
        for name in os.listdir("/proc"):
            if not PID_RE.fullmatch(name):
                continue
            base = os.path.join("/proc", name)
            try:
                owner = os.stat(base).st_uid
            except (FileNotFoundError, ProcessLookupError):
                continue  # exited meanwhile
            try:
                with open(os.path.join(base, "comm"), "rb") as handle:
                    comm = handle.read(64)
                with open(os.path.join(base, "cmdline"), "rb") as handle:
                    raw = handle.read(64 * 1024)
            except (FileNotFoundError, ProcessLookupError):
                continue  # exited meanwhile
            except OSError:
                if owner == me:
                    raise
                continue
            comm = comm[:-1] if comm.endswith(b"\n") else comm
            argv = [part.decode("utf-8", "surrogateescape") for part in raw.split(b"\0") if part]
            found.append((int(name), owner, comm.decode("utf-8", "surrogateescape"), argv))
        return found

    def process_environ(self, pid):
        """{name: value} of one of this user's processes.

        Raises ProcessLookupError if the process is gone, and OSError for any
        other failure (never an empty answer)."""
        try:
            with open("/proc/%d/environ" % int(pid), "rb") as handle:
                raw = handle.read(256 * 1024 + 1)
        except FileNotFoundError as error:
            raise ProcessLookupError(3, "gone") from error
        if len(raw) > 256 * 1024:
            raise OSError(27, "environment too large")
        env = {}
        for item in raw.split(b"\0"):
            if not item:
                continue
            key, sep, value = item.partition(b"=")
            if not sep:
                raise OSError(22, "malformed environment")
            env[key.decode("utf-8", "surrogateescape")] = value.decode("utf-8", "surrogateescape")
        return env

    def kill(self, pid, sig):
        """Send sig to pid. False when the process is gone or not ours."""
        try:
            os.kill(int(pid), sig)
        except OSError:
            return False
        return True

    def sleep(self, seconds):
        time.sleep(seconds)

    def http(self, address, method, path, body=None, headers=None, timeout=3.0):
        """One request to the hub at a container address. No proxy, no redirects.

        address must be an ipaddress object (the hub container's own bridge
        address); anything else is refused without a connection, so there is
        no fallback to a host name or to loopback.
        """
        if not isinstance(address, (ipaddress.IPv4Address, ipaddress.IPv6Address)):
            return HttpResponse(None, error="error")
        conn = http.client.HTTPConnection(str(address), HUB_PORT, timeout=timeout)
        try:
            conn.request(method, path, body=body, headers=dict(headers or {}))
            resp = conn.getresponse()
            data = resp.read(MAX_HTTP_BODY + 1)
            if len(data) > MAX_HTTP_BODY:
                data = b""
            return HttpResponse(resp.status, data)
        except ConnectionRefusedError:
            return HttpResponse(None, error="refused")
        except TimeoutError:
            return HttpResponse(None, error="timeout")
        except (OSError, http.client.HTTPException, ValueError):
            return HttpResponse(None, error="error")
        finally:
            conn.close()
