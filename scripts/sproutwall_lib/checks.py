"""The doctor checks. Each returns (status, action) from schema.py constants.

A check may read anything it needs (command output, files, HTTP answers), but
it returns only an outcome tuple. Nothing it reads is kept or printed.
"""

import json
import os
import re
from dataclasses import dataclass, field

from . import compose, kiosk, net, sshd
from .schema import INCOMPLETE, PASS, fail, unknown

COMPOSE_VERSION = re.compile(r"^v?(\d+)\.(\d+)")
CONTAINER_ID = re.compile(r"^[0-9a-f]{12,64}$")
HOST_ARCH = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}

APP_PORT = 3847
BRIDGE_PORT = 8787
APP_USER = "node"
DATA_DIR = "/data"
PHOTO_DIR = "/photos"
DB_FILES = ("sproutwall.db", "family-hub.db")  # scripts/lib/db-path.mjs order
DATA_VOLUME = re.compile(r"(?:^|_)familyhub-data$")

# Only the fields doctor needs, so container environment (keys, tokens)
# never even reaches this process.
CONTAINER_FORMAT = (
    '{"image":{{json .Image}},"running":{{json .State.Running}},'
    '"network_mode":{{json .HostConfig.NetworkMode}},"ports":{{json .NetworkSettings.Ports}},'
    '"port_bindings":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}}}'
)
IMAGE_FORMAT = '{"id":{{json .Id}},"repo_digests":{{json .RepoDigests}},"arch":{{json .Architecture}},"os":{{json .Os}}}'

# Installation-only assistant CLIs and their credential/config locations
# (relative to the home folder). Presence at the final phase means the
# temporary access was not removed.
AGENT_COMMANDS = ("claude", "codex", "gemini", "aider", "goose", "opencode", "cursor-agent", "amp", "qwen", "crush")
AGENT_PATHS = (
    ".claude",
    ".claude.json",
    ".codex",
    ".gemini",
    ".qwen",
    ".cursor",
    ".aider.conf.yml",
    os.path.join(".config", "goose"),
    os.path.join(".config", "opencode"),
    os.path.join(".config", "crush"),
    os.path.join(".config", "amp"),
    os.path.join(".local", "share", "opencode"),
)


@dataclass
class Container:
    cid: str
    image: str
    running: bool
    network_mode: str
    ports: object
    port_bindings: object
    mounts: list


@dataclass
class DockerState:
    ok: bool
    containers: list = field(default_factory=list)
    images: dict = field(default_factory=dict)


def _json_object(text):
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def gather_docker(system, compose_file):
    """The hub's containers (service family-hub of the preview project) and their images."""
    result = system.run(["docker", "compose", "-f", compose_file, "ps", "--all", "--quiet"], timeout=30.0)
    if result.rc != 0:
        return DockerState(False)
    ids = [line.strip() for line in result.out.splitlines() if line.strip()]
    if not all(CONTAINER_ID.match(cid) for cid in ids):
        return DockerState(False)
    containers = []
    for cid in ids:
        result = system.run(["docker", "inspect", "--type", "container", "--format", CONTAINER_FORMAT, cid])
        data = _json_object(result.out) if result.rc == 0 else None
        if data is None:
            return DockerState(False)
        mounts = data.get("mounts")
        if not isinstance(data.get("image"), str) or not isinstance(data.get("running"), bool):
            return DockerState(False)
        if not isinstance(mounts, list) or not all(isinstance(m, dict) for m in mounts):
            return DockerState(False)
        containers.append(
            Container(
                cid=cid,
                image=data["image"],
                running=data["running"],
                network_mode=data.get("network_mode") if isinstance(data.get("network_mode"), str) else "",
                ports=data.get("ports"),
                port_bindings=data.get("port_bindings"),
                mounts=mounts,
            )
        )
    images = {}
    for container in containers:
        if container.image in images:
            continue
        result = system.run(["docker", "image", "inspect", "--format", IMAGE_FORMAT, container.image])
        data = _json_object(result.out) if result.rc == 0 else None
        images[container.image] = data
    return DockerState(True, containers, images)


class Context:
    """Inputs shared by several checks, each gathered at most once."""

    def __init__(self, system, root, phase, tier, kiosk_state):
        self.system = system
        self.root = root
        self.phase = phase
        self.tier = tier
        self.kiosk = kiosk_state
        self.outcomes = {}
        self._cache = {}

    def _once(self, key, compute):
        if key not in self._cache:
            try:
                self._cache[key] = ("value", compute())
            except Exception as error:  # noqa: BLE001 - re-raised below, never printed
                self._cache[key] = ("error", error)
        kind, value = self._cache[key]
        if kind == "error":
            raise value
        return value

    def compose_file(self):
        return compose.compose_path(self.root)

    def compose_digest(self):
        return self._once("digest", lambda: compose.read_pinned_digest(self.system, self.compose_file()))

    def docker(self):
        return self._once("docker", lambda: gather_docker(self.system, self.compose_file()))

    def host_sockets(self):
        """Every TCP socket in the host's namespace (IPv4 and IPv6), or None."""

        def read():
            try:
                sockets = net.parse_proc_net_tcp(self.system.read_text("/proc/net/tcp"))
            except (OSError, ValueError):
                return None
            try:
                sockets += net.parse_proc_net_tcp(self.system.read_text("/proc/net/tcp6"))
            except FileNotFoundError:
                pass  # IPv6 is off in this kernel: no IPv6 sockets
            except (OSError, ValueError):
                return None
            return sockets

        return self._once("sockets", read)

    def interfaces(self):
        """Every address on every interface, or None when inspection failed."""

        def read():
            result = self.system.run(["ip", "-j", "addr", "show"])
            if result.rc != 0:
                return None
            try:
                return net.parse_ip_addr_json(result.out)
            except (ValueError, TypeError):
                return None

        return self._once("interfaces", read)

    def health(self):
        """(HTTP response, JSON object or None) for GET /api/health, asked once."""

        def ask():
            resp = self.system.http("GET", "/api/health", headers={"Accept": "application/json"})
            body = _json_object(resp.body.decode("utf-8", "replace")) if resp.status is not None else None
            return resp, body

        return self._once("health", ask)

    def ssh_directives(self):
        def read():
            try:
                return sshd.read_directives(self.system)
            except sshd.SshConfigUnreadable:
                return None

        return self._once("sshd", read)

    def ssh_ports(self):
        directives = self.ssh_directives()
        return sshd.ports(directives) if directives is not None else [22]

    def exec_in(self, container, argv):
        """Run argv inside the container as the app's own user."""
        return self.system.run(["docker", "exec", "--user", APP_USER, container.cid] + list(argv))


# 64-bit Linux the image is built for: kernel machine -> Debian architecture.
SUPPORTED_MACHINES = {"aarch64": "arm64", "x86_64": "amd64"}


def check_platform(ctx):
    """Any 64-bit Linux the image supports (arm64, amd64), kernel and userland.

    Not limited to Raspberry Pi; the model string is never read or printed.
    """
    system = ctx.system
    sysname, machine = system.sysname(), system.machine()
    if not sysname or not machine:
        return INCOMPLETE
    if sysname != "Linux" or machine not in SUPPORTED_MACHINES:
        return fail("use_supported_os")  # 32-bit CPU or OS (armv7l, armv6l, i686), or not Linux
    result = system.run(["dpkg", "--print-architecture"])
    if result.missing:
        # Not Debian-family: judge the userland by how this Python was built.
        bits = system.userland_bits()
        if bits == "64bit":
            return PASS
        return fail("use_supported_os") if bits == "32bit" else INCOMPLETE
    if result.rc != 0 or not result.out.strip():
        return INCOMPLETE
    if result.out.strip() != SUPPORTED_MACHINES[machine]:
        return fail("use_supported_os")  # e.g. a 64-bit kernel with an armhf userland
    return PASS


def check_docker(ctx):
    result = ctx.system.run(["docker", "compose", "version", "--short"])
    if result.missing:
        return fail("use_supported_os")
    if result.rc is None:
        return INCOMPLETE
    match = COMPOSE_VERSION.match(result.out.strip())
    if result.rc != 0 or not match or int(match.group(1)) < 2:
        return fail("use_supported_os")
    result = ctx.system.run(["docker", "version", "--format", "{{.Server.Version}}"])
    if result.rc != 0 or not result.out.strip():
        return unknown("retry_local")  # daemon down, or this user has no daemon access
    return PASS


def check_image_identity(ctx):
    try:
        digest = ctx.compose_digest()
    except compose.ComposeError as error:
        return INCOMPLETE if error.code == "unreadable" else fail("verify_release")
    state = ctx.docker()
    if not state.ok:
        return INCOMPLETE
    if not state.containers:
        return fail("verify_release")
    host_arch = HOST_ARCH.get(ctx.system.machine())
    for container in state.containers:
        image = state.images.get(container.image)
        if image is None:
            return INCOMPLETE
        repo_digests = image.get("repo_digests") or []
        if not isinstance(repo_digests, list):
            return INCOMPLETE
        from_index = container.image == digest or (compose.REPOSITORY + "@" + digest) in repo_digests
        if not from_index:
            return fail("verify_release")
        if image.get("os") != "linux" or host_arch is None or image.get("arch") != host_arch:
            return fail("verify_release")
    return PASS


def _mount(container, destination):
    for mount in container.mounts:
        if mount.get("Destination") == destination:
            return mount
    return None


def check_storage(ctx):
    state = ctx.docker()
    if not state.ok or not state.containers:
        return INCOMPLETE
    for container in state.containers:
        data = _mount(container, DATA_DIR)
        photos = _mount(container, PHOTO_DIR)
        if (
            data is None
            or data.get("Type") != "volume"
            or not DATA_VOLUME.search(str(data.get("Name", "")))
            or data.get("RW") is False
            or photos is None
        ):
            return fail("restore_storage")
        if not container.running:
            return INCOMPLETE
        if ctx.exec_in(container, ["true"]).rc != 0:
            return INCOMPLETE
        writable = ctx.exec_in(container, ["test", "-w", DATA_DIR]).rc
        if writable == 1:
            return fail("restore_storage")
        if writable != 0:
            return INCOMPLETE
        # The resolver opens sproutwall.db if present, else family-hub.db.
        for name in DB_FILES:
            path = DATA_DIR + "/" + name
            present = ctx.exec_in(container, ["test", "-f", path]).rc
            if present == 1:
                continue
            if present != 0:
                return INCOMPLETE
            db_writable = ctx.exec_in(container, ["test", "-w", path]).rc
            if db_writable == 0:
                break
            return fail("restore_storage") if db_writable == 1 else INCOMPLETE
        else:
            return fail("restore_storage")
    return PASS


def check_health(ctx):
    resp, body = ctx.health()
    if resp.status is None:
        return fail("verify_release") if resp.error == "refused" else INCOMPLETE
    if resp.status == 200 and body is not None and body.get("ok") is True:
        return PASS
    if resp.status == 503 and body is not None and body.get("ok") is False and isinstance(body.get("code"), str):
        return fail("restore_storage")  # blocked database: never retry around it with a new volume
    return fail("retry_local")


def _exposure(binds, interfaces, complete):
    classes = net.exposure_classes(binds, interfaces or [])
    if "public" in classes:
        return fail("restrict_ports")
    if not complete:
        return INCOMPLETE
    if "lan" in classes:
        return unknown("confirm_trusted_lan")
    return PASS


def check_app_bind(ctx):
    complete = True
    binds = []
    host_ports = {APP_PORT}
    state = ctx.docker()
    if state.ok:
        for container in state.containers:
            try:
                for port_map in (container.ports, container.port_bindings):
                    for address, host_port in net.published(port_map, APP_PORT):
                        binds.append(address)
                        if host_port is not None:
                            host_ports.add(host_port)
            except (ValueError, TypeError):
                complete = False
    else:
        complete = False
    sockets = ctx.host_sockets()
    if sockets is None:
        complete = False
    else:
        binds += [addr for addr, port, st in sockets if st == net.LISTEN and port in host_ports]
    interfaces = ctx.interfaces()
    if interfaces is None:
        complete = False
    return _exposure(binds, interfaces, complete)


def check_bridge_bind(ctx):
    state = ctx.docker()
    if not state.ok:
        return INCOMPLETE
    for container in state.containers:
        try:
            if any(net.published(m, BRIDGE_PORT) for m in (container.ports, container.port_bindings)):
                return fail("restrict_ports")
        except (ValueError, TypeError):
            return INCOMPLETE
        if container.network_mode == "host":
            sockets = ctx.host_sockets()
        elif container.running:
            result = ctx.exec_in(container, ["cat", "/proc/net/tcp", "/proc/net/tcp6"])
            try:
                # tcp6 is absent when IPv6 is off; cat then exits 1 after printing tcp.
                sockets = net.parse_proc_net_tcp(result.out) if result.rc in (0, 1) else None
            except ValueError:
                sockets = None
        else:
            sockets = None
        if sockets is None:
            return INCOMPLETE
        for address, port, st in sockets:
            if st == net.LISTEN and port == BRIDGE_PORT and net.classify(address) != "loopback":
                return fail("restrict_ports")
    return PASS


def check_ssh_policy(ctx):
    ports = ctx.ssh_ports()
    sockets = ctx.host_sockets()
    state = sshd.service_state(ctx.system, sockets, ports)
    if state == "off":
        return PASS
    if state == "unknown":
        return unknown("review_ssh")
    # SSH is on. Only tier B allows it, and only until the final phase.
    if ctx.tier != "B" or ctx.phase == "final":
        return fail("review_ssh")
    directives = ctx.ssh_directives()
    if directives is None:
        return unknown("review_ssh")
    if sshd.allows_password(directives):
        return fail("review_ssh")
    interfaces = ctx.interfaces()
    if sockets is None or interfaces is None:
        return INCOMPLETE
    binds = [addr for addr, port, st in sockets if st == net.LISTEN and port in ports]
    if "public" in net.exposure_classes(binds, interfaces):
        return fail("review_ssh")
    return PASS


def check_setup(ctx):
    # The `setup` boolean of the anonymous health answer (the app's
    # setup_complete setting). Doctor never sends a write to the hub.
    resp, body = ctx.health()
    if resp.status != 200 or body is None or body.get("ok") is not True:
        return INCOMPLETE
    if body.get("setup") is True:
        return PASS
    if body.get("setup") is False:
        return fail("open_hub")
    return INCOMPLETE  # an image from before the field existed


def check_read_guard(ctx):
    # /api/modules is a core read API behind the read lock that returns no
    # household data even when the lock is off.
    resp = ctx.system.http("GET", "/api/modules", headers={"Accept": "application/json"})
    if resp.status == 401:
        return PASS
    if isinstance(resp.status, int) and 200 <= resp.status < 300:
        return fail("verify_release") if ctx.outcomes.get("setup") == PASS else fail("open_hub")
    return INCOMPLETE


def check_kiosk(ctx):
    path = os.path.join(ctx.system.home(), kiosk.KIOSK_AUTOSTART)
    try:
        text = ctx.system.read_text(path)
    except FileNotFoundError:
        text = ""
    except OSError:
        return INCOMPLETE
    count = kiosk.active_marker_lines(text)
    wanted = 1 if ctx.kiosk == "on" else 0
    return PASS if count == wanted else fail("repair_kiosk")


def _launches_agent(text):
    for line in text.splitlines():
        key, sep, value = line.strip().partition("=")
        if not sep or key not in ("Exec", "ExecStart", "ExecStartPre", "ExecStartPost"):
            continue
        for token in value.split():
            if os.path.basename(token.strip("\"'")) in AGENT_COMMANDS:
                return True
    return False


def check_temporary_access(ctx):
    system = ctx.system
    home = system.home()
    extra = [os.path.join(home, ".local", "bin"), os.path.join(home, "bin"), os.path.join(home, ".npm-global", "bin")]
    if any(system.which(name, extra) for name in AGENT_COMMANDS):
        return fail("remove_agent")
    if any(system.exists(os.path.join(home, rel)) for rel in AGENT_PATHS):
        return fail("remove_agent")
    launchers = system.glob(os.path.join(home, ".config", "autostart", "*.desktop")) + system.glob(
        os.path.join(home, ".config", "systemd", "user", "*.service")
    )
    for path in launchers:
        try:
            if _launches_agent(system.read_text(path)):
                return fail("remove_agent")
        except OSError:
            return INCOMPLETE
    sockets = ctx.host_sockets()
    if sockets is None:
        return INCOMPLETE
    ports = ctx.ssh_ports()
    if any(st == net.ESTABLISHED and port in ports for _, port, st in sockets):
        return fail("remove_agent")  # an SSH session into the Pi is still open
    return PASS


CHECKS = {
    "platform": check_platform,
    "docker": check_docker,
    "image_identity": check_image_identity,
    "storage": check_storage,
    "health": check_health,
    "app_bind": check_app_bind,
    "bridge_bind": check_bridge_bind,
    "ssh_policy": check_ssh_policy,
    "setup": check_setup,
    "read_guard": check_read_guard,
    "kiosk": check_kiosk,
    "temporary_access": check_temporary_access,
}
