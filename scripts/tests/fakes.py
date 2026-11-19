"""A fake host for doctor and verify-image tests: canned command output,
files and HTTP answers. Only the fictional sample household is used."""

import fnmatch
import ipaddress
import json

from sproutwall_lib import compose
from sproutwall_lib.checks import HUB_FORMAT
from sproutwall_lib.system import CommandResult, HttpResponse

ROOT = "/repo"
HOME = "/home/pi"
HUB_IP = "172.18.0.2"  # the hub container's bridge address in the fakes
DIGEST = "sha256:" + "0123456789abcdef" * 4
IMAGE_ID = "sha256:" + "b" * 64
CID = "c0ffee" + "0" * 58
SOURCE_SHA = "5972e3e" + "1" * 33
COMPOSE = ROOT + "/docker-compose.preview.yml"


def compose_text(reference='"ghcr.io/thebrianlee/sproutwall:preview@' + DIGEST + '"'):
    return (
        "# preview\n"
        "services:\n"
        "  family-hub:\n"
        "    image: %s\n"
        "    ports:\n"
        '      - "3847:3847"\n' % reference
    )


def compose_config_json(image="ghcr.io/thebrianlee/sproutwall:preview@" + DIGEST, extra_services=None, **service):
    """`docker compose config --format json` for the preview file."""
    body = {"image": image, "ports": [{"mode": "ingress", "host_ip": "0.0.0.0", "target": 3847, "published": "3847"}]}
    body.update(service)
    services = {"family-hub": body}
    services.update(extra_services or {})
    return json.dumps({"name": "sproutwall", "services": services, "volumes": {"familyhub-data": {}}})


def hub_state(health="healthy", status="running", addresses=(HUB_IP, ""), network_mode="sproutwall_default", cid=None):
    """The one `docker inspect --format HUB_FORMAT` answer for the hub container."""
    return json.dumps(
        {
            "id": cid or CID,
            "health": health,
            "status": status,
            "network_mode": network_mode,
            "addresses": list(addresses) + [None],
        }
    )


def ok(out="", err="", rc=0):
    return CommandResult(rc, out, err)


def _proc_addr(address):
    packed = ipaddress.ip_address(address).packed
    words = [packed[i : i + 4][::-1] for i in range(0, len(packed), 4)]
    return b"".join(words).hex().upper()


def proc_table(entries, v6=False):
    """/proc/net/tcp{,6} text for [(address, port, state)]."""
    lines = ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"]
    remote = "0" * (32 if v6 else 8) + ":0000"
    for index, (address, port, state) in enumerate(entries):
        lines.append(
            "  %d: %s:%04X %s %s 00000000:00000000 00:00000000 00000000  1000        0 %d"
            % (index, _proc_addr(address), port, remote, state, 1000 + index)
        )
    return "\n".join(lines) + "\n"


def ip_addr_json(addresses):
    """`ip -j addr show` for {ifname: [address, ...]}."""
    links = []
    for ifname, addrs in addresses.items():
        infos = [
            {"family": "inet6" if ":" in a else "inet", "local": a, "prefixlen": 64 if ":" in a else 24, "scope": "global"}
            for a in addrs
        ]
        links.append({"ifname": ifname, "flags": ["UP"], "addr_info": infos})
    return json.dumps(links)


def container_json(**overrides):
    data = {
        "image": IMAGE_ID,
        "running": True,
        "network_mode": "sproutwall_default",
        # docker-compose.preview.yml publishes "0.0.0.0:3847:3847": IPv4 only.
        "ports": {"3847/tcp": [{"HostIp": "0.0.0.0", "HostPort": "3847"}]},
        "port_bindings": {"3847/tcp": [{"HostIp": "0.0.0.0", "HostPort": "3847"}]},
        "mounts": [
            {"Type": "volume", "Name": "sproutwall_familyhub-data", "Destination": "/data", "RW": True},
            {"Type": "bind", "Source": HOME + "/sproutwall/photos", "Destination": "/photos", "RW": True},
        ],
    }
    data.update(overrides)
    return json.dumps(data)


def image_json(**overrides):
    data = {
        "id": IMAGE_ID,
        "repo_digests": ["ghcr.io/thebrianlee/sproutwall@" + DIGEST],
        "arch": "arm64",
        "os": "linux",
    }
    data.update(overrides)
    return json.dumps(data)


SSHD_CONFIG = (
    "Include /etc/ssh/sshd_config.d/*.conf\n"
    "KbdInteractiveAuthentication no\n"
    "UsePAM yes\n"
    "X11Forwarding yes\n"
    "Subsystem sftp /usr/lib/openssh/sftp-server\n"
)


class FakeSystem:
    def __init__(self):
        self.commands = {}
        self.files = {}
        self.dirs = set()
        self.unlistable = set()  # listing raises PermissionError
        self.list_errors = {}  # folder -> exception its listing raises
        self.blocked = set()  # folders this user cannot enter (mode 000)
        self.probe_errors = set()  # paths whose stat fails (EACCES, EIO...)
        self.http_map = {}
        self.which_map = {}
        self.home_dir = HOME
        self.current_dir = ROOT
        self.os_name = "Linux"
        self.arch = "aarch64"
        self.bits = "64bit"
        self.calls = []
        self.http_calls = []
        self.http_targets = []

    # commands -------------------------------------------------------------
    def set(self, argv, value):
        self.commands[tuple(argv)] = value

    def run(self, argv, timeout=15.0, env=None):
        key = tuple(str(part) for part in argv)
        self.calls.append((key, env))
        value = None
        for size in range(len(key), 0, -1):
            if key[:size] in self.commands:
                value = self.commands[key[:size]]
                break
        if value is None:
            return CommandResult(None, missing=True)
        if callable(value):
            value = value(key, env)
        if isinstance(value, BaseException):
            raise value
        return value

    # files ----------------------------------------------------------------
    def _file(self, path):
        if self._blocked(path):
            raise PermissionError(13, "Permission denied")
        if path not in self.files:
            raise FileNotFoundError(2, "No such file")
        value = self.files[path]
        if isinstance(value, BaseException):
            raise value
        return value

    def read_bytes(self, path):
        value = self._file(path)
        return value if isinstance(value, bytes) else value.encode("utf-8")

    def read_text(self, path):
        return self.read_bytes(path).decode("utf-8", "replace")

    def exists(self, path):
        prefix = path.rstrip("/") + "/"
        return path in self.files or path in self.dirs or any(f.startswith(prefix) for f in self.files)

    def is_file(self, path):
        return path in self.files

    def _blocked(self, path):
        """Under a folder this user cannot enter (mode 000)."""
        return any(path.startswith(b.rstrip("/") + "/") for b in self.blocked)

    def probe(self, path):
        if self._blocked(path) or path in self.probe_errors:
            return "error"
        if path in self.files:
            value = self.files[path]
            if isinstance(value, FileNotFoundError):
                return "missing"
            if isinstance(value, BaseException):
                return "file"  # stat works; reading it fails
            return "file"
        if self.is_dir(path):
            return "dir"
        parent = path.rsplit("/", 1)[0]
        if parent and parent in self.files:
            return "error"  # a path part that is a file (ENOTDIR)
        return "missing"

    def _known_paths(self):
        paths = set(self.files) | set(self.dirs) | set(self.blocked)
        for path in list(paths):
            parts = path.split("/")
            for size in range(2, len(parts)):
                paths.add("/".join(parts[:size]))
        return paths

    def listdir(self, path):
        """Like os.listdir: raises on any failure, and in no particular order."""
        if path in self.list_errors:
            raise self.list_errors[path]
        if path in self.unlistable or path in self.blocked or self._blocked(path):
            raise PermissionError(13, "Permission denied")
        if not self.is_dir(path):
            raise FileNotFoundError(2, "No such file or directory")
        prefix = path.rstrip("/") + "/"
        names = {p[len(prefix):].split("/")[0] for p in self._known_paths() if p.startswith(prefix)}
        return sorted(names, reverse=True)  # deliberately not sorted the way callers need

    def is_dir(self, path):
        prefix = path.rstrip("/") + "/"
        return (
            path in self.dirs
            or path in self.blocked
            or any(f.startswith(prefix) for f in self.files)
            or any(d.startswith(prefix) for d in self.dirs | self.blocked)
        )

    def which(self, name, extra_dirs=()):
        return self.which_map.get(name)

    def home(self):
        return self.home_dir

    def cwd(self):
        if isinstance(self.current_dir, BaseException):
            raise self.current_dir
        return self.current_dir

    def same_dir(self, first, second):
        return first.rstrip("/") == second.rstrip("/")

    def sysname(self):
        return self.os_name

    def machine(self):
        return self.arch

    def userland_bits(self):
        return self.bits

    # http -----------------------------------------------------------------
    def http(self, address, method, path, body=None, headers=None, timeout=3.0):
        self.http_calls.append((method, path, body, dict(headers or {})))
        self.http_targets.append(address)
        value = self.http_map.get((method, path), HttpResponse(None, error="refused"))
        if isinstance(value, BaseException):
            raise value
        return value


def health_response(setup=True, **extra):
    body = {"ok": True, "version": "0.1.0-preview.0", "schema": 3, "setup": setup}
    body.update(extra)
    return HttpResponse(200, json.dumps(body).encode())


def exec_key(*argv):
    return ("docker", "exec", "--user", "node", CID) + tuple(argv)


def healthy_pi(phase_ready=True):
    """A Pi 5 running the verified preview, published on the LAN only.

    Expected doctor result: everything passes except app_bind, which is
    unknown/confirm_trusted_lan (a LAN publication is never "verified safe").
    """
    s = FakeSystem()
    s.files["/proc/device-tree/model"] = b"Raspberry Pi 5 Model B Rev 1.0\x00"
    s.set(["dpkg", "--print-architecture"], ok("arm64\n"))
    s.set(["docker", "compose", "version", "--short"], ok("2.29.7\n"))
    s.set(["docker", "version", "--format", "{{.Server.Version}}"], ok("27.3.1\n"))
    s.files[COMPOSE] = compose_text()
    s.set(compose.config_argv(COMPOSE), ok(compose_config_json()))
    s.set(["docker", "compose", "-f", COMPOSE, "ps", "--all", "--quiet"], ok(CID + "\n"))
    s.set(["docker", "inspect", "--type", "container"], ok(container_json()))
    s.set(["docker", "inspect", "--type", "container", "--format", HUB_FORMAT], ok(hub_state()))
    s.set(["docker", "image", "inspect"], ok(image_json()))
    s.set(exec_key("true"), ok())
    s.set(exec_key("test", "-w", "/data"), ok())
    s.set(exec_key("test", "-f", "/data/sproutwall.db"), ok())
    s.set(exec_key("test", "-w", "/data/sproutwall.db"), ok())
    s.set(exec_key("test", "-f", "/data/family-hub.db"), ok(rc=1))
    s.set(exec_key("cat", "/proc/net/tcp"), ok(proc_table([("127.0.0.1", 8787, "0A"), ("0.0.0.0", 3847, "0A")])))
    s.set(exec_key("test", "-e", "/proc/net/tcp6"), ok())
    s.set(exec_key("cat", "/proc/net/tcp6"), ok(proc_table([("::1", 8787, "0A")], v6=True)))
    s.files["/proc/net/tcp"] = proc_table([("0.0.0.0", 3847, "0A"), ("127.0.0.1", 631, "0A")])
    s.files["/proc/net/tcp6"] = proc_table([("::1", 631, "0A")], v6=True)
    s.set(
        ["ip", "-j", "addr", "show"],
        ok(ip_addr_json({"lo": ["127.0.0.1", "::1"], "wlan0": ["192.168.1.50", "fe80::1"], "docker0": ["172.17.0.1"]})),
    )
    for unit in ("ssh.service", "ssh.socket"):
        s.set(["systemctl", "is-enabled", unit], ok("disabled\n", rc=1))
        s.set(["systemctl", "is-active", unit], ok("inactive\n", rc=3))
    # Debian: sshd.service is an alias of ssh.service; there is no sshd.socket.
    s.set(["systemctl", "is-enabled", "sshd.service"], ok("alias\n"))
    s.set(["systemctl", "is-active", "sshd.service"], ok("inactive\n", rc=3))
    s.set(["systemctl", "is-enabled", "sshd.socket"], ok("not-found\n", rc=4))
    s.set(["systemctl", "is-active", "sshd.socket"], ok("inactive\n", rc=3))
    s.files["/etc/ssh/sshd_config"] = SSHD_CONFIG
    s.dirs.add("/etc/ssh/sshd_config.d")
    s.http_map[("GET", "/api/health")] = health_response(setup=phase_ready)
    if phase_ready:
        s.http_map[("GET", "/api/modules")] = HttpResponse(401, b'{"error":"Unlock this screen with the parent PIN"}')
        s.files[HOME + "/.config/labwc/autostart"] = (
            "/usr/bin/lwrespawn /usr/bin/wf-panel-pi &\n"
            '"$HOME/.local/share/sproutwall/kiosk-launch" & # sproutwall:kiosk-launcher\n'
        )
    return s


def ssh_on(system, password=False, listen="0.0.0.0"):
    """Turn SSH on in the fake (tier B temporary access)."""
    system.set(["systemctl", "is-enabled", "ssh.service"], ok("enabled\n"))
    system.set(["systemctl", "is-active", "ssh.service"], ok("active\n"))
    system.files["/etc/ssh/sshd_config.d/50-temp.conf"] = "PasswordAuthentication %s\n" % ("yes" if password else "no")
    entries = [("0.0.0.0", 3847, "0A"), (listen, 22, "0A")]
    system.files["/proc/net/tcp"] = proc_table(entries)
