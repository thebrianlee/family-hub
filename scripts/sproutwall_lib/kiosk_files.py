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
import stat
import tempfile
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
# Only ENOENT means "not there". Any other failure (permission, a path part
# that is a file, I/O) propagates as OSError, and callers stop without
# editing: an error is never taken for a missing file.

HASH_RE = re.compile(r"[0-9a-f]{64}", re.ASCII)
TMP_SUFFIX = ".sproutwall-tmp"
MAX_FILE = 4 * 1024 * 1024


class WriteCheckFailed(Exception):
    """A file read back after writing did not have the bytes and mode just written."""


class ChangedMeanwhile(Exception):
    """A managed file changed between the check and the write."""


class Seen:
    """What a managed path held when it was observed: a regular file's bytes,
    sha256, permission bits and identity (device, inode, change times), or
    nothing (ENOENT). The change times matter because a freed inode number
    can be reused at once by the next file saved there."""

    __slots__ = ("exists", "sha256", "mode", "dev", "ino", "times", "data")

    def __init__(self, exists, data=None, mode=None, dev=None, ino=None, times=None):
        self.exists = exists
        self.data = data
        self.sha256 = sha256(data) if exists else None
        self.mode = mode if exists else None
        self.dev = dev
        self.ino = ino
        self.times = times

    def state(self):
        """The manifest form: {"exists", "sha256", "mode"}."""
        return {"exists": self.exists, "sha256": self.sha256, "mode": self.mode}

    def same_file(self, other):
        """Same bytes, mode and identity (a replaced or touched file differs)."""
        return (self.exists, self.sha256, self.mode, self.dev, self.ino, self.times) == (
            other.exists,
            other.sha256,
            other.mode,
            other.dev,
            other.ino,
            other.times,
        )


ABSENT = Seen(False)


def file_state(data, mode):
    """The manifest form of a planned file (data None: the file must not exist)."""
    if data is None:
        return {"exists": False, "sha256": None, "mode": None}
    return {"exists": True, "sha256": sha256(data), "mode": mode}


def matches(seen, state):
    """seen is exactly the planned or recorded state: existence, bytes and mode."""
    return seen.state() == state


def observe(path):
    """Seen for path. ENOENT is ABSENT. A link, a folder or any other
    non-regular file raises ManagedFileError; other failures raise OSError."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    except FileNotFoundError:
        return ABSENT
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.EISDIR):
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
    finally:
        os.close(fd)
    return Seen(True, b"".join(chunks), st.st_mode & 0o7777, st.st_dev, st.st_ino, (st.st_mtime_ns, st.st_ctime_ns))


def read_file(path):
    """bytes, or None when absent (ENOENT). Raises like observe()."""
    seen = observe(path)
    return seen.data if seen.exists else None


def _fsync_dir(folder):
    fd = os.open(folder, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _check_unchanged(path, expect):
    """Raise ChangedMeanwhile unless path is still exactly what was checked."""
    if expect is not None and not observe(path).same_file(expect):
        raise ChangedMeanwhile("changed")


def write_atomic(path, data, mode, expect=None):
    """Write data to path: a new temporary file in the same folder, fsync,
    then rename over path, fsync the folder, read back and compare.

    expect: the Seen that was verified for path. Right before the rename,
    path is observed again (bytes, mode, inode, type) and must still be
    exactly that, else ChangedMeanwhile and nothing is renamed. A tiny
    window remains between that last check and the rename itself; an editor
    that saves inside it loses to this write. The old file stays whole until
    the rename, so a failure never leaves a half-written file."""
    folder = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix="." + os.path.basename(path) + ".", suffix=TMP_SUFFIX)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fchmod(handle.fileno(), mode & 0o7777)
            os.fsync(handle.fileno())
        _check_unchanged(path, expect)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    _fsync_dir(folder)
    after = observe(path)
    if not after.exists or after.data != data or after.mode != mode & 0o7777:
        raise WriteCheckFailed("read-back differs")


def remove_file(path, expect=None):
    """Delete path (ENOENT is fine) after the same last check as
    write_atomic, and check that it is gone."""
    _check_unchanged(path, expect)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    _fsync_dir(os.path.dirname(path))
    if observe(path).exists:
        raise WriteCheckFailed("still there")


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
    parts = rel.split(os.sep)
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
    """Create home/rel and missing parents; append each created one (relative) to created."""
    for sub in missing_dirs(home, rel):
        os.mkdir(os.path.join(home, sub), mode)
        if sub not in created:
            created.append(sub)


def remove_created_dirs(home, created):
    """Remove folders setup created, deepest first, only while they are empty.
    True if all of them are gone."""
    gone = True
    for sub in sorted(set(created), key=lambda s: s.count(os.sep), reverse=True):
        try:
            os.rmdir(os.path.join(home, sub))
        except FileNotFoundError:
            pass
        except OSError:
            gone = False  # not empty (someone else's files): leave it
    return gone


def remove_profile_tree(path):
    """Empty the kiosk browser profile folder that setup created.

    The one folder whose contents are removed: setup creates it empty for the
    launcher, only the kiosk browser writes into it, and it holds the
    screen's unlock, which must not stay behind. Links inside are removed as
    links, never followed. Raises on any failure."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise ManagedFileError("profile")
    for base, dirs, files in os.walk(path, topdown=False, followlinks=False):
        for name in files + dirs:
            entry = os.path.join(base, name)
            entry_st = os.lstat(entry)
            if stat.S_ISDIR(entry_st.st_mode):
                os.rmdir(entry)
            else:
                os.unlink(entry)


# --- state folder ---------------------------------------------------------------------------

PHASES = ("writing", "done")
OPERATIONS = ("setup", "off", "undo")
AUTOLOGIN_STATES = ("on", "off", "other_user", "unknown")
SETUP_LOCK = "setup.lock"
RUN_DIR = "run"
# Files the launcher creates in RUN_DIR (kiosk_launcher.py: LOCK_FILE, WAIT_PAGE).
LAUNCHER_RUN_FILES = ("launcher.lock", "starting.html")
STATE_SUBDIRS = (ORIGINALS, RUN_DIR, BROWSER_PROFILE)


def state_rel(*parts):
    return os.path.join(kiosk.KIOSK_STATE_DIR, *parts)


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
    return {state_rel(SETUP_LOCK)} | {state_rel(ORIGINALS, key) for key in MANAGED}


def _valid_state(value):
    if not isinstance(value, dict) or set(value) != {"exists", "sha256", "mode"} or type(value["exists"]) is not bool:
        return False
    if not value["exists"]:
        return value["sha256"] is None and value["mode"] is None
    return (
        isinstance(value["sha256"], str)
        and HASH_RE.fullmatch(value["sha256"]) is not None
        and type(value["mode"]) is int
        and 0 <= value["mode"] <= 0o7777
    )


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

    phase "done": every file has "installed" (what the last run left) and no
    previous/target. phase "writing": a run was in progress; every file has
    "previous" (what it held when that run started) and "target" (what the
    run writes), and no "installed"."""
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
    need(isinstance(data["created_dirs"], list) and all(d in allowed_created_dirs() for d in data["created_dirs"]), "dirs")
    need(isinstance(data["created_files"], list) and all(f in allowed_created_files() for f in data["created_files"]), "created files")
    files = data["files"]
    need(isinstance(files, dict) and set(files) == set(MANAGED), "files")
    for key, entry in files.items():
        need(isinstance(entry, dict) and set(entry) == FILE_KEYS, "entry keys")
        need(_valid_state(entry["original"]), "original")
        if key == "launcher":
            need(not entry["original"]["exists"], "launcher original")
        if data["phase"] == "done":
            need(_valid_state(entry["installed"]) and entry["previous"] is None and entry["target"] is None, "done entry")
        else:
            need(entry["installed"] is None and _valid_state(entry["previous"]) and _valid_state(entry["target"]), "writing entry")
    return data


def accepted_states(manifest, key):
    """The states a managed file may legitimately be in: what the last run
    left, or, while a run is in progress, what it held before that run, its
    original, or the run's target (so the same command can finish the job)."""
    entry = manifest["files"][key]
    if manifest["phase"] == "done":
        return [entry["installed"]]
    return [entry["original"], entry["previous"], entry["target"]]


def changed_since_setup(manifest, seen):
    """The managed files (keys) whose bytes, mode or existence are not in an accepted state."""
    return [key for key in MANAGED if not any(matches(seen[key], s) for s in accepted_states(manifest, key))]


class Busy(Exception):
    """Another setup kiosk run holds the lock."""


class RunLock:
    """An exclusive flock on setup.lock in the state folder for a whole run.

    acquire() creates the state folder chain and the lock file if needed,
    recording what it created, takes the lock without waiting (Busy if
    another run holds it) and checks that the path still names the locked
    file, so a lock file removed and recreated by a finishing run cannot
    let two runs in at once."""

    def __init__(self, state):
        self.state = state
        self.fd = None
        self.created_dirs = []
        self.created_file = False

    @property
    def path(self):
        return os.path.join(self.state.dir, SETUP_LOCK)

    def acquire(self):
        make_dirs(self.state.home, kiosk.KIOSK_STATE_DIR, 0o700, self.created_dirs)
        flags = os.O_RDWR | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        try:
            fd = os.open(self.path, flags)
        except FileNotFoundError:
            fd = os.open(self.path, flags | os.O_CREAT | os.O_EXCL, 0o600)
            self.created_file = True
        except OSError as error:
            if error.errno == errno.ELOOP:
                raise ManagedFileError("lock") from error
            raise
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ManagedFileError("lock")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Busy("locked") from error
            locked, named = os.fstat(fd), os.lstat(self.path)
            if (locked.st_dev, locked.st_ino) != (named.st_dev, named.st_ino):
                raise Busy("replaced")
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd
        return self

    def release(self, remove=False):
        """Unlock; with remove, delete the lock file first (still locked)."""
        if self.fd is None:
            return
        try:
            if remove:
                try:
                    os.unlink(self.path)
                except FileNotFoundError:
                    pass
        finally:
            os.close(self.fd)
            self.fd = None


class State:
    """~/.local/state/sproutwall/kiosk: manifest.json, original/<key>,
    setup.lock, run/ (the launcher's lock and waiting page) and browser/
    (the kiosk browser's profile)."""

    def __init__(self, home):
        self.home = home
        self.dir = os.path.join(home, kiosk.KIOSK_STATE_DIR)

    @property
    def manifest_path(self):
        return os.path.join(self.dir, MANIFEST)

    def path(self, key):
        return os.path.join(self.home, MANAGED[key])

    def rel_path(self, rel):
        return os.path.join(self.home, rel)

    def profile_dir(self):
        return os.path.join(self.dir, BROWSER_PROFILE)

    def classify(self):
        """"absent", "leftover" (the state folder holds nothing but an
        empty setup.lock, as an interrupted or refused run leaves it),
        "manifest", or "foreign" (a state folder or launcher without the
        record this tool writes). Links raise ManagedFileError, other
        failures OSError."""
        assert_no_links(self.home, [state_rel(MANIFEST), kiosk.KIOSK_LAUNCHER])
        launcher = observe(self.path("launcher")).exists
        try:
            st = os.lstat(self.dir)
        except FileNotFoundError:
            return "foreign" if launcher else "absent"
        if not stat.S_ISDIR(st.st_mode):
            raise ManagedFileError("state")
        try:
            manifest = os.lstat(self.manifest_path)
        except FileNotFoundError:
            manifest = None
        if manifest is not None:
            if not stat.S_ISREG(manifest.st_mode):
                raise ManagedFileError("manifest")
            return "manifest"
        names = os.listdir(self.dir)
        if launcher or any(name != SETUP_LOCK for name in names):
            return "foreign"
        if names:
            lock = os.lstat(os.path.join(self.dir, SETUP_LOCK))
            if not stat.S_ISREG(lock.st_mode) or lock.st_size != 0:
                return "foreign"
            return "leftover"
        return "leftover"

    def load(self):
        try:
            data = read_file(self.manifest_path)
        except ManagedFileError as error:
            raise StateDamaged("manifest") from error
        if data is None:
            raise StateDamaged("manifest missing")
        try:
            parsed = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise StateDamaged("manifest json") from error
        return validate_manifest(parsed)

    def original_copy(self, key):
        """The saved pre-install bytes of a managed file, or None if no copy exists."""
        try:
            return read_file(os.path.join(self.dir, ORIGINALS, key))
        except ManagedFileError as error:
            raise StateDamaged("original") from error

    def original_bytes(self, manifest, key, seen):
        """The pre-install bytes: the file itself while it is still exactly
        the original, else the saved copy (checked against its hash)."""
        original = manifest["files"][key]["original"]
        if not original["exists"]:
            return None
        if matches(seen, original):
            return seen.data
        data = self.original_copy(key)
        if data is None or sha256(data) != original["sha256"]:
            raise StateDamaged("original copy")
        return data

    def save_original(self, key, data):
        write_atomic(os.path.join(self.dir, ORIGINALS, key), data, 0o600)

    def save(self, manifest):
        validate_manifest(manifest)
        write_atomic(self.manifest_path, json.dumps(manifest, indent=1, sort_keys=True).encode("utf-8"), 0o600)

    def remove_manifest(self):
        os.unlink(self.manifest_path)
        _fsync_dir(self.dir)
