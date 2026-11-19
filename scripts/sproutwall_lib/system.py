"""The only place that touches the host: commands, files and HTTP to the hub container.

Checks receive a System and never call subprocess, open() or sockets
themselves, so tests can replace it with canned outputs. Command output and
error text is returned to the caller for parsing and is never printed.
"""

import http.client
import ipaddress
import os
import platform
import shutil
import stat
import subprocess
from dataclasses import dataclass

HUB_PORT = 3847
MAX_HTTP_BODY = 64 * 1024


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
