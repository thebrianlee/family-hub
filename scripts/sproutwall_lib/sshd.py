"""SSH server state and policy, from what an unprivileged user can read.

State comes from `systemctl is-enabled/is-active` for ssh.service,
sshd.service, ssh.socket and sshd.socket, plus listening sockets on port 22
and on every Port in the readable config. Policy comes from
/etc/ssh/sshd_config and the files it includes (sshd -T needs root, and
doctor never uses sudo). Any include that cannot be read or listed makes the
config unreadable, which is reported as unknown.
"""

import os

SSHD_CONFIG = "/etc/ssh/sshd_config"
UNITS = ("ssh.service", "sshd.service", "ssh.socket", "sshd.socket")
UNIT_DIRS = ("/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system")
DEFAULT_PORT = 22

_ENABLED_ON = {"enabled", "enabled-runtime", "linked", "linked-runtime"}
# "alias": another name for a unit that is checked under its own name.
_ENABLED_OFF = {"disabled", "masked", "masked-runtime", "not-found", "alias"}
_ACTIVE_ON = {"active", "activating", "reloading", "refreshing", "deactivating"}
_ACTIVE_OFF = {"inactive", "failed"}
_PASSWORD_KEYWORDS = ("passwordauthentication", "kbdinteractiveauthentication", "challengeresponseauthentication")


class SshConfigUnreadable(Exception):
    pass


def _first_word(text):
    stripped = text.strip()
    return stripped.split()[0] if stripped else ""


def _unit_installed(system, unit):
    return any(system.exists(os.path.join(directory, unit)) for directory in UNIT_DIRS)


def _unit_state(system, unit):
    """on, off or unknown for one unit."""
    states = []
    for verb, on_words, off_words in (
        ("is-enabled", _ENABLED_ON, _ENABLED_OFF),
        ("is-active", _ACTIVE_ON, _ACTIVE_OFF),
    ):
        result = system.run(["systemctl", verb, unit], timeout=10.0)
        if result.rc is None:
            return "unknown"
        word = _first_word(result.out)
        if word in on_words:
            states.append("on")
        elif word in off_words:
            states.append("off")
        elif word == "unknown" and verb == "is-active":
            states.append("off")  # not loaded
        elif word == "" and not _unit_installed(system, unit):
            states.append("off")
        else:
            states.append("unknown")
    if "on" in states:
        return "on"
    if "unknown" in states:
        return "unknown"
    return "off"


def service_state(system, sockets, sockets_complete, ports):
    """on, off or unknown. A listener already seen counts even if a later read failed."""
    if any(state == "0A" and port in ports for _, port, state in sockets):
        return "on"
    states = [_unit_state(system, unit) for unit in UNITS]
    if "on" in states:
        return "on"
    if "unknown" in states or not sockets_complete:
        return "unknown"
    return "off"


def _resolve_include(pattern):
    return pattern if os.path.isabs(pattern) else os.path.join("/etc/ssh", pattern)


def read_directives(system, path=SSHD_CONFIG, depth=0):
    """[(keyword, args, in_match)] in file order, with Include expanded.

    None when the main config does not exist (no SSH server installed).
    Raises SshConfigUnreadable when any file cannot be read or an include
    folder cannot be listed.
    """
    if depth > 8:
        raise SshConfigUnreadable()
    try:
        text = system.read_text(path)
    except FileNotFoundError:
        if depth == 0:
            return None
        raise SshConfigUnreadable() from None
    except OSError:
        raise SshConfigUnreadable() from None
    directives = []
    in_match = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line.split(None, 1)[0]:
            keyword, _, rest = line.partition("=")
        else:
            parts = line.split(None, 1)
            keyword, rest = parts[0], (parts[1] if len(parts) > 1 else "")
        keyword = keyword.strip().lower()
        args = rest.split("#", 1)[0].strip().strip("=").strip()
        if keyword == "match":
            in_match = args.lower() != "all"
            continue
        if keyword == "include":
            for pattern in args.split():
                pattern = _resolve_include(pattern)
                folder = os.path.dirname(pattern)
                if system.exists(folder) and not system.listable(folder):
                    raise SshConfigUnreadable()
                for included in system.glob(pattern):
                    for keyword2, args2, match2 in read_directives(system, included, depth + 1) or []:
                        directives.append((keyword2, args2, match2 or in_match))
            continue
        directives.append((keyword, args, in_match))
    return directives


def effective(directives, keyword, default):
    """The first unconditional value of keyword (sshd's first-match rule)."""
    if keyword == "kbdinteractiveauthentication":
        names = ("kbdinteractiveauthentication", "challengeresponseauthentication")
    else:
        names = (keyword,)
    for name, args, in_match in directives:
        if name in names and not in_match:
            return args.lower()
    return default


def ports(directives):
    """Port 22 and every Port the config names."""
    found = {DEFAULT_PORT}
    for name, args, _ in directives or []:
        if name == "port":
            try:
                found.add(int(args.split()[0]))
            except (ValueError, IndexError):
                continue
    return sorted(found)


def allows_password(directives):
    """True unless the config is key-only everywhere, Match blocks included."""
    if effective(directives, "passwordauthentication", "yes") != "no":
        return True
    if effective(directives, "kbdinteractiveauthentication", "yes") != "no":
        return True
    for name, args, in_match in directives:
        value = args.lower()
        if name in _PASSWORD_KEYWORDS and (value == "yes" or (in_match and value != "no")):
            return True
        if name == "permitemptypasswords" and value != "no":
            return True
        if name == "permitrootlogin" and value == "yes":
            return True
        if name == "authenticationmethods" and ("password" in value or "keyboard-interactive" in value):
            return True
    return False
