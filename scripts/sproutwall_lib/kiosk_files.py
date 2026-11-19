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

import hashlib
import json
import os
import re
import shutil
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


class WriteCheckFailed(Exception):
    """A file read back after writing did not have the bytes just written."""


def read_file(path):
    """bytes, or None when absent (ENOENT). A link or a non-regular file
    raises ManagedFileError; any other failure raises OSError."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise ManagedFileError("not a regular file")
    with open(path, "rb") as handle:
        data = handle.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ManagedFileError("too large")
    return data


def file_mode(path):
    """Permission bits, or None when absent (ENOENT). Other failures raise."""
    try:
        return os.lstat(path).st_mode & 0o7777
    except FileNotFoundError:
        return None


def _fsync_dir(folder):
    fd = os.open(folder, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_atomic(path, data, mode):
    """Write data to path: a new temporary file in the same folder, fsync,
    rename over path, fsync the folder, then read path back and compare.

    The old file stays whole until the rename, so a crash never leaves a
    half-written file. Raises WriteCheckFailed if the read-back differs."""
    folder = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix="." + os.path.basename(path) + ".", suffix=TMP_SUFFIX)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fchmod(handle.fileno(), mode & 0o7777)
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    _fsync_dir(folder)
    if read_file(path) != data or file_mode(path) != mode & 0o7777:
        raise WriteCheckFailed("read-back differs")


def remove_file(path):
    """Delete path (ENOENT is fine) and check that it is gone."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    _fsync_dir(os.path.dirname(path))
    if read_file(path) is not None:
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


def make_dirs(home, rel, mode, created):
    """Create home/rel and missing parents; append each created one (relative) to created."""
    parts = rel.split(os.sep)
    for index in range(1, len(parts) + 1):
        sub = os.path.join(*parts[:index])
        path = os.path.join(home, sub)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            os.mkdir(path, mode)
            created.append(sub)
            continue
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            raise ManagedFileError("not a folder")


def remove_created_dirs(home, created):
    """Remove folders setup created, deepest first, only while they are empty."""
    for sub in sorted(set(created), key=lambda s: s.count(os.sep), reverse=True):
        try:
            os.rmdir(os.path.join(home, sub))
        except OSError:
            pass  # not empty (someone else's files) or already gone: leave it


# --- state folder ---------------------------------------------------------------------------

# "writing": setup started writing; "undoing": --undo started restoring.
# Only in those two may a managed file be found as it was before setup
# (a run that stopped halfway); once "installed", it must be as setup wrote it.
STATUSES = ("writing", "installed", "undoing")
AUTOLOGIN_STATES = ("on", "off", "other_user", "unknown")


def allowed_created_dirs():
    """Every folder setup may create: the parents of the managed files and the state folder."""
    allowed = set()
    for rel in list(MANAGED.values()) + [os.path.join(kiosk.KIOSK_STATE_DIR, ORIGINALS, "x")]:
        parts = rel.split(os.sep)[:-1]
        for index in range(1, len(parts) + 1):
            allowed.add(os.path.join(*parts[:index]))
    return allowed


def _valid_hash(value, allow_none):
    return (allow_none and value is None) or (isinstance(value, str) and HASH_RE.fullmatch(value) is not None)


def validate_manifest(data):
    """Raise StateDamaged unless data is exactly a manifest this version writes."""
    from . import kiosk_detect as det

    def need(condition, what):
        if not condition:
            raise StateDamaged(what)

    need(isinstance(data, dict), "object")
    need(set(data) == MANIFEST_KEYS, "keys")
    need(data["schema"] == STATE_SCHEMA and type(data["schema"]) is int, "schema")
    need(data["status"] in STATUSES, "status")
    need(type(data["enabled"]) is bool, "enabled")
    need(data["orientation"] in det.ORIENTATIONS, "orientation")
    need(isinstance(data["connector"], str) and det.CONNECTOR_RE.fullmatch(data["connector"]) is not None, "connector")
    need(data["transform"] in det.KIOSK_TRANSFORMS, "transform")
    need(isinstance(data["touch_device"], str) and det.DEVICE_NAME_RE.fullmatch(data["touch_device"]) is not None, "touch")
    need(data["autologin_before"] in AUTOLOGIN_STATES, "autologin")
    need(isinstance(data["created_dirs"], list) and all(d in allowed_created_dirs() for d in data["created_dirs"]), "dirs")
    files = data["files"]
    need(isinstance(files, dict) and set(files) == set(MANAGED), "files")
    for entry in files.values():
        need(isinstance(entry, dict) and set(entry) == {"existed", "mode", "original", "written"}, "entry keys")
        need(type(entry["existed"]) is bool, "existed")
        if entry["existed"]:
            need(type(entry["mode"]) is int and 0 <= entry["mode"] <= 0o7777, "mode")
            need(_valid_hash(entry["original"], False), "original")
        else:
            need(entry["mode"] is None and entry["original"] is None, "absent original")
        need(_valid_hash(entry["written"], False), "written")
    return data


MANIFEST_KEYS = {
    "schema",
    "status",
    "enabled",
    "orientation",
    "connector",
    "transform",
    "touch_device",
    "autologin_before",
    "created_dirs",
    "files",
}


class State:
    """~/.local/state/sproutwall/kiosk: manifest.json and original/<key>."""

    def __init__(self, home):
        self.home = home
        self.dir = os.path.join(home, kiosk.KIOSK_STATE_DIR)
        self.manifest = None

    @property
    def manifest_path(self):
        return os.path.join(self.dir, MANIFEST)

    def path(self, key):
        return os.path.join(self.home, MANAGED[key])

    def profile_dir(self):
        return os.path.join(self.dir, BROWSER_PROFILE)

    def present(self):
        """True if a manifest exists, False on ENOENT. A link or a non-folder
        on the way raises ManagedFileError; other failures raise OSError."""
        assert_no_links(self.home, [os.path.join(kiosk.KIOSK_STATE_DIR, MANIFEST)])
        try:
            st = os.lstat(self.manifest_path)
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(st.st_mode):
            raise StateDamaged("not a file")
        return True

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
        self.manifest = validate_manifest(parsed)
        return self.manifest

    def original(self, key):
        """The pre-install bytes of a managed file, or None if it did not exist."""
        entry = self.manifest["files"][key]
        if not entry["existed"]:
            return None
        try:
            data = read_file(os.path.join(self.dir, ORIGINALS, key))
        except ManagedFileError as error:
            raise StateDamaged("original") from error
        if data is None or sha256(data) != entry["original"]:
            raise StateDamaged("original changed")
        return data

    def create(self, created_dirs):
        make_dirs(self.home, kiosk.KIOSK_STATE_DIR, 0o700, created_dirs)
        os.chmod(self.dir, 0o700)
        make_dirs(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, ORIGINALS), 0o700, created_dirs)

    def save_original(self, key, data):
        write_atomic(os.path.join(self.dir, ORIGINALS, key), data, 0o600)

    def save(self, manifest):
        validate_manifest(manifest)
        self.manifest = manifest
        write_atomic(self.manifest_path, json.dumps(manifest, indent=1, sort_keys=True).encode("utf-8"), 0o600)

    def remove(self):
        """Delete the whole state folder (snapshot, hashes, browser profile, lock).
        Any failure raises: the folder is never half-deleted silently."""
        assert_no_links(self.home, [kiosk.KIOSK_STATE_DIR])
        shutil.rmtree(self.dir)


def changed_since_setup(manifest, current):
    """The managed files (keys) whose bytes are not what setup left. A file
    back as it was before setup counts as unchanged only while a run that
    stopped halfway is being finished (status "writing" or "undoing")."""
    allowed = ("as_set_up",) if manifest["status"] == "installed" else ("as_set_up", "original")
    return [key for key in MANAGED if file_status(manifest["files"][key], current[key]) not in allowed]


def file_status(entry, current):
    """"as_set_up", "original" or "changed" for a managed file's current bytes."""
    digest = sha256(current)
    if entry.get("written") is not None and digest == entry.get("written"):
        return "as_set_up"
    if digest == entry.get("original"):
        return "original"
    return "changed"
