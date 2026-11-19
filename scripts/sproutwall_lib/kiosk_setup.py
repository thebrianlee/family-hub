"""`sproutwall setup kiosk`: one output, with touch mapped to it (spec 4.4).

  setup kiosk [--orientation portrait|portrait-flipped|landscape|landscape-flipped]
  setup kiosk --check [--json]
  setup kiosk --off
  setup kiosk --undo

Runs as the desktop user, never as root, and never runs sudo. The one
privileged step, desktop autologin, is printed for the person to run
themselves (see docs/install-cli.md for why).

Output is fixed text keyed by enum values only. Paths, user names, the
touch device name and the connector name are written to config files but
never printed; the screen is named only by its kind (HDMI or DSI).

An error is never treated as "missing" or "off": a source that cannot be
read or does not parse exactly stops the run before any edit (exit 6), and
`--check` reports it as unknown.
"""

import json
import os
import signal

from . import kiosk, kiosk_detect as det, kiosk_files as kf

EXIT_OK = 0
EXIT_ATTENTION = 1
EXIT_USAGE = 2  # also an unexpected error, as everywhere in scripts/sproutwall
EXIT_UNSUPPORTED = 3
EXIT_NOT_READY = 4
EXIT_CHANGED = 5
EXIT_CANNOT_TELL = 6

MANUAL = "Set up the screen by hand instead: docs/raspberry-pi.md, section Kiosk."
UNCHANGED = "Nothing was changed."


def _lower_first(text):
    return text[0].lower() + text[1:]


REFUSALS = {
    # key: (exit code, fixed text)
    "root": (EXIT_UNSUPPORTED, "Refused: run this as the desktop user, without sudo."),
    "unsupported_os": (
        EXIT_UNSUPPORTED,
        "Refused: setup kiosk supports only Raspberry Pi OS (64-bit) with the desktop, on a Raspberry Pi. "
        "The hub itself runs on any 64-bit Linux; on other devices open the hub in a browser's kiosk mode "
        "(docs/raspberry-pi.md, Kiosk on other devices).",
    ),
    "no_desktop": (
        EXIT_UNSUPPORTED,
        "Refused: no Raspberry Pi OS desktop session (labwc) is running for this user. Log in to the desktop "
        "on the Pi's own screen, then run this again from its Terminal (or from an SSH login of the same user). "
        "An image without the desktop (Lite) is not supported. " + MANUAL,
    ),
    "other_desktop": (
        EXIT_UNSUPPORTED,
        "Refused: this desktop is not Raspberry Pi OS's Wayland/labwc session (for example X11 or Wayfire), "
        "and setup kiosk never configures those. Switch to labwc in sudo raspi-config (Advanced Options, "
        "Wayland), log in again and rerun, or " + _lower_first(MANUAL),
    ),
    "session": (
        EXIT_UNSUPPORTED,
        "Refused: this labwc session is not set up the way current Raspberry Pi OS sets it up (labwc with "
        "merged configuration, kanshi and its display socket). Update Raspberry Pi OS and log in again, or "
        + _lower_first(MANUAL),
    ),
    "no_chromium": (
        EXIT_UNSUPPORTED,
        "Refused: Chromium was not found (chromium or chromium-browser). Install it from Raspberry Pi OS's own "
        "packages, then run this again.",
    ),
    "no_wlr_randr": (EXIT_UNSUPPORTED, "Refused: the connected screens could not be listed (wlr-randr is missing). " + MANUAL),
    "outputs_none": (
        EXIT_NOT_READY,
        "Stopped: no switched-on HDMI or DSI screen was found. The kiosk needs exactly one. Reconnect or "
        "switch on the screen you want to use, unplug any other screen, wait ten seconds, then run this again.",
    ),
    "outputs_several": (
        EXIT_NOT_READY,
        "Stopped: more than one screen was found. The kiosk needs exactly one HDMI or DSI screen. Reconnect "
        "or switch on the screen you want to use, unplug any other screen, wait ten seconds, then run this again.",
    ),
    "unsupported_connector": (
        EXIT_UNSUPPORTED,
        "Refused: the connected screen is not on an HDMI or DSI connector (for example DPI, composite or a "
        "virtual screen). " + MANUAL,
    ),
    "touch_none": (
        EXIT_NOT_READY,
        "Stopped: no touch input was found. Connect the screen's touch connection (many HDMI screens need a "
        "separate USB cable for touch), wait ten seconds, then run this again. For a screen without touch, "
        + _lower_first(MANUAL),
    ),
    "touch_several": (
        EXIT_NOT_READY,
        "Stopped: more than one touch input was found, so the tool cannot tell which belongs to the screen. "
        "Unplug the other touch devices (a second touch screen, a drawing tablet), then run this again.",
    ),
    "system_blanking": (
        EXIT_UNSUPPORTED,
        "Refused: screen blanking is switched on for every user of this Pi (the system-wide labwc autostart), "
        "which this tool does not change. " + MANUAL,
    ),
    "manual_kiosk": (
        EXIT_NOT_READY,
        "Stopped: labwc autostart already starts Chromium (a kiosk line added by hand). Remove that line first "
        "(docs/raspberry-pi.md, Kiosk), then run this again, so the screen never opens two browsers.",
    ),
    "rc_xml": (
        EXIT_UNSUPPORTED,
        "Refused: your labwc rc.xml could not be merged safely (it is not well-formed XML or has an unexpected "
        "layout). Fix it, or map the touch input by hand (docs/raspberry-pi.md, Kiosk).",
    ),
    "link": (
        EXIT_UNSUPPORTED,
        "Refused: a file this tool would manage (labwc autostart or rc.xml, the kanshi config, the launcher or "
        "its state folder), or a folder on the way to it, is a link or not a regular file or folder. " + MANUAL,
    ),
    "changed": (
        EXIT_CHANGED,
        "Stopped: files this tool manages (labwc autostart, labwc rc.xml, the kanshi config or the launcher) were "
        "changed after setup, for example by Control Centre. They were left as they are. Put those changes "
        "back, or remove the kiosk by hand (docs/raspberry-pi.md, Kiosk), then run this again.",
    ),
    "state_damaged": (
        EXIT_CHANGED,
        "Stopped: the kiosk's saved snapshot is missing, damaged or not in the form this version writes, so it "
        "cannot be used safely. Remove the kiosk by hand (docs/raspberry-pi.md, Kiosk).",
    ),
    "config_path": (
        EXIT_UNSUPPORTED,
        "Refused: this desktop session reads its configuration from a non-standard place (a labwc or kanshi "
        "config option, another XDG_CONFIG_HOME or another home folder), so the files this tool writes would "
        "not be used. " + MANUAL,
    ),
    "state_orphan": (
        EXIT_CHANGED,
        "Stopped: the kiosk's state folder or launcher already exists, but without the record this tool "
        "writes, so it is not safe to take it over or delete it. Check it and remove it by hand (the paths "
        "are in docs/install-cli.md, setup kiosk), then run this again.",
    ),
    "busy": (
        EXIT_NOT_READY,
        "Stopped: another setup kiosk run is in progress. Wait for it to finish, then run this again.",
    ),
    "changed_during": (
        EXIT_CHANGED,
        "Stopped: a file this tool manages changed while it was being updated (for example Control Centre "
        "saved it). That file was left as it is, and nothing more was written. Put the change back, then run "
        "the same command again to finish, or --undo.",
    ),
    "cannot_tell": (
        EXIT_CANNOT_TELL,
        "Stopped: something this tool must read could not be read, or did not have the expected form, so it "
        "cannot tell whether changing the screen settings is safe. Wait a minute and run this again from the "
        "Pi's desktop Terminal. If it repeats, " + _lower_first(MANUAL),
    ),
}

NOT_INSTALLED = "The kiosk is not set up by this tool. " + UNCHANGED
AUTOLOGIN_ON_CMD = " ".join(det.AUTOLOGIN_ON)
AUTOLOGIN_OFF_CMD = " ".join(det.AUTOLOGIN_OFF)
KIND_TEXT = {"hdmi": "HDMI", "dsi": "DSI"}

# Also hard-coded in scripts/sproutwall, which must work without this package
# (a unit test compares them).
FAILED = (
    "sproutwall: setup kiosk stopped by an unexpected error. "
    "Run ./scripts/sproutwall setup kiosk --check to see what is in place."
)
CRASH_DURING = (
    "sproutwall: setup kiosk stopped by an unexpected error after it had started writing. "
    "Run ./scripts/sproutwall setup kiosk --check, then --undo to restore the snapshot."
)


class Refused(Exception):
    def __init__(self, key):
        super().__init__(key)
        self.key = key


class Progress:
    """Whether any file has been written yet, for the crash message."""

    def __init__(self):
        self.writing = False


def refusal_lines(key):
    code, text = REFUSALS[key]
    if key in ("changed", "changed_during"):
        return code, [text]  # the text says what was and was not changed
    return code, [text, UNCHANGED]


# --- shared steps --------------------------------------------------------------------

SESSION_REFUSAL = {
    "root": "root",
    "no_desktop": "no_desktop",
    "other_desktop": "other_desktop",
    "no_merge": "session",
    "no_kanshi": "session",
    "no_socket": "session",
    "config_path": "config_path",
}


def supported_session(system):
    """The labwc session, or raise Refused / det.CannotTell. Checks root,
    platform, session and Chromium, in that order."""
    if system.euid() == 0:
        raise Refused("root")
    if not det.platform_supported(system):
        raise Refused("unsupported_os")
    session = det.find_session(system)
    if not session.ok:
        raise Refused(SESSION_REFUSAL[session.reason])
    if det.find_chromium(system) is None:
        raise Refused("no_chromium")
    return session


def the_output(system, session):
    try:
        outputs = det.read_outputs(system, session)
    except det.OutputsUnreadable as error:
        raise Refused("no_wlr_randr") from error
    kind, output = det.classify_outputs(outputs)
    if kind != "one":
        raise Refused({"none": "outputs_none", "several": "outputs_several"}.get(kind, kind))
    return output


def the_touch(system):
    kind, name = det.find_touch(system)
    if kind != "one":
        raise Refused("touch_" + kind)
    return name


def classify(state):
    """"absent", "leftover", "manifest" or "foreign" (see State.classify)."""
    try:
        return state.classify()
    except kf.ManagedFileError as error:
        raise Refused("link") from error
    except OSError as error:
        raise det.CannotTell("state") from error


def load_manifest(state):
    try:
        return state.load()
    except kf.StateDamaged as error:
        raise Refused("state_damaged") from error
    except OSError as error:
        raise det.CannotTell("state") from error


def check_no_links(state):
    """Refuse before writing if any managed path, or a folder on the way, is a link."""
    try:
        kf.assert_no_links(state.home, [kiosk.KIOSK_STATE_DIR] + list(kf.MANAGED.values()))
    except kf.ManagedFileError as error:
        raise Refused("link") from error
    except OSError as error:
        raise det.CannotTell("home-files") from error


def observe_all(state):
    """{key: Seen} for the managed files: bytes, mode, identity."""
    try:
        return {key: kf.observe(state.path(key)) for key in kf.MANAGED}
    except kf.ManagedFileError as error:
        raise Refused("link") from error
    except OSError as error:
        raise det.CannotTell("home-files") from error


def originals(state, manifest, seen):
    """{key: pre-install bytes or None}."""
    try:
        return {key: state.original_bytes(manifest, key, seen[key]) for key in kf.MANAGED}
    except kf.StateDamaged as error:
        raise Refused("state_damaged") from error
    except OSError as error:
        raise det.CannotTell("state") from error


def copies_to_save(state, manifest, seen):
    """Keys whose saved original copy is missing but can be taken from the
    file itself (it is still exactly the original). A missing copy that can
    no longer be taken is a damaged snapshot."""
    needed = []
    for key in kf.MANAGED:
        original = manifest["files"][key]["original"]
        if not original["exists"]:
            continue
        try:
            copy = state.original_copy(key)
        except kf.StateDamaged as error:
            raise Refused("state_damaged") from error
        except OSError as error:
            raise det.CannotTell("state") from error
        if copy is not None and kf.sha256(copy) == original["sha256"]:
            continue
        if kf.matches(seen[key], original) and copy is None:
            needed.append(key)
        else:
            raise Refused("state_damaged")
    return needed


def verify_accepted(manifest, seen):
    if kf.changed_since_setup(manifest, seen):
        raise Refused("changed")


def recheck(state, seen):
    """Observe again right before the first write: anything that changed
    since the check (an editor or Control Centre saving meanwhile) stops the
    run before it writes anything."""
    now = observe_all(state)
    if any(not now[key].same_file(seen[key]) for key in kf.MANAGED):
        raise Refused("changed")


def target_modes(manifest_or_seen_original):
    """The mode each managed file is written with: its original mode if it
    existed, else the default (the launcher is always 0755)."""
    modes = {}
    for key in kf.MANAGED:
        original = manifest_or_seen_original[key]
        modes[key] = original["mode"] if original["exists"] and key != "launcher" else kf.DEFAULT_MODES[key]
    return modes


def build_targets(base, original_states, meta):
    """{key: (bytes, mode)} for the configuration in meta, from the originals."""
    try:
        data = {
            "launcher": kf.launcher_bytes(),
            "kanshi": kf.kanshi_text(base["kanshi"], meta["connector"], meta["transform"]),
            "rc_xml": kf.rc_xml_text(base["rc_xml"], meta["touch_device"], meta["connector"]),
            "autostart": kf.autostart_text(base["autostart"], meta["enabled"]),
        }
    except kf.RcXmlError as error:
        raise Refused("rc_xml") from error
    modes = target_modes(original_states)
    return {key: (data[key], modes[key]) for key in kf.MANAGED}


def new_manifest(seen, autologin, meta):
    """The record for a first setup: the originals are the files as they are now."""
    files = {key: {"original": seen[key].state(), "installed": None, "previous": None, "target": None} for key in kf.MANAGED}
    manifest = {
        "schema": kf.STATE_SCHEMA,
        "phase": "writing",
        "operation": "setup",
        "autologin_before": autologin,
        "created_dirs": [],
        "created_files": [],
        "files": files,
    }
    manifest.update(meta)
    return manifest


def _add(items, extra):
    for item in extra:
        if item not in items:
            items.append(item)


def transact(state, manifest, seen, targets, meta, operation, lock, progress, save_copies=()):
    """One write-ahead transaction over the managed files.

    1. The manifest is saved with phase "writing" and, per file, "previous"
       (what it holds now) and "target" (what this run writes). Folders and
       files this run will create are recorded before they are created.
    2. Each file is written (or removed) only if it is not already at its
       target, each with a last check that it is still what was verified.
    3. The manifest is saved with phase "done" and "installed" = target.
    If the run stops in step 2, every file is at its previous state, its
    original or its target, all accepted while the phase is "writing", so
    the same command (or --undo) can be run again to finish."""
    home = state.home
    needed = []
    if operation != "undo":
        needed = [(kf.state_rel(sub), 0o700) for sub in kf.STATE_SUBDIRS]
        needed += [(os.path.dirname(kf.MANAGED[key]), 0o755) for key in kf.WRITE_ORDER if targets[key][0] is not None]
    try:
        planned = []
        for rel, _mode in needed:
            _add(planned, kf.missing_dirs(home, rel))
    except kf.ManagedFileError as error:
        raise Refused("link") from error
    except OSError as error:
        raise det.CannotTell("home-files") from error
    _add(manifest["created_dirs"], lock.created_dirs + planned)
    _add(manifest["created_files"], [kf.state_rel(kf.SETUP_LOCK)] + [kf.state_rel(kf.ORIGINALS, key) for key in save_copies])
    manifest.update(meta)
    manifest["phase"] = "writing"
    manifest["operation"] = operation
    for key in kf.MANAGED:
        entry = manifest["files"][key]
        entry.update({"installed": None, "previous": seen[key].state(), "target": kf.file_state(*targets[key])})

    progress.writing = True
    state.save(manifest)
    for rel, mode in needed:
        kf.make_dirs(home, rel, mode, [])
    for key in save_copies:
        state.save_original(key, seen[key].data)
    order = reversed(kf.WRITE_ORDER) if operation == "undo" else kf.WRITE_ORDER
    try:
        for key in order:
            data, mode = targets[key]
            if kf.matches(seen[key], kf.file_state(data, mode)):
                continue
            if data is None:
                kf.remove_file(state.path(key), expect=seen[key])
            else:
                kf.write_atomic(state.path(key), data, mode, expect=seen[key])
    except kf.ChangedMeanwhile as error:
        raise Refused("changed_during") from error
    for key in kf.MANAGED:
        entry = manifest["files"][key]
        entry.update({"installed": entry["target"], "previous": None, "target": None})
    manifest["phase"] = "done"
    state.save(manifest)
    return manifest


def remove_state(state, manifest, lock):
    """After an undo: delete what setup created, file by file, then the
    folders it created if they are empty. The manifest goes last but one
    (before the lock), so an interrupted cleanup can be run again.
    True if the state folder is gone."""
    kf.remove_profile_tree(state.profile_dir())
    for name in kf.LAUNCHER_RUN_FILES:
        try:
            os.unlink(os.path.join(state.dir, kf.RUN_DIR, name))
        except FileNotFoundError:
            pass
    for rel in manifest["created_files"]:
        if rel == kf.state_rel(kf.SETUP_LOCK):
            continue
        try:
            os.unlink(state.rel_path(rel))
        except FileNotFoundError:
            pass
    state.remove_manifest()
    lock.release(remove=True)
    kf.remove_created_dirs(state.home, manifest["created_dirs"])
    try:
        os.lstat(state.dir)
    except FileNotFoundError:
        return True
    return False


class Locked:
    """The run lock as a context: Busy and creation errors become refusals.
    On a refused or failed first setup (no manifest written by this run),
    the lock file and the folders the lock created are removed again."""

    def __init__(self, state):
        self.lock = kf.RunLock(state)
        self.state = state
        self.keep = False

    def __enter__(self):
        try:
            return self.lock.acquire()
        except kf.Busy as error:
            raise Refused("busy") from error
        except kf.ManagedFileError as error:
            raise Refused("link") from error
        except OSError as error:
            raise det.CannotTell("state") from error

    def __exit__(self, kind, value, tb):
        if self.keep or self.lock.fd is None:
            self.lock.release()
            return False
        try:
            os.lstat(self.state.manifest_path)
            has_manifest = True
        except FileNotFoundError:
            has_manifest = False
        except OSError:
            has_manifest = True  # cannot tell: keep everything
        if has_manifest:
            self.lock.release()
        else:
            self.lock.release(remove=self.lock.created_file)
            kf.remove_created_dirs(self.state.home, self.lock.created_dirs)
        return False


def launcher_processes(system, state):
    """pids of this user's launcher and kiosk browser main processes. Raises det.CannotTell."""
    launcher = state.path("launcher")
    profile_flag = "--user-data-dir=" + state.profile_dir()
    pids = []
    for pid, _owner, _comm, argv in det.own_processes(system):
        if launcher in argv[:3]:
            pids.append(pid)
        elif profile_flag in argv and not any(arg.startswith("--type=") for arg in argv):
            pids.append(pid)
    return pids


def stop_running(system, state):
    """SIGTERM the launcher (it closes its browser) and any kiosk browser,
    then SIGKILL whatever is left after ten seconds. True if any ran.
    Raises det.CannotTell only before anything was signalled."""
    pids = launcher_processes(system, state)
    for pid in pids:
        system.kill(pid, signal.SIGTERM)
    left = list(pids)
    for _ in range(20):
        if not left:
            break
        system.sleep(0.5)
        try:
            left = [pid for pid in launcher_processes(system, state) if pid in pids]
        except det.CannotTell:
            break
    for pid in left:
        system.kill(pid, signal.SIGKILL)
    return bool(pids)


def reload_session(system, session):
    """kanshi re-reads its config on SIGHUP (kanshi(1)); labwc re-reads rc.xml
    and remaps touch inputs on SIGHUP, which is what `labwc --reconfigure`
    sends (labwc-config(5); labwc src/seat.c seat_reconfigure)."""
    for pid in session.kanshi_pids:
        system.kill(pid, signal.SIGHUP)
    system.kill(session.labwc_pid, signal.SIGHUP)


def rotation_applied(system, session, connector, transform, attempts=6):
    """Read the transform back; False (not confirmed) if it never matches or cannot be read."""
    for attempt in range(attempts):
        try:
            outputs = det.read_outputs(system, session)
        except (det.CannotTell, det.OutputsUnreadable):
            outputs = []
        if any(o.name == connector and o.transform == transform for o in outputs):
            return True
        if attempt + 1 < attempts:
            system.sleep(0.5)
    return False


def autologin_lines(state_now):
    if state_now == "on":
        return ["Autologin: already on for this user."]
    head = {
        "other_user": "Autologin: set for a different user, so the kiosk would not start after a power cut.",
        "off": "Autologin: off.",
    }.get(state_now, "Autologin: could not be read.")
    return [
        head + " This step needs administrator rights, so this tool does not do it. Run it yourself in the "
        "Pi's terminal; sudo asks for your password:",
        "  " + AUTOLOGIN_ON_CMD,
    ]


# --- setup ---------------------------------------------------------------------------------


def _state_or_refuse(state):
    kind = classify(state)
    if kind == "foreign":
        raise Refused("state_orphan")
    return kind


def run_setup(system, orientation, progress):
    home = system.home()
    session = supported_session(system)
    state = kf.State(home)
    check_no_links(state)
    _state_or_refuse(state)
    with Locked(state) as lock:
        kind = _state_or_refuse(state)  # again, now that no other run can change it
        manifest = load_manifest(state) if kind == "manifest" else None
        seen = observe_all(state)
        if manifest is not None:
            verify_accepted(manifest, seen)
            save_copies = copies_to_save(state, manifest, seen)
            base = originals(state, manifest, seen)
            original_states = {key: manifest["files"][key]["original"] for key in kf.MANAGED}
        else:
            save_copies = [key for key in kf.MANAGED if seen[key].exists]
            base = {key: seen[key].data for key in kf.MANAGED}
            original_states = {key: seen[key].state() for key in kf.MANAGED}
        if det.system_blanking(system):
            raise Refused("system_blanking")
        output = the_output(system, session)
        touch = the_touch(system)
        if orientation is None:
            orientation = manifest["orientation"] if manifest is not None else det.DEFAULT_ORIENTATION
        transform = det.transform_for(orientation, output)
        if any(det.launches_chromium(line) for line in kf.decode_text(base["autostart"]).splitlines()):
            raise Refused("manual_kiosk")
        meta = {
            "enabled": True,
            "orientation": orientation,
            "connector": output.name,
            "transform": transform,
            "touch_device": touch,
        }
        targets = build_targets(base, original_states, meta)
        autologin = det.autologin_state(system)
        if manifest is None:
            manifest = new_manifest(seen, autologin, meta)
            if kind == "leftover":
                _add(manifest["created_dirs"], [kiosk.KIOSK_STATE_DIR])
        recheck(state, seen)
        transact(state, manifest, seen, targets, meta, "setup", lock, progress, save_copies)

    reload_session(system, session)
    applied = rotation_applied(system, session, output.name, transform)
    kind_text = KIND_TEXT[det.connector_kind(output.name)]
    lines = [
        "Kiosk set up on the %s screen: %s (output transform %s)." % (kind_text, orientation, transform),
        "  Rotation: saved in the kanshi config; "
        + ("applied now." if applied else "not confirmed yet, it applies at the next login."),
        "  Touch: the one touch input is mapped to this screen in labwc rc.xml; labwc reloaded.",
        "  Screen blanking: off from the next login. The hub's own screensaver is not affected.",
        "  Launcher: one line in labwc autostart. It opens the hub once /api/health answers ok.",
        "  Snapshot: saved. ./scripts/sproutwall setup kiosk --undo restores the previous settings.",
        "",
        "Now tap the four corners and the centre of the screen. Each tap must land under your finger;",
        "a rotated picture alone does not prove the touch mapping. If taps land elsewhere, run",
        "./scripts/sproutwall setup kiosk --undo and report it.",
        "",
    ]
    lines += autologin_lines(autologin)
    lines += ["", "Then restart to start the kiosk: sudo reboot"]
    return EXIT_OK, lines


# --- off -------------------------------------------------------------------------------------


def run_off(system, progress):
    if system.euid() == 0:
        raise Refused("root")
    state = kf.State(system.home())
    check_no_links(state)
    if _state_or_refuse(state) != "manifest":
        return EXIT_OK, [NOT_INSTALLED]
    with Locked(state) as lock:
        if _state_or_refuse(state) != "manifest":
            return EXIT_OK, [NOT_INSTALLED]
        manifest = load_manifest(state)
        seen = observe_all(state)
        stopped = stop_running(system, state)
        stop_line = "Stopped the running kiosk browser." if stopped else "No kiosk browser was running."
        if kf.changed_since_setup(manifest, seen):
            code, text = REFUSALS["changed"]
            return code, [stop_line, text, "If the launcher line is still active, it starts again at the next login."]
        save_copies = copies_to_save(state, manifest, seen)
        base = originals(state, manifest, seen)
        meta = {key: manifest[key] for key in ("orientation", "connector", "transform", "touch_device")}
        meta["enabled"] = False
        original_states = {key: manifest["files"][key]["original"] for key in kf.MANAGED}
        targets = build_targets(base, original_states, meta)
        recheck(state, seen)  # after waiting for the browser to stop
        transact(state, manifest, seen, targets, meta, "off", lock, progress, save_copies)
    return EXIT_OK, [
        stop_line,
        "Kiosk launch is off: the launcher line stays in labwc autostart as a comment. Rotation, touch and "
        "blanking settings are kept.",
        "The hub keeps running; phones on the home network still reach it.",
        "Turn the kiosk back on with ./scripts/sproutwall setup kiosk (it starts at the next login).",
    ]


# --- undo --------------------------------------------------------------------------------------


def run_undo(system, progress):
    if system.euid() == 0:
        raise Refused("root")
    home = system.home()
    state = kf.State(home)
    check_no_links(state)
    if _state_or_refuse(state) != "manifest":
        return EXIT_OK, [NOT_INSTALLED]
    with Locked(state) as lock:
        if _state_or_refuse(state) != "manifest":
            return EXIT_OK, [NOT_INSTALLED]
        manifest = load_manifest(state)
        seen = observe_all(state)
        verify_accepted(manifest, seen)
        before = originals(state, manifest, seen)
        stop_running(system, state)
        recheck(state, seen)  # after waiting for the browser to stop
        targets = {key: (before[key], manifest["files"][key]["original"]["mode"]) for key in kf.MANAGED}
        meta = {key: manifest[key] for key in ("enabled", "orientation", "connector", "transform", "touch_device")}
        autologin_before = manifest["autologin_before"]
        manifest = transact(state, manifest, seen, targets, meta, "undo", lock, progress)
        folder_gone = remove_state(state, manifest, lock)
    try:
        session = det.find_session(system) if det.platform_supported(system) else None
    except det.CannotTell:
        session = None
    reloaded = session is not None and session.ok
    if reloaded:
        reload_session(system, session)
    lines = [
        "Kiosk removed. labwc autostart, labwc rc.xml and the kanshi config are back as they were before setup "
        "(files that did not exist then were removed). The launcher, its browser profile and the snapshot "
        "were deleted.",
        "Rotation and touch mapping were reloaded." if reloaded else "Rotation and touch mapping return at the next login.",
        "Screen blanking is back as it was from the next login. The hub and its data were not touched.",
    ]
    if not folder_gone:
        lines.append("The kiosk's state folder was kept, because it holds files this tool did not create.")
    if autologin_before in ("off", "other_user") and det.autologin_state(system) == "on":
        lines += [
            "Autologin was not on for this user before setup and is on now. To turn it off, run this yourself "
            "in the Pi's terminal:",
            "  " + AUTOLOGIN_OFF_CMD,
        ]
    return EXIT_OK, lines


# --- check ---------------------------------------------------------------------------------------

CHECK_SCHEMA = 1
CHECK_FIELDS = (
    ("result", ("ok", "attention", "not_installed", "unsupported", "unknown")),
    ("reason", ("none", "root", "unsupported_os", "no_desktop", "other_desktop", "session", "config_path", "no_chromium", "cannot_tell", "unknown")),
    ("installed", ("yes", "no", "damaged", "unknown")),
    ("launch", ("on", "off", "duplicate", "none", "unknown")),
    ("files", ("as_set_up", "partial", "changed", "none", "unknown")),
    ("running", ("yes", "no", "unknown")),
    ("output", ("one", "none", "several", "unsupported_connector", "unknown")),
    ("orientation", det.ORIENTATIONS + ("none", "unknown")),
    ("rotation", ("applied", "not_applied", "unknown")),
    ("touch", ("mapped", "not_mapped", "unknown")),
    ("blanking", ("off", "on", "system", "unknown")),
    ("autologin", ("on", "off", "other_user", "unknown")),
)
CHECK_TITLES = {
    "installed": "Set up by this tool",
    "launch": "Launcher line in labwc autostart",
    "files": "Managed files against the setup hashes",
    "running": "Launcher running now",
    "output": "Connected screens",
    "orientation": "Chosen orientation",
    "rotation": "Rotation in effect",
    "touch": "Touch mapped to the screen",
    "blanking": "Desktop screen blanking",
    "autologin": "Desktop autologin for this user",
}
CHECK_EXIT = {"ok": EXIT_OK, "attention": EXIT_ATTENTION, "not_installed": EXIT_ATTENTION, "unknown": EXIT_CANNOT_TELL}


def unknown_report(result="unknown", reason="unknown"):
    report = {key: "unknown" for key, _ in CHECK_FIELDS}
    report.update({"result": result, "reason": reason})
    return report


def serialize_check(report):
    """One line of JSON, closed: schema, then fixed keys in order, allowlisted values only."""
    if set(report) != {key for key, _ in CHECK_FIELDS}:
        raise ValueError("check keys")
    out = {"schema": CHECK_SCHEMA}
    for key, allowed in CHECK_FIELDS:
        canonical = next((item for item in allowed if item == report[key]), None)
        if canonical is None:
            raise ValueError("check value")
        out[key] = canonical
    return json.dumps(out, separators=(",", ":"), ensure_ascii=True)


def fallback_json():
    """The --check --json answer for a run that could not look at anything."""
    return serialize_check(unknown_report())


def _try(fn, default="unknown"):
    try:
        return fn()
    except (det.CannotTell, Refused, kf.RcXmlError, kf.StateDamaged, kf.ManagedFileError, OSError):
        return default


def gather_check(system):
    """(report dict, refusal key or None, names of fields not as setup left them)."""
    if system.euid() == 0:
        return unknown_report("unsupported", "root"), "root", []
    state = kf.State(system.home())
    manifest = None
    try:
        kind = state.classify()
        installed = {"absent": "no", "leftover": "no", "foreign": "damaged", "manifest": "yes"}[kind]
        if installed == "yes":
            manifest = state.load()
    except (kf.StateDamaged, kf.ManagedFileError):
        installed = "damaged"
    except OSError:
        installed = "unknown"
    session, reason = None, "none"
    try:
        session = supported_session(system)
    except Refused as refusal:
        reason = refusal.key
    except det.CannotTell:
        reason = "cannot_tell"
    if installed in ("no", "unknown") and session is None:
        return unknown_report("unsupported" if reason != "cannot_tell" else "unknown", reason), reason, []

    report = unknown_report("unknown", reason)
    report["installed"] = installed
    seen = _try(lambda: observe_all(state), None)
    current = {key: seen[key].data for key in kf.MANAGED} if seen is not None else None
    if current is not None:
        text = kf.decode_text(current["autostart"])
        active, inactive = kiosk.active_marker_lines(text), kiosk.inactive_marker_lines(text)
        report["launch"] = "duplicate" if active > 1 else "on" if active == 1 else "off" if inactive else "none"
        report["blanking"] = "on" if det.has_blanking(text) else "off"
    system_wide = _try(lambda: det.system_blanking(system), None)
    if system_wide is None:
        report["blanking"] = "unknown"
    elif system_wide:
        report["blanking"] = "system"
    report["autologin"] = det.autologin_state(system)
    report["running"] = _try(lambda: "yes" if launcher_processes(system, state) else "no")
    if installed == "no":
        report["files"], report["orientation"] = "none", "none"
    if manifest is not None:
        report["orientation"] = manifest["orientation"]
        if seen is not None:
            if kf.changed_since_setup(manifest, seen):
                report["files"] = "changed"  # bytes, mode or existence (a chmod counts)
            else:
                report["files"] = "as_set_up" if manifest["phase"] == "done" else "partial"
        if current is not None:
            report["touch"] = _try(
                lambda: "mapped"
                if kf.effective_touch_output([det.system_rc_xml(system), current["rc_xml"]], manifest["touch_device"])
                == manifest["connector"]
                else "not_mapped"
            )
    if session is not None:
        outputs = _try(lambda: det.read_outputs(system, session), None)
        if outputs is not None:
            report["output"] = det.classify_outputs(outputs)[0]
            if manifest is not None:
                live = [o for o in outputs if o.name == manifest["connector"]]
                report["rotation"] = "applied" if live and live[0].transform == manifest["transform"] else "not_applied"

    problems, unknown = [], []
    if installed == "yes":
        wanted = {
            "files": "as_set_up",
            "launch": "on" if manifest["enabled"] else "off",
            "output": "one",
            "rotation": "applied",
            "touch": "mapped",
            "blanking": "off",
            "autologin": "on",
        }
        problems = [key for key, value in wanted.items() if report[key] not in (value, "unknown")]
        unknown = [key for key in wanted if report[key] == "unknown"]
        report["result"] = "attention" if problems else "unknown" if unknown else "ok"
    elif installed == "no":
        report["result"] = "not_installed"
    elif installed == "damaged":
        report["result"] = "attention"
        problems = ["installed"]
    return report, None, problems


def check_lines(report, problems):
    lines = ["Sproutwall kiosk check"]
    for key, _ in CHECK_FIELDS[2:]:
        lines.append("  %-12s %-22s %s" % (key, report[key], CHECK_TITLES[key]))
    code = CHECK_EXIT[report["result"]]
    lines.append("Result: %s (exit %d)" % (report["result"], code))
    fixable = [p for p in problems if p != "autologin"]
    if fixable:
        lines.append(
            "Not everything is as setup left it (%s). Run ./scripts/sproutwall setup kiosk again, or --undo."
            % ", ".join(fixable)
        )
    if "autologin" in problems:
        lines.append("Autologin is not on for this user. Run this yourself in the Pi's terminal: " + AUTOLOGIN_ON_CMD)
    if report["result"] == "unknown":
        lines.append("Some items could not be read. Run this again from the Pi's desktop Terminal after a minute.")
    if report["result"] == "not_installed":
        lines.append("The kiosk is not set up by this tool yet: ./scripts/sproutwall setup kiosk")
    return code, lines


# --- entry -----------------------------------------------------------------------------------------


def run(system, action, orientation=None, json_mode=False, out=None, err=None):
    """Run one action ("setup", "check", "off", "undo"); write fixed text; return the exit code."""
    progress = Progress()
    try:
        if action == "check":
            report, refusal, problems = gather_check(system)
            if refusal is not None:
                code, lines = refusal_lines(refusal if refusal in REFUSALS else "cannot_tell")
                if json_mode:
                    out.write(serialize_check(report) + "\n")
                else:
                    err.write("\n".join(lines) + "\n")
                return code
            code, lines = check_lines(report, problems)
            out.write((serialize_check(report) if json_mode else "\n".join(lines)) + "\n")
            return code
        handlers = {"setup": lambda: run_setup(system, orientation, progress), "off": lambda: run_off(system, progress), "undo": lambda: run_undo(system, progress)}
        code, lines = handlers[action]()
        (out if code == EXIT_OK else err).write("\n".join(lines) + "\n")
        return code
    except Refused as refusal:
        code, lines = refusal_lines(refusal.key)
        err.write("\n".join(lines) + "\n")
        return code
    except (det.CannotTell, OSError):
        if progress.writing:
            err.write(CRASH_DURING + "\n")
            return EXIT_USAGE
        if json_mode:
            out.write(fallback_json() + "\n")
            return EXIT_CANNOT_TELL
        code, lines = refusal_lines("cannot_tell")
        err.write("\n".join(lines) + "\n")
        return code
    except (Exception, KeyboardInterrupt):  # noqa: BLE001 - fixed text only, never the error
        if json_mode:
            out.write(fallback_json() + "\n")
        else:
            err.write((CRASH_DURING if progress.writing else FAILED) + "\n")
        return EXIT_USAGE
