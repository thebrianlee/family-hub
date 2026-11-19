"""The files `setup kiosk` manages: pure text transforms, safe writes and the
private state folder (pre-install snapshot and hashes of what setup wrote).

Every managed file is rebuilt from its pre-install original each time setup
runs, so a second run cannot add a second launcher line or a second touch
entry. Nothing here prints anything.

Managed files (relative to the home folder):
  ~/.config/labwc/autostart   one launcher line (marker kiosk.KIOSK_MARKER);
                              swayidle (desktop blanking) lines removed
  ~/.config/labwc/rc.xml      one <touch deviceName mapToOutput/> entry
  ~/.config/kanshi/config     one profile with the output transform
  ~/.local/bin/sproutwall-kiosk   the launcher (a copy of kiosk_launcher.py)

Where Raspberry Pi OS keeps these settings. The official documentation
(raspberrypi/documentation@97485d97) says to set orientation in Control
Centre > Screens (computers/configuration/audio-display.adoc) but does not
name the file; it lists raspberrypi-ui/raindrop as "The screen configuration
plugin for Control Centre" (computers/software-sources.adoc). That plugin's
labwc backend (raspberrypi-ui/raindrop@4287e505, src/labwc.c) is the source
used here:
  - save_labwc_config() writes the output layout, including
    "transform 90|180|270|normal", as a kanshi profile to
    $XDG_CONFIG_HOME/kanshi/config, and reload_labwc_config() runs
    `pkill --signal SIGHUP kanshi`;
  - save_labwc_touchscreens() writes <touch deviceName="..." mapToOutput="..."/>
    into $XDG_CONFIG_HOME/labwc/rc.xml, and reload_labwc_touchscreens() runs
    `labwc --reconfigure`.
raspberrypi-ui/raspberrypi-ui-mods@667217eb usr/bin/labwc-pi creates an
empty ~/.config/kanshi/config at login and runs `labwc -m`; its
etc/xdg/labwc/autostart starts kanshi. labwc-config(5) documents <touch>,
--merge-config and SIGHUP reloading.
"""

import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

from . import kiosk

MANAGED = {
    "autostart": kiosk.KIOSK_AUTOSTART,
    "rc_xml": kiosk.KIOSK_RC_XML,
    "kanshi": kiosk.KIOSK_KANSHI,
    "launcher": kiosk.KIOSK_LAUNCHER,
}
# Order of writing: the launcher first, the autostart line last, so the
# launch line only appears once everything it needs is in place.
WRITE_ORDER = ("launcher", "kanshi", "rc_xml", "autostart")
DEFAULT_MODES = {"autostart": 0o644, "rc_xml": 0o644, "kanshi": 0o644, "launcher": 0o755}
MANIFEST = "manifest.json"
ORIGINALS = "original"
BROWSER_PROFILE = "browser"
STATE_SCHEMA = 1
LAUNCHER_TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kiosk_launcher.py")


class ManagedFileError(Exception):
    """A managed path is a link or not a regular file: never written through."""


class StateDamaged(Exception):
    pass


def sha256(data):
    return None if data is None else hashlib.sha256(data).hexdigest()


def launcher_bytes():
    with open(LAUNCHER_TEMPLATE, "rb") as handle:
        return handle.read()


# --- autostart -------------------------------------------------------------------


def decode_text(data):
    """Text of a config file; bytes that are not UTF-8 survive a round trip."""
    return data.decode("utf-8", "surrogateescape") if data else ""


def _encode(text):
    return text.encode("utf-8", "surrogateescape")


def autostart_text(base, enabled):
    """The original autostart with blanking removed and one launcher line.

    Kept: every other line, byte for byte, including the desktop's own
    entries and comments. Removed: active swayidle lines (desktop blanking,
    as Control Centre and raspi-config write it) and any earlier marker line.
    Added: the launcher line at the end, as a comment when enabled is False.
    """
    from .kiosk_detect import is_blanking_line

    kept = []
    for line in decode_text(base).splitlines(keepends=True):
        if kiosk.KIOSK_MARKER in line or is_blanking_line(line):
            continue
        kept.append(line)
    if kept and not kept[-1].endswith(("\n", "\r")):
        kept[-1] += "\n"
    kept.append((kiosk.LAUNCH_LINE if enabled else kiosk.LAUNCH_LINE_OFF) + "\n")
    return _encode("".join(kept))


# --- labwc rc.xml ----------------------------------------------------------------------

TOUCH_MARK = "<!-- sproutwall:kiosk-touch -->"
RC_ROOTS = ("openbox_config", "labwc_config")
RC_NAMESPACE = "http://openbox.org/3.4/rc"
_MANAGED_TOUCH_RE = re.compile(
    r"^[ \t]*" + re.escape(TOUCH_MARK) + r"[ \t]*\r?\n[ \t]*<touch\b[^>]*/>[ \t]*(?:\r?\n|$)", re.MULTILINE
)
_ROOT_CLOSE_RE = re.compile(r"</\s*(?:[A-Za-z_][\w.-]*:)?(?:openbox_config|labwc_config)\s*>")


class RcXmlError(Exception):
    """rc.xml cannot be merged safely (not well-formed, unknown root, empty root)."""


def _attr(value):
    return '"' + escape(value, {'"': "&quot;"}) + '"'


def touch_element(device, connector):
    """The spec's element. mouseEmulation is left out, so labwc's default
    (off: Chromium gets real touch events, and swipes scroll) applies. As the
    last entry for the device it also replaces the mouseEmulation="yes" that
    Raspberry Pi OS's /etc/xdg/labwc/rc.xml sets for its own DSI panels."""
    return "<touch deviceName=%s mapToOutput=%s />" % (_attr(device), _attr(connector))


def _parse_rc(data):
    try:
        root = ET.fromstring(data)
    except ET.ParseError as error:
        raise RcXmlError("not well-formed") from error
    if root.tag.rpartition("}")[2] not in RC_ROOTS:
        raise RcXmlError("unknown root")
    return root


def rc_xml_text(base, device, connector):
    """The original rc.xml with one managed <touch/> entry before the root's end tag.

    A text merge, not ElementTree: ElementTree would drop the XML
    declaration's formatting and rewrite the default namespace as ns0:,
    attribute quoting and spacing, so every unrelated line would change.
    Here the original bytes stay as they are; ElementTree only checks that
    the original and the result are well-formed, have a labwc root, and that
    the last <touch> for the device (the one labwc uses: it searches its
    touch list from the end, and with --merge-config reads the user's file
    after /etc/xdg/labwc/rc.xml) maps to the connector.
    """
    block = "  " + TOUCH_MARK + "\n  " + touch_element(device, connector) + "\n"
    if base is None:
        text = '<?xml version="1.0" encoding="UTF-8"?>\n<openbox_config xmlns="%s">\n%s</openbox_config>\n' % (
            RC_NAMESPACE,
            block,
        )
    else:
        _parse_rc(base)
        try:
            original = base.decode("utf-8")
        except UnicodeDecodeError as error:
            raise RcXmlError("not utf-8") from error
        original = _MANAGED_TOUCH_RE.sub("", original)
        ends = list(_ROOT_CLOSE_RE.finditer(original))
        if not ends:
            raise RcXmlError("no end tag")  # e.g. a self-closing root
        cut = ends[-1].start()
        head, tail = original[:cut], original[cut:]
        line_start = head.rfind("\n") + 1
        if head[line_start:].strip():
            # The end tag shares a line with other content: ours starts on a new line.
            text = head + "\n" + block + tail
        else:
            # Insert whole lines above the end tag, keeping its own indentation.
            text = head[:line_start] + block + head[line_start:] + tail
    data = text.encode("utf-8")
    if effective_touch_output([data], device) != connector:
        raise RcXmlError("merge check failed")
    return data


def effective_touch_output(rc_files, device):
    """The output labwc maps device to, from rc.xml files in reading order
    (system first, then the user's: labwc -m), or None. The last entry whose
    deviceName matches (case-insensitively, as labwc compares) wins. A file
    that does not parse raises RcXmlError (never "not mapped")."""
    found = None
    for data in rc_files:
        if data is None:
            continue
        root = _parse_rc(data)  # RcXmlError: the mapping cannot be told
        for element in root:
            if element.tag.rpartition("}")[2] != "touch":
                continue
            name = element.get("deviceName")
            if name is not None and name.lower() == device.lower():
                found = element.get("mapToOutput")
    return found


# --- kanshi config -----------------------------------------------------------------------

KANSHI_BEGIN = "# sproutwall:kiosk-output begin (managed by sproutwall setup kiosk)"
KANSHI_END = "# sproutwall:kiosk-output end"
KANSHI_PROFILE = "sproutwall-kiosk"
_KANSHI_BLOCK_RE = re.compile(
    r"^" + re.escape(KANSHI_BEGIN) + r"\r?\n.*?^" + re.escape(KANSHI_END) + r"[ \t]*(?:\r?\n|$)\r?\n?", re.MULTILINE | re.DOTALL
)


def kanshi_text(base, connector, transform):
    """The original kanshi config with the kiosk profile first.

    kanshi applies the first profile whose outputs match the connected ones
    exactly (kanshi main.c match()), so the one-output kiosk profile goes on
    top and every other profile stays below, unchanged. Only the transform is
    set; mode, position and scale stay as the compositor chose them, so a
    replacement panel on the same connector still matches.
    """
    rest = _KANSHI_BLOCK_RE.sub("", decode_text(base))
    block = "%s\nprofile %s {\n\toutput %s enable transform %s\n}\n%s\n" % (
        KANSHI_BEGIN,
        KANSHI_PROFILE,
        connector,
        transform,
        KANSHI_END,
    )
    if rest.strip():
        block += "\n"
    return _encode(block + rest)


# --- files on disk ------------------------------------------------------------------------
#
# Every path below the home folder is reached one component at a time from
# an open folder, with O_NOFOLLOW, so a link anywhere is refused rather than
# followed. Only ENOENT means "not there"; any other failure propagates as
# OSError and callers stop without editing.

HASH_RE = re.compile(r"[0-9a-f]{64}", re.ASCII)
TMP_SUFFIX = ".sproutwall-tmp"
QUARANTINE_SUFFIX = ".sproutwall-removed"
PROBE_NAME = "sproutwall-probe"
MAX_FILE = 4 * 1024 * 1024
CLOEXEC = getattr(os, "O_CLOEXEC", 0)
DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW | CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | CLOEXEC


class WriteCheckFailed(Exception):
    """A file read back after writing did not have the bytes and mode just written."""


class ChangedMeanwhile(Exception):
    """A managed file changed between the check and the write; the user's version stays."""


class KeptAside(Exception):
    """A changed file could not be put back under its own name (a new file
    took the name), so it was left under a hidden name in the same folder."""


class UnsupportedMetadata(Exception):
    """A managed file has extra hard links, another owner or group, or
    extended attributes (ACLs), which this tool cannot keep exactly."""


class RenameUnsupported(Exception):
    """renameat2() with RENAME_EXCHANGE / RENAME_NOREPLACE is not available here."""


class StateLink(Exception):
    """A link, or an entry of the wrong kind, inside the state folder."""


def open_dir(home, rel, create=None, mode=0o755):
    """An open folder fd for home/rel, reached one component at a time with
    O_NOFOLLOW. ENOENT raises FileNotFoundError unless create is a list:
    then missing folders are made with mode and recorded there (relative).
    A link or a non-folder on the way raises ManagedFileError."""
    fd = os.open(home, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | CLOEXEC)
    done = []
    try:
        for part in [p for p in rel.split(os.sep) if p]:
            done.append(part)
            try:
                nfd = os.open(part, DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if create is None:
                    raise
                os.mkdir(part, mode, dir_fd=fd)
                create.append(os.path.join(*done))
                nfd = os.open(part, DIR_FLAGS, dir_fd=fd)
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise ManagedFileError("not a folder") from error
                raise
            os.close(fd)
            fd = nfd
    except BaseException:
        os.close(fd)
        raise
    return fd


def open_subdir(dir_fd, name):
    """A folder fd for name inside dir_fd, with O_NOFOLLOW (StateLink for a link)."""
    try:
        return os.open(name, DIR_FLAGS, dir_fd=dir_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise StateLink(name) from error
        raise


def _xattrs(fd):
    """The extended attribute names of an open file. A file system without
    xattr support (ENOTSUP) has none; any other failure raises."""
    lister = getattr(os, "listxattr", None)
    if lister is None:
        raise OSError(errno.ENOSYS, "no listxattr")
    try:
        return tuple(sorted(lister(fd)))
    except OSError as error:
        if error.errno in (errno.ENOTSUP, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)):
            return ()
        raise


class Seen:
    """What a path held when it was observed: a regular file's bytes and
    sha256, permission bits, owner, group, link count, extended attribute
    names and identity (device, inode, change times), or nothing (ENOENT).
    The change times matter because a freed inode number can be reused at
    once by the next file saved there."""

    __slots__ = ("exists", "data", "sha256", "mode", "uid", "gid", "nlink", "dev", "ino", "mtime", "ctime", "xattrs")

    def __init__(self, exists, data=None, st=None, xattrs=()):
        self.exists = exists
        self.data = data if exists else None
        self.sha256 = sha256(data) if exists else None
        self.mode = st.st_mode & 0o7777 if exists else None
        self.uid = st.st_uid if exists else None
        self.gid = st.st_gid if exists else None
        self.nlink = st.st_nlink if exists else None
        self.dev = st.st_dev if exists else None
        self.ino = st.st_ino if exists else None
        self.mtime = st.st_mtime_ns if exists else None
        self.ctime = st.st_ctime_ns if exists else None
        self.xattrs = tuple(xattrs) if exists else ()

    def state(self):
        """The manifest form: existence, sha256, mode, owner and group."""
        return {"exists": self.exists, "sha256": self.sha256, "mode": self.mode, "uid": self.uid, "gid": self.gid}

    def _key(self, with_ctime):
        key = (self.exists, self.sha256, self.mode, self.uid, self.gid, self.nlink, self.dev, self.ino, self.mtime, self.xattrs)
        return key + (self.ctime,) if with_ctime else key

    def same_file(self, other):
        """Exactly the same file: bytes, metadata and identity."""
        return self._key(True) == other._key(True)

    def same_moved(self, other):
        """The same file after a rename, which changes only its ctime."""
        return self._key(False) == other._key(False)


ABSENT = Seen(False)


def observe_at(dir_fd, name):
    """Seen for name in an open folder. ENOENT is ABSENT. A link, a folder
    or any other non-regular file raises ManagedFileError; other failures
    raise OSError. Never blocks on a FIFO."""
    try:
        fd = os.open(name, FILE_FLAGS, dir_fd=dir_fd)
    except FileNotFoundError:
        return ABSENT
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.EISDIR, errno.ENXIO):
            raise ManagedFileError("not a regular file") from error
        raise
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ManagedFileError("not a regular file")
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_FILE:
                raise ManagedFileError("too large")
            chunks.append(chunk)
        attrs = _xattrs(fd)
    finally:
        os.close(fd)
    return Seen(True, b"".join(chunks), st, attrs)


def observe(home, rel):
    """Seen for home/rel; a missing folder on the way is ABSENT."""
    try:
        dfd = open_dir(home, os.path.dirname(rel))
    except FileNotFoundError:
        return ABSENT
    try:
        return observe_at(dfd, os.path.basename(rel))
    finally:
        os.close(dfd)


def read_file(home, rel):
    """bytes, or None when absent (ENOENT). Raises like observe()."""
    seen = observe(home, rel)
    return seen.data if seen.exists else None


def check_supported(seen):
    """UnsupportedMetadata unless an existing file has one link, this user
    as owner and group, and no extended attributes (no ACL): only then can
    the tool put it back exactly as it was."""
    if seen.exists and (seen.nlink != 1 or seen.uid != os.getuid() or seen.gid != os.getgid() or seen.xattrs):
        raise UnsupportedMetadata("metadata")


def file_state(data, mode):
    """The manifest form of a planned file (data None: the file must not
    exist). New files belong to this user and group."""
    if data is None:
        return {"exists": False, "sha256": None, "mode": None, "uid": None, "gid": None}
    return {"exists": True, "sha256": sha256(data), "mode": mode, "uid": os.getuid(), "gid": os.getgid()}


def matches(seen, state):
    """seen is exactly the planned or recorded state: existence, bytes, mode, owner, group."""
    return seen.state() == state


# --- renameat2 ----------------------------------------------------------------------------------

RENAME_NOREPLACE = 1
RENAME_EXCHANGE = 2
_RENAMEAT2 = []


def _renameat2_function():
    """glibc's renameat2 (2.28 and later; Raspberry Pi OS Bookworm has 2.36), or None."""
    if not _RENAMEAT2:
        function = None
        try:
            import ctypes

            libc = ctypes.CDLL(None, use_errno=True)
            function = getattr(libc, "renameat2", None)
            if function is not None:
                function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
                function.restype = ctypes.c_int
        except (ImportError, OSError, AttributeError):
            function = None
        _RENAMEAT2.append(function)
    return _RENAMEAT2[0]


def renameat2(src_dir_fd, src, dst_dir_fd, dst, flags):
    """renameat2(2). RENAME_EXCHANGE swaps two names atomically;
    RENAME_NOREPLACE fails with FileExistsError instead of replacing. Not
    available (no libc symbol, ENOSYS, EINVAL, EOPNOTSUPP): RenameUnsupported."""
    function = _renameat2_function()
    if function is None:
        raise RenameUnsupported("no renameat2")
    import ctypes

    if function(src_dir_fd, os.fsencode(src), dst_dir_fd, os.fsencode(dst), flags) != 0:
        err = ctypes.get_errno()
        if err in (errno.ENOSYS, errno.EINVAL, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP), errno.ENOTSUP):
            raise RenameUnsupported(errno.errorcode.get(err, "error"))
        raise OSError(err, os.strerror(err))


def _write_temp(dir_fd, name, data, mode, suffix=TMP_SUFFIX):
    """A new hidden file next to name with data, mode and fsync; returns its name."""
    for _ in range(100):
        tmp = ".%s.%s%s" % (name, secrets.token_hex(6), suffix)
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | CLOEXEC, 0o600, dir_fd=dir_fd)
        except FileExistsError:
            continue
        break
    else:
        raise FileExistsError(errno.EEXIST, "no free temporary name")
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view) :]
        os.fchmod(fd, mode & 0o7777)
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        _unlink_quietly(dir_fd, tmp)
        raise
    os.close(fd)
    return tmp


def _unlink_quietly(dir_fd, name):
    try:
        os.unlink(name, dir_fd=dir_fd)
    except FileNotFoundError:
        pass


def probe_rename_support(home, rels):
    """Before any write: each file system that will hold a managed file
    must support renameat2 RENAME_EXCHANGE and RENAME_NOREPLACE (checked
    with two hidden probe files, removed again, in the nearest existing
    folder), and no such folder may be setgid to another group (new files
    would get that group). RenameUnsupported or UnsupportedMetadata."""
    probed = set()
    for rel in rels:
        parent = os.path.dirname(rel)
        while True:
            try:
                dfd = open_dir(home, parent)
                break
            except FileNotFoundError:
                if not parent:
                    raise
                parent = os.path.dirname(parent)
        try:
            st = os.fstat(dfd)
            if st.st_mode & stat.S_ISGID and st.st_gid != os.getgid():
                raise UnsupportedMetadata("setgid folder")
            if st.st_dev in probed:
                continue
            probed.add(st.st_dev)
            first = _write_temp(dfd, PROBE_NAME, b"1", 0o600)
            second = None
            try:
                second = _write_temp(dfd, PROBE_NAME, b"2", 0o600)
                before = os.stat(first, dir_fd=dfd, follow_symlinks=False).st_ino
                renameat2(dfd, first, dfd, second, RENAME_EXCHANGE)
                if os.stat(second, dir_fd=dfd, follow_symlinks=False).st_ino != before:
                    raise RenameUnsupported("exchange did not swap")
                try:
                    renameat2(dfd, first, dfd, second, RENAME_NOREPLACE)
                except FileExistsError:
                    pass
                else:
                    second = None  # it replaced the second probe: not safe
                    raise RenameUnsupported("noreplace replaced")
            finally:
                _unlink_quietly(dfd, first)
                if second is not None:
                    _unlink_quietly(dfd, second)
        finally:
            os.close(dfd)


def write_atomic(home, rel, data, mode, expect):
    """Write data to home/rel so that a version saved by someone else at the
    same moment is never lost.

    expect: the Seen verified for the path (ABSENT if it must not exist).
    1. data goes to a new hidden file in the same folder (fsync, mode).
    2. The path is observed again (bytes, metadata, identity) and must
       still be exactly expect.
    3. An existing file is swapped with the new one in one step
       (renameat2 RENAME_EXCHANGE); a missing one is created only if still
       missing (RENAME_NOREPLACE).
    4. The file that was swapped out is checked against expect. If someone
       saved between 2 and 3, it is theirs: it is swapped back, the new file
       is removed and ChangedMeanwhile is raised. Only verified bytes are
       ever deleted.
    5. The folder is fsync-ed and the result read back."""
    dfd = open_dir(home, os.path.dirname(rel))
    name = os.path.basename(rel)
    try:
        tmp = _write_temp(dfd, name, data, mode)
        ours_at_tmp = True
        try:
            current = observe_at(dfd, name)
            if not current.same_file(expect):
                raise ChangedMeanwhile("changed before the swap")
            check_supported(current)
            if not expect.exists:
                try:
                    renameat2(dfd, tmp, dfd, name, RENAME_NOREPLACE)
                except FileExistsError as error:
                    raise ChangedMeanwhile("created meanwhile") from error
                ours_at_tmp = False
            else:
                renameat2(dfd, tmp, dfd, name, RENAME_EXCHANGE)
                ours_at_tmp = False  # tmp now holds the file that was there
                try:
                    previous = observe_at(dfd, tmp)
                    verified = previous.same_moved(expect)
                except (OSError, ManagedFileError):
                    verified = False
                if not verified:
                    try:
                        renameat2(dfd, tmp, dfd, name, RENAME_EXCHANGE)
                    except BaseException as error:
                        raise KeptAside("could not swap back") from error
                    ours_at_tmp = True
                    raise ChangedMeanwhile("changed in the window")
                os.unlink(tmp, dir_fd=dfd)
        finally:
            if ours_at_tmp:
                _unlink_quietly(dfd, tmp)
        os.fsync(dfd)
        after = observe_at(dfd, name)
        if not matches(after, file_state(data, mode)) or after.nlink != 1:
            raise WriteCheckFailed("read-back differs")
    finally:
        os.close(dfd)


def remove_file(home, rel, expect):
    """Delete home/rel without ever deleting bytes that were not verified.

    The file is moved in one step to a hidden quarantine name in the same
    folder (RENAME_NOREPLACE), checked there against expect, and only then
    unlinked. If it is not the expected file (someone saved meanwhile), it
    is moved back (RENAME_NOREPLACE) and ChangedMeanwhile is raised; if a
    new file has taken the name in the meantime, it stays in quarantine and
    KeptAside is raised."""
    try:
        dfd = open_dir(home, os.path.dirname(rel))
    except FileNotFoundError:
        if expect.exists:
            raise ChangedMeanwhile("folder gone") from None
        return
    name = os.path.basename(rel)
    try:
        current = observe_at(dfd, name)
        if not current.same_file(expect):
            raise ChangedMeanwhile("changed before the move")
        if not current.exists:
            return
        check_supported(current)
        for _ in range(100):
            quarantine = ".%s.%s%s" % (name, secrets.token_hex(6), QUARANTINE_SUFFIX)
            try:
                renameat2(dfd, name, dfd, quarantine, RENAME_NOREPLACE)
                break
            except FileExistsError:
                continue
        else:
            raise FileExistsError(errno.EEXIST, "no free quarantine name")
        try:
            moved = observe_at(dfd, quarantine)
            verified = moved.same_moved(expect)
        except (OSError, ManagedFileError):
            verified = False
        if not verified:
            try:
                renameat2(dfd, quarantine, dfd, name, RENAME_NOREPLACE)
            except FileExistsError as error:
                raise KeptAside("name taken again") from error
            raise ChangedMeanwhile("changed in the window")
        os.unlink(quarantine, dir_fd=dfd)
        os.fsync(dfd)
        if observe_at(dfd, name).exists:
            raise ChangedMeanwhile("created meanwhile")
    finally:
        os.close(dfd)


def write_state_file(dir_fd, name, data, mode=0o600):
    """A private file in the state folder (held under the run lock): temp
    file, fsync, rename by folder fd (a link at name is replaced, never
    followed), fsync the folder, read back."""
    tmp = _write_temp(dir_fd, name, data, mode)
    try:
        os.rename(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    except BaseException:
        _unlink_quietly(dir_fd, tmp)
        raise
    os.fsync(dir_fd)
    after = observe_at(dir_fd, name)
    if not after.exists or after.data != data or after.mode != mode:
        raise WriteCheckFailed("state file read-back differs")
    return after


def assert_no_links(home, rels):
    """ManagedFileError if any existing part of home/rel is a link or a
    non-folder where a folder is needed. ENOENT ends the walk for that path;
    other failures raise OSError."""
    for rel in rels:
        parts = rel.split(os.sep)
        for index in range(1, len(parts) + 1):
            path = os.path.join(home, *parts[:index])
            try:
                st = os.lstat(path)
            except FileNotFoundError:
                break
            if stat.S_ISLNK(st.st_mode):
                raise ManagedFileError("link")
            if index < len(parts) and not stat.S_ISDIR(st.st_mode):
                raise ManagedFileError("not a folder")


def missing_dirs(home, rel):
    """The folders (relative) that make_dirs(home, rel) would create, outermost first."""
    parts = [p for p in rel.split(os.sep) if p]
    missing = []
    for index in range(1, len(parts) + 1):
        sub = os.path.join(*parts[:index])
        try:
            st = os.lstat(os.path.join(home, sub))
        except FileNotFoundError:
            missing.append(sub)
            continue
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            raise ManagedFileError("not a folder")
    return missing


def make_dirs(home, rel, mode, created):
    """Create home/rel and missing parents (no links followed); record each created one."""
    os.close(open_dir(home, rel, create=created, mode=mode))


def remove_created_dirs(home, created):
    """Remove folders setup created, deepest first, only while they are
    empty, each through its parent folder fd (no links followed). True if
    all of them are gone."""
    gone = True
    for sub in sorted(set(created), key=lambda s: s.count(os.sep), reverse=True):
        try:
            dfd = open_dir(home, os.path.dirname(sub))
        except FileNotFoundError:
            continue
        except (OSError, ManagedFileError):
            gone = False
            continue
        try:
            os.rmdir(os.path.basename(sub), dir_fd=dfd)
        except FileNotFoundError:
            pass
        except OSError:
            gone = False  # not empty (someone else's files) or not a folder: leave it
        finally:
            os.close(dfd)
    return gone


def _empty_dir_fd(dir_fd):
    """Remove everything inside an open folder; links are removed, never followed."""
    for entry in list(os.scandir(dir_fd)):
        st = os.stat(entry.name, dir_fd=dir_fd, follow_symlinks=False)
        if stat.S_ISDIR(st.st_mode):
            sub = open_subdir(dir_fd, entry.name)
            try:
                _empty_dir_fd(sub)
            finally:
                os.close(sub)
            os.rmdir(entry.name, dir_fd=dir_fd)
        else:
            os.unlink(entry.name, dir_fd=dir_fd)


# --- state folder ---------------------------------------------------------------------------

PHASES = ("init", "writing", "done")
OPERATIONS = ("setup", "off", "undo")
AUTOLOGIN_STATES = ("on", "off", "other_user", "unknown")
SETUP_LOCK = "setup.lock"
RUN_DIR = "run"
LAUNCHER_LOCK = "launcher.lock"
WAIT_PAGE = "starting.html"
# The launcher's files, made by setup in RUN_DIR (kiosk_launcher.py: LOCK_FILE, WAIT_PAGE).
LAUNCHER_RUN_FILES = (LAUNCHER_LOCK, WAIT_PAGE)
STATE_SUBDIRS = (ORIGINALS, RUN_DIR, BROWSER_PROFILE)


def state_rel(*parts):
    return os.path.join(kiosk.KIOSK_STATE_DIR, *parts)


def wait_page_bytes():
    from .kiosk_launcher import WAIT_HTML

    return WAIT_HTML.encode("utf-8")


def allowed_created_dirs():
    """Every folder setup may create: the parents of the managed files, the
    state folder and its subfolders."""
    allowed = set()
    rels = list(MANAGED.values()) + [state_rel(sub, "x") for sub in STATE_SUBDIRS]
    for rel in rels:
        parts = rel.split(os.sep)[:-1]
        for index in range(1, len(parts) + 1):
            allowed.add(os.path.join(*parts[:index]))
    return allowed


def allowed_created_files():
    return (
        {state_rel(SETUP_LOCK)}
        | {state_rel(ORIGINALS, key) for key in MANAGED}
        | {state_rel(RUN_DIR, name) for name in LAUNCHER_RUN_FILES}
    )


def _valid_hash(value):
    return isinstance(value, str) and HASH_RE.fullmatch(value) is not None


def _valid_int(value, top):
    return type(value) is int and 0 <= value <= top


def _valid_state(value):
    if not isinstance(value, dict) or set(value) != {"exists", "sha256", "mode", "uid", "gid"} or type(value["exists"]) is not bool:
        return False
    if not value["exists"]:
        return all(value[key] is None for key in ("sha256", "mode", "uid", "gid"))
    return (
        _valid_hash(value["sha256"])
        and _valid_int(value["mode"], 0o7777)
        and _valid_int(value["uid"], 2**32)
        and _valid_int(value["gid"], 2**32)
    )


def _valid_created_file(value):
    """{"sha256", "mode", "dev", "ino"}: what setup wrote; dev and ino once known."""
    if not isinstance(value, dict) or set(value) != {"sha256", "mode", "dev", "ino"}:
        return False
    if not _valid_hash(value["sha256"]) or not _valid_int(value["mode"], 0o7777):
        return False
    if value["dev"] is None and value["ino"] is None:
        return True
    return _valid_int(value["dev"], 2**64) and _valid_int(value["ino"], 2**64)


MANIFEST_KEYS = {
    "schema",
    "phase",
    "operation",
    "enabled",
    "orientation",
    "connector",
    "transform",
    "touch_device",
    "autologin_before",
    "created_dirs",
    "created_files",
    "files",
}
FILE_KEYS = {"original", "installed", "previous", "target"}


def validate_manifest(data):
    """Raise StateDamaged unless data is exactly a manifest this version writes.

    phase "init": written right after setup created the state folder; each
    file has only its "original". phase "writing": a run is in progress;
    each file has "previous" (what it held when the run started) and
    "target". phase "done": each file has "installed"."""
    from . import kiosk_detect as det

    def need(condition, what):
        if not condition:
            raise StateDamaged(what)

    need(isinstance(data, dict), "object")
    need(set(data) == MANIFEST_KEYS, "keys")
    need(data["schema"] == STATE_SCHEMA and type(data["schema"]) is int, "schema")
    need(data["phase"] in PHASES, "phase")
    need(data["operation"] in OPERATIONS, "operation")
    need(type(data["enabled"]) is bool, "enabled")
    need(data["orientation"] in det.ORIENTATIONS, "orientation")
    need(isinstance(data["connector"], str) and det.CONNECTOR_RE.fullmatch(data["connector"]) is not None, "connector")
    need(data["transform"] in det.KIOSK_TRANSFORMS, "transform")
    need(isinstance(data["touch_device"], str) and det.DEVICE_NAME_RE.fullmatch(data["touch_device"]) is not None, "touch")
    need(data["autologin_before"] in AUTOLOGIN_STATES, "autologin")
    dirs = data["created_dirs"]
    need(isinstance(dirs, list) and all(d in allowed_created_dirs() for d in dirs) and len(set(dirs)) == len(dirs), "dirs")
    created = data["created_files"]
    need(isinstance(created, dict) and set(created) <= allowed_created_files(), "created files")
    need(all(_valid_created_file(v) for v in created.values()), "created file")
    files = data["files"]
    need(isinstance(files, dict) and set(files) == set(MANAGED), "files")
    for key, entry in files.items():
        need(isinstance(entry, dict) and set(entry) == FILE_KEYS, "entry keys")
        need(_valid_state(entry["original"]), "original")
        if key == "launcher":
            need(not entry["original"]["exists"], "launcher original")
        if data["phase"] == "init":
            need(entry["installed"] is None and entry["previous"] is None and entry["target"] is None, "init entry")
        elif data["phase"] == "done":
            need(_valid_state(entry["installed"]) and entry["previous"] is None and entry["target"] is None, "done entry")
        else:
            need(entry["installed"] is None and _valid_state(entry["previous"]) and _valid_state(entry["target"]), "writing entry")
    return data


def accepted_states(manifest, key):
    """The states a managed file may legitimately be in: what the last run
    left; right after the state folder was made, its original; while a run
    is in progress, what it held before that run, its original, or the
    run's target (so the same command can finish the job)."""
    entry = manifest["files"][key]
    if manifest["phase"] == "init":
        return [entry["original"]]
    if manifest["phase"] == "done":
        return [entry["installed"]]
    return [entry["original"], entry["previous"], entry["target"]]


def changed_since_setup(manifest, seen):
    """The managed files (keys) not in an accepted state (bytes, mode, owner, group, existence)."""
    return [key for key in MANAGED if not any(matches(seen[key], s) for s in accepted_states(manifest, key))]


class Busy(Exception):
    """Another setup kiosk run holds the lock."""


class StateExists(Exception):
    """The state folder appeared between the check and its creation."""


def record_of(seen):
    """The manifest record of a file setup made in the state folder."""
    return {"sha256": seen.sha256, "mode": seen.mode, "dev": seen.dev, "ino": seen.ino}


def lock_fd(state_fd, create=False, shared=False):
    """An flock on setup.lock (exclusive, or shared for the launcher),
    without waiting (Busy). After locking, the name must still be the
    locked file, so a lock file removed and recreated by a finishing run
    cannot let two runs in at once. create: make it (O_EXCL)."""
    flags = os.O_RDWR | os.O_NOFOLLOW | CLOEXEC | ((os.O_CREAT | os.O_EXCL) if create else 0)
    try:
        fd = os.open(SETUP_LOCK, flags, 0o600, dir_fd=state_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.EISDIR, errno.ENXIO):
            raise StateLink(SETUP_LOCK) from error
        raise
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise StateLink(SETUP_LOCK)
        try:
            fcntl.flock(fd, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Busy("locked") from error
        locked = os.fstat(fd)
        named = os.stat(SETUP_LOCK, dir_fd=state_fd, follow_symlinks=False)
        if (locked.st_dev, locked.st_ino) != (named.st_dev, named.st_ino):
            raise Busy("replaced")
    except BaseException:
        os.close(fd)
        raise
    return fd


class State:
    """~/.local/state/sproutwall/kiosk: manifest.json, original/<key>,
    setup.lock, run/ (the launcher's lock and waiting page) and browser/
    (the kiosk browser's profile). Every access goes through folder fds with
    O_NOFOLLOW; a link inside raises StateLink."""

    def __init__(self, home):
        self.home = home
        self.dir = os.path.join(home, kiosk.KIOSK_STATE_DIR)
        self.fd = None  # the open state folder, while a run holds it

    def path(self, key):
        return os.path.join(self.home, MANAGED[key])

    def profile_dir(self):
        return os.path.join(self.dir, BROWSER_PROFILE)

    def open(self):
        """Open the state folder (FileNotFoundError if absent)."""
        try:
            self.fd = open_dir(self.home, kiosk.KIOSK_STATE_DIR)
        except ManagedFileError as error:
            raise StateLink("state folder") from error
        return self.fd

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def classify(self):
        """"absent", "manifest", or "foreign": a state folder without a
        manifest (even an empty one) or a launcher without a record.
        StateLink for links in the state folder; ManagedFileError for a link
        at the launcher; OSError otherwise."""
        launcher = observe(self.home, kiosk.KIOSK_LAUNCHER).exists
        try:
            fd = open_dir(self.home, kiosk.KIOSK_STATE_DIR)
        except FileNotFoundError:
            return "foreign" if launcher else "absent"
        except ManagedFileError as error:
            raise StateLink("state folder") from error
        try:
            try:
                manifest = observe_at(fd, MANIFEST)
            except ManagedFileError as error:
                raise StateLink(MANIFEST) from error
        finally:
            os.close(fd)
        return "manifest" if manifest.exists else "foreign"

    def create(self, created_dirs):
        """Make the state folder for a first setup: its parents as needed,
        then the folder itself with mkdir, which fails if it exists
        (StateExists). Records what it made; leaves it open in self.fd."""
        parent = open_dir(self.home, os.path.dirname(kiosk.KIOSK_STATE_DIR), create=created_dirs, mode=0o700)
        try:
            try:
                os.mkdir(os.path.basename(kiosk.KIOSK_STATE_DIR), 0o700, dir_fd=parent)
            except FileExistsError as error:
                raise StateExists("exists") from error
            created_dirs.append(kiosk.KIOSK_STATE_DIR)
            self.fd = open_subdir(parent, os.path.basename(kiosk.KIOSK_STATE_DIR))
        finally:
            os.close(parent)
        return self.fd

    def load(self):
        try:
            seen = observe_at(self.fd, MANIFEST)
        except ManagedFileError as error:
            raise StateLink(MANIFEST) from error
        if not seen.exists:
            raise StateDamaged("manifest missing")
        try:
            parsed = kiosk.loads_strict(seen.data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise StateDamaged("manifest json") from error
        return validate_manifest(parsed)

    def save(self, manifest):
        validate_manifest(manifest)
        write_state_file(self.fd, MANIFEST, json.dumps(manifest, indent=1, sort_keys=True).encode("utf-8"))

    def subdir(self, name, create=False, created_dirs=None):
        """An open subfolder (FileNotFoundError if absent and not create)."""
        try:
            return open_subdir(self.fd, name)
        except FileNotFoundError:
            if not create:
                raise
            os.mkdir(name, 0o700, dir_fd=self.fd)
            if created_dirs is not None and state_rel(name) not in created_dirs:
                created_dirs.append(state_rel(name))
            return open_subdir(self.fd, name)

    def _parent(self, rel):
        """(open folder fd, name) for rel inside the state folder, each folder
        reached with O_NOFOLLOW (StateLink for a link). The caller closes
        the fd if it is not self.fd."""
        parts = rel.split(os.sep)
        fd = self.fd
        try:
            for part in parts[:-1]:
                nfd = open_subdir(fd, part)
                if fd != self.fd:
                    os.close(fd)
                fd = nfd
        except BaseException:
            if fd != self.fd:
                os.close(fd)
            raise
        return fd, parts[-1]

    def _done(self, fd):
        if fd != self.fd:
            os.close(fd)

    def observe_created(self, rel):
        """Seen for a file inside the state folder (rel relative to it);
        ABSENT if it or its folder is missing. StateLink for a link."""
        try:
            fd, name = self._parent(rel)
        except FileNotFoundError:
            return ABSENT
        try:
            return observe_at(fd, name)
        except ManagedFileError as error:
            raise StateLink(rel) from error
        finally:
            self._done(fd)

    def check_dirs(self):
        """StateLink unless each subfolder that exists is a real folder."""
        for name in STATE_SUBDIRS:
            try:
                os.close(open_subdir(self.fd, name))
            except FileNotFoundError:
                pass

    def write_created(self, rel, data, mode=0o600):
        """Write a state file (rel inside the state folder) and return its record."""
        fd, name = self._parent(rel)
        try:
            seen = write_state_file(fd, name, data, mode)
        finally:
            self._done(fd)
        return record_of(seen)

    def record(self, rel):
        """The record of a state file as it is now (rel inside the state folder)."""
        return record_of(self.observe_created(rel))

    def original_bytes(self, manifest, key, seen):
        """The pre-install bytes: the file itself while it is still exactly
        the original, else the saved copy (checked against its hash)."""
        original = manifest["files"][key]["original"]
        if not original["exists"]:
            return None
        if matches(seen, original):
            return seen.data
        copy = self.observe_created(os.path.join(ORIGINALS, key))
        if not copy.exists or copy.sha256 != original["sha256"]:
            raise StateDamaged("original copy")
        return copy.data

    def _matches_at(self, fd, name, record):
        """None if absent; True if exactly the recorded file; False if it
        changed (bytes, mode, owner, group, links, extended attributes or
        identity). A link or another kind of file at the name: StateLink."""
        try:
            seen = observe_at(fd, name)
        except ManagedFileError as error:
            raise StateLink(name) from error
        if not seen.exists:
            return None
        if seen.nlink != 1 or seen.uid != os.getuid() or seen.gid != os.getgid() or seen.xattrs:
            return False
        if seen.sha256 != record["sha256"] or seen.mode != record["mode"]:
            return False
        if record["ino"] is not None and (seen.dev, seen.ino) != (record["dev"], record["ino"]):
            return False
        return True

    def created_matches(self, manifest, rel):
        """Whether a file setup created (rel relative to the home folder) is
        still exactly what it recorded (see _matches_at). A link at the name
        or in place of a folder on the way raises StateLink."""
        try:
            fd, name = self._parent(os.path.relpath(rel, kiosk.KIOSK_STATE_DIR))
        except FileNotFoundError:
            return None
        try:
            return self._matches_at(fd, name, manifest["created_files"][rel])
        finally:
            self._done(fd)

    def remove_created(self, manifest, rel):
        """Delete one file setup created, only if it is still exactly what it
        recorded: it is moved to a hidden quarantine name first, checked
        there, and only then unlinked; if it changed in between, it is moved
        back. Returns False (and leaves it) when it was changed."""
        record = manifest["created_files"][rel]
        try:
            fd, name = self._parent(os.path.relpath(rel, kiosk.KIOSK_STATE_DIR))
        except FileNotFoundError:
            return True
        try:
            state = self._matches_at(fd, name, record)
            if state is None:
                return True
            if not state:
                return False
            quarantine = ".%s.%s%s" % (name, secrets.token_hex(6), QUARANTINE_SUFFIX)
            renameat2(fd, name, fd, quarantine, RENAME_NOREPLACE)
            try:
                verified = self._matches_at(fd, quarantine, record) is True
            except StateLink:
                verified = False
            if not verified:
                try:
                    renameat2(fd, quarantine, fd, name, RENAME_NOREPLACE)
                except FileExistsError as error:
                    raise KeptAside(rel) from error
                return False
            os.unlink(quarantine, dir_fd=fd)
            os.fsync(fd)
        finally:
            self._done(fd)
        return True

    def empty_profile(self):
        """Empty browser/ (links removed, never followed)."""
        try:
            fd = open_subdir(self.fd, BROWSER_PROFILE)
        except FileNotFoundError:
            return
        try:
            _empty_dir_fd(fd)
        finally:
            os.close(fd)

    def remove_manifest(self):
        os.unlink(MANIFEST, dir_fd=self.fd)
        os.fsync(self.fd)
