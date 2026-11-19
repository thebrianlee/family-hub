"""Listener, interface and published-port parsing, and exposure rules.

Exposure classes for one address:
  loopback  127.0.0.0/8, ::1
  lan       10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10
  public    everything else (global IPv6 included)

A wildcard bind (0.0.0.0, ::) covers every interface address: 0.0.0.0 the
IPv4 ones, :: both IPv6 and IPv4 (a dual-stack socket cannot be ruled out
from /proc). Nothing here proves router forwarding, tunnels or that peers
are trusted, so LAN exposure is never reported as safe.
"""

import ipaddress
import json
import re

LISTEN = "0A"
ESTABLISHED = "01"

_LAN_V4 = tuple(
    ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16")
)
_LAN_V6 = tuple(ipaddress.ip_network(net) for net in ("fc00::/7", "fe80::/10"))


def _decode_proc_addr(hex_addr):
    raw = bytes.fromhex(hex_addr)
    if len(raw) == 4:
        return ipaddress.IPv4Address(bytes(reversed(raw)))
    if len(raw) == 16:
        words = [bytes(reversed(raw[i : i + 4])) for i in range(0, 16, 4)]
        return ipaddress.IPv6Address(b"".join(words))
    raise ValueError("address length")


# The kernel's TCP states as /proc/net/tcp{,6} prints them: 01 ESTABLISHED
# ... 0A LISTEN, 0B CLOSING.
TCP_STATES = frozenset("%02X" % state for state in range(1, 12))
_ENDPOINT = {
    4: re.compile(r"([0-9A-F]{8}):([0-9A-F]{4})", re.ASCII),
    6: re.compile(r"([0-9A-F]{32}):([0-9A-F]{4})", re.ASCII),
}


def parse_proc_net_tcp(text, version):
    """([(address, port, state)], complete) for one /proc/net/tcp (4) or tcp6 (6) table.

    Parsed line by line. A row counts only if its local and remote
    addresses have the table's length (8 or 32 hex digits), each port is
    exactly 4 hex digits, and its state is one of the kernel's 11 TCP states.
    Any other row makes the table incomplete but never drops the rows
    already read, so an exposure already seen is kept. Without a header the
    table is incomplete.
    """
    endpoint = _ENDPOINT[version]
    sockets = []
    headers = 0
    complete = True
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "sl" and "local_address" in fields:
            headers += 1
            continue
        local = endpoint.fullmatch(fields[1]) if len(fields) >= 4 else None
        remote = endpoint.fullmatch(fields[2]) if len(fields) >= 4 else None
        if not (fields[0].endswith(":") and local and remote and fields[3] in TCP_STATES):
            complete = False
            continue
        sockets.append((_decode_proc_addr(local.group(1)), int(local.group(2), 16), fields[3]))
    return sockets, complete and headers == 1


def parse_ip_addr_json(text):
    """[address] from `ip -j addr show`. Raises ValueError on anything unexpected."""
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError("not a list")
    addresses = []
    for link in data:
        if not isinstance(link, dict):
            raise ValueError("link")
        infos = link.get("addr_info", [])
        if not isinstance(infos, list):
            raise ValueError("addr_info")
        for info in infos:
            if not isinstance(info, dict) or info.get("family") not in ("inet", "inet6"):
                continue
            local = info.get("local")
            if not isinstance(local, str):
                raise ValueError("local")
            addresses.append(ipaddress.ip_address(local.split("%", 1)[0]))
    return addresses


_BRIDGE_V4 = tuple(ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_BRIDGE_V6 = ipaddress.ip_network("fc00::/7")


def container_address(values):
    """The one private bridge address (RFC 1918 or ULA) among a container's
    network addresses, or None when there is none, more than one, or it is
    anything else (loopback, link-local, public, malformed, with a zone)."""
    if not isinstance(values, list):
        return None
    found = [value for value in values if value not in (None, "")]
    if len(found) != 1 or not isinstance(found[0], str) or "%" in found[0]:
        return None
    try:
        address = ipaddress.ip_address(found[0])
    except ValueError:
        return None
    if address.version == 4:
        return address if any(address in net for net in _BRIDGE_V4) else None
    return address if address in _BRIDGE_V6 else None


def classify(address):
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    if address.is_loopback:
        return "loopback"
    nets = _LAN_V4 if address.version == 4 else _LAN_V6
    return "lan" if any(address in net for net in nets) else "public"


def exposure_classes(binds, interface_addresses):
    """The set of classes the bind addresses are reachable on."""
    classes = set()
    for bind in binds:
        if isinstance(bind, ipaddress.IPv6Address) and bind.ipv4_mapped is not None:
            bind = bind.ipv4_mapped
        if bind.is_unspecified:
            covered = [a for a in interface_addresses if bind.version == 6 or a.version == 4]
            classes.update(classify(a) for a in covered)
        else:
            classes.add(classify(bind))
    return classes


def host_ip_binds(host_ip):
    """Addresses one Docker HostIp value binds. "" means both wildcards."""
    if host_ip in ("", None):
        return [ipaddress.ip_address("0.0.0.0"), ipaddress.ip_address("::")]
    if not isinstance(host_ip, str):
        raise ValueError("HostIp")
    return [ipaddress.ip_address(host_ip.strip("[]").split("%", 1)[0])]


def published(port_map, container_port):
    """[(bind address, host port or None)] for container_port/tcp in a Docker port map.

    Accepts NetworkSettings.Ports or HostConfig.PortBindings (either may be null).
    """
    if port_map is None:
        return []
    if not isinstance(port_map, dict):
        raise ValueError("port map")
    entries = port_map.get("%d/tcp" % container_port)
    if entries is None:
        return []
    if not isinstance(entries, list):
        raise ValueError("bindings")
    result = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("binding")
        host_port = entry.get("HostPort")
        try:
            port = int(host_port) if host_port not in ("", None) else None
        except (TypeError, ValueError):
            port = None
        for address in host_ip_binds(entry.get("HostIp")):
            result.append((address, port))
    return result
