"""SSH server state and policy, from what an unprivileged user can read.

State comes from `systemctl is-enabled/is-active` for ssh.service and
ssh.socket plus the listening sockets. Policy comes from /etc/ssh/sshd_config
and the files it includes (sshd -T needs root, and doctor never uses sudo).
sshd uses the first value it reads for a keyword; Match blocks are conditional.
"""

import os

SSHD_CONFIG = "/etc/ssh/sshd_config"
UNITS = ("ssh.service", "ssh.socket")
UNIT_DIRS = ("/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system")

_ENABLED_ON = {"enabled", "enabled-runtime", "linked", "linked-runtime"}
_ENABLED_OFF = {"disabled", "masked", "masked-runtime", "not-found"}
_ACTIVE_ON = {"active", "activating", "reloading", "refreshing", "deactivating"}
_ACTIVE_OFF = {"inactive", "failed"}

# Keywords that allow a password to be typed, and their values that do.
_PASSWORD_KEYWORDS = ("passwordauthentication", "kbdinteractiveauthentication", "permitemptypasswords")


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


def service_state(system, sockets, ports):
    """on, off or unknown. sockets is None when listeners could not be read."""
    states = [_unit_state(system, unit) for unit in UNITS]
    if sockets is not None and any(state == "0A" and port in ports for _, port, state in sockets):
        return "on"
    if "on" in states:
        return "on"
    if "unknown" in states or sockets is None:
        return "unknown"
    return "off"


def _resolve_include(pattern):
    return pattern if os.path.isabs(pattern) else os.path.join("/etc/ssh", pattern)


def read_directives(system, path=SSHD_CONFIG, depth=0):
    """[(keyword, args, in_match)] in file order, with Include expanded.

    Raises SshConfigUnreadable when any file cannot be read.
    """
    if depth > 8:
        raise SshConfigUnreadable()
    try:
        text = system.read_text(path)
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
                for included in system.glob(_resolve_include(pattern)):
                    for keyword2, args2, match2 in read_directives(system, included, depth + 1):
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
    found = []
    for name, args, in_match in directives:
        if name == "port" and not in_match:
            try:
                found.append(int(args.split()[0]))
            except (ValueError, IndexError):
                continue
    return found or [22]


def allows_password(directives):
    """True when sshd could accept a typed password or a root password login."""
    if effective(directives, "passwordauthentication", "yes") != "no":
        return True
    if effective(directives, "kbdinteractiveauthentication", "yes") != "no":
        return True
    if effective(directives, "permitemptypasswords", "no") != "no":
        return True
    if effective(directives, "permitrootlogin", "prohibit-password") == "yes":
        return True
    methods = effective(directives, "authenticationmethods", "any")
    if "password" in methods or "keyboard-interactive" in methods:
        return True
    for name, args, in_match in directives:
        if not in_match:
            continue
        value = args.lower()
        if name in _PASSWORD_KEYWORDS + ("challengeresponseauthentication",) and value != "no":
            return True
        if name == "permitrootlogin" and value == "yes":
            return True
        if name == "authenticationmethods" and ("password" in value or "keyboard-interactive" in value):
            return True
    return False
