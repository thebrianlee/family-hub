"""SSH server state and policy, from what an unprivileged user can read.

State comes from `systemctl is-enabled/is-active` for ssh.service,
sshd.service, ssh.socket and sshd.socket, plus listening sockets on port 22
and on every Port in the readable config. Policy comes from
/etc/ssh/sshd_config and the files it includes (sshd -T needs root, and
doctor never uses sudo). Any include that cannot be read or listed makes the
config unreadable, which is reported as unknown.
"""

import fnmatch
import os
import re
import shlex

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


def _unit_absent(system, unit):
    """True only when no unit file exists in any unit folder (ENOENT everywhere)."""
    return all(system.probe(os.path.join(directory, unit)) == "missing" for directory in UNIT_DIRS)


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
        elif word == "" and _unit_absent(system, unit):
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
    # The units are always read, even when a listener already decides "on", so
    # the result never depends on which source happened to be checked first.
    states = [_unit_state(system, unit) for unit in UNITS]
    if any(state == "0A" and port in ports for _, port, state in sockets):
        return "on"
    if "on" in states:
        return "on"
    if "unknown" in states or not sockets_complete:
        return "unknown"
    return "off"


_MAGIC = re.compile(r"[*?[]")


def wildcard_matches(system, folder, part):
    """Sorted paths in folder whose name matches the pattern part, as glob(3)
    matches by default: a leading "." only when the part starts with ".".
    The listing raises on any error (EIO, permissions), which makes the
    config unreadable; Python's glob would answer "no matches" instead.
    """
    try:
        names = system.listdir(folder)
    except OSError:
        raise SshConfigUnreadable() from None
    return [
        os.path.join(folder, name)
        for name in sorted(names)
        if (part.startswith(".") or not name.startswith(".")) and fnmatch.fnmatchcase(name, part)
    ]


def _resolve_include(pattern):
    return pattern if os.path.isabs(pattern) else os.path.join("/etc/ssh", pattern)


def include_files(system, pattern):
    """The files an Include pattern names, walking it one path part at a time.

    Only a path that does not exist (ENOENT, also for a missing parent
    folder) is skipped, as sshd skips it. Every other failure makes the
    config unreadable: a permission error, a path part that is not a
    folder, an I/O error, a folder that a wildcard has to list but cannot,
    or an included path that is a folder. glob and exists() would hide
    those as "not there", so folders are listed with a listing that raises
    and each path is probed with a stat that says why.
    """
    parts = [part for part in _resolve_include(pattern).split("/") if part]
    candidates = ["/"]
    for index, part in enumerate(parts):
        last = index == len(parts) - 1
        wildcard = bool(_MAGIC.search(part))
        following = []
        for folder in candidates:
            if wildcard:
                matches = wildcard_matches(system, folder, part)
            else:
                matches = [os.path.join(folder, part)]
            for match in matches:
                kind = system.probe(match)
                if kind == "missing":
                    continue
                if kind == "error":
                    raise SshConfigUnreadable()
                if last and kind == "file":
                    following.append(match)
                elif not last and kind == "dir":
                    following.append(match)
                elif last or not wildcard:
                    # An included folder, or a literal path part that is a
                    # file: sshd cannot read through either.
                    raise SshConfigUnreadable()
                # A wildcard part that matched a file on the way: no match.
        candidates = following
    return sorted(candidates)


def read_directives(system, path=SSHD_CONFIG, depth=0):
    """[(keyword, args, in_match)] in file order, with Include expanded.

    None when the main config does not exist (no SSH server installed).
    Raises SshConfigUnreadable when any file cannot be read or an include
    folder cannot be listed.
    """
    if depth > 8:
        raise SshConfigUnreadable()
    # open() reports why it failed: only ENOENT on the main config means "no
    # SSH server config"; for an included file it found, ENOENT now (a race)
    # and every other error are unreadable.
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
            try:
                patterns = shlex.split(args)  # sshd accepts quoted paths
            except ValueError:
                raise SshConfigUnreadable() from None
            for pattern in patterns:
                for included in include_files(system, pattern):
                    for keyword2, args2, match2 in read_directives(system, included, depth + 1) or []:
                        directives.append((keyword2, args2, match2 or in_match))
            continue
        directives.append((keyword, args, in_match))
    return directives


def _value(args):
    """A directive's argument as sshd compares it: lowercase, surrounding quotes removed.

    The parser keeps quotes, but sshd accepts quoted arguments, so
    PermitRootLogin "yes" means yes.
    """
    value = args.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].strip()
    return value.lower()


def effective(directives, keyword, default):
    """The first unconditional value of keyword (sshd's first-match rule)."""
    if keyword == "kbdinteractiveauthentication":
        names = ("kbdinteractiveauthentication", "challengeresponseauthentication")
    else:
        names = (keyword,)
    for name, args, in_match in directives:
        if name in names and not in_match:
            return _value(args)
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


def allows_root_or_empty_password(directives):
    """True when root may log in with a password, or empty passwords are allowed.

    Tier B (an install over SSH on the home network) accepts password logins
    until the final check, but never these two.
    """
    for name, args, _in_match in directives:
        value = _value(args)
        if name == "permitemptypasswords" and value != "no":
            return True
        if name == "permitrootlogin" and value == "yes":
            return True
    return False


def allows_password(directives):
    """True unless the config is key-only everywhere, Match blocks included."""
    if effective(directives, "passwordauthentication", "yes") != "no":
        return True
    if effective(directives, "kbdinteractiveauthentication", "yes") != "no":
        return True
    for name, args, in_match in directives:
        value = _value(args)
        if name in _PASSWORD_KEYWORDS and (value == "yes" or (in_match and value != "no")):
            return True
        if name == "permitemptypasswords" and value != "no":
            return True
        if name == "permitrootlogin" and value == "yes":
            return True
        if name == "authenticationmethods" and ("password" in value or "keyboard-interactive" in value):
            return True
    return False
