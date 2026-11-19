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
    if key == "changed":
        return code, [text]  # the text already says the files were left as they are
    return code, [text, UNCHANGED]


# --- shared steps --------------------------------------------------------------------

SESSION_REFUSAL = {
    "root": "root",
    "no_desktop": "no_desktop",
    "other_desktop": "other_desktop",
    "no_merge": "session",
    "no_kanshi": "session",
    "no_socket": "session",
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


def load_state(home):
    """(State, manifest or None). Raises Refused or det.CannotTell."""
    state = kf.State(home)
    try:
        if not state.present():
            return state, None
        return state, state.load()
    except kf.StateDamaged as error:
        raise Refused("state_damaged") from error
    except kf.ManagedFileError as error:
        raise Refused("link") from error
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


def current_files(state):
    try:
        return {key: kf.read_file(state.path(key)) for key in kf.MANAGED}
    except kf.ManagedFileError as error:
        raise Refused("link") from error
    except OSError as error:
        raise det.CannotTell("home-files") from error


def originals(state):
    try:
        return {key: state.original(key) for key in kf.MANAGED}
    except kf.StateDamaged as error:
        raise Refused("state_damaged") from error
    except OSError as error:
        raise det.CannotTell("state") from error


def statuses(manifest, current):
    return {key: kf.file_status(manifest["files"][key], current[key]) for key in kf.MANAGED}


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


def run_setup(system, orientation, progress):
    home = system.home()
    session = supported_session(system)
    state, manifest = load_state(home)
    check_no_links(state)
    current = current_files(state)
    if manifest is not None and kf.changed_since_setup(manifest, current):
        raise Refused("changed")
    if det.system_blanking(system):
        raise Refused("system_blanking")
    output = the_output(system, session)
    touch = the_touch(system)

    if orientation is None:
        orientation = manifest["orientation"] if manifest is not None else det.DEFAULT_ORIENTATION
    transform = det.transform_for(orientation, output)
    base = originals(state) if manifest is not None else dict(current)
    if any(det.launches_chromium(line) for line in kf.decode_text(base["autostart"]).splitlines()):
        raise Refused("manual_kiosk")
    try:
        new = {
            "launcher": kf.launcher_bytes(),
            "kanshi": kf.kanshi_text(base["kanshi"], output.name, transform),
            "rc_xml": kf.rc_xml_text(base["rc_xml"], touch, output.name),
            "autostart": kf.autostart_text(base["autostart"], True),
        }
    except kf.RcXmlError as error:
        raise Refused("rc_xml") from error
    autologin = det.autologin_state(system)
    if manifest is None:
        try:
            modes = {key: kf.file_mode(state.path(key)) for key in kf.MANAGED}
        except OSError as error:
            raise det.CannotTell("home-files") from error

    # Writes start here: first the snapshot, then the files, each verified.
    progress.writing = True
    created = list(manifest["created_dirs"]) if manifest is not None else []
    state.create(created)
    if manifest is None:
        files = {}
        for key in kf.MANAGED:
            if current[key] is not None:
                state.save_original(key, current[key])
            files[key] = {
                "existed": current[key] is not None,
                "mode": modes[key],
                "original": kf.sha256(current[key]),
                "written": None,
            }
        manifest = {"schema": kf.STATE_SCHEMA, "autologin_before": autologin, "files": files}
    for key in kf.WRITE_ORDER:
        kf.make_dirs(home, os.path.dirname(kf.MANAGED[key]), 0o755, created)
    for key in kf.MANAGED:
        manifest["files"][key]["written"] = kf.sha256(new[key])
    manifest.update(
        {
            "status": "writing",
            "enabled": True,
            "orientation": orientation,
            "connector": output.name,
            "transform": transform,
            "touch_device": touch,
            "created_dirs": created,
        }
    )
    state.save(manifest)
    for key in kf.WRITE_ORDER:
        entry = manifest["files"][key]
        mode = entry["mode"] if entry["existed"] and key != "launcher" else kf.DEFAULT_MODES[key]
        kf.write_atomic(state.path(key), new[key], mode)
    manifest["status"] = "installed"
    state.save(manifest)

    reload_session(system, session)
    applied = rotation_applied(system, session, output.name, transform)
    kind = KIND_TEXT[det.connector_kind(output.name)]
    lines = [
        "Kiosk set up on the %s screen: %s (output transform %s)." % (kind, orientation, transform),
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
    state, manifest = load_state(system.home())
    if manifest is None:
        return EXIT_OK, [NOT_INSTALLED]
    check_no_links(state)
    current = current_files(state)
    base = originals(state)["autostart"]
    stopped = stop_running(system, state)
    stop_line = "Stopped the running kiosk browser." if stopped else "No kiosk browser was running."
    entry = manifest["files"]["autostart"]
    if "autostart" in kf.changed_since_setup(manifest, current):
        code, text = REFUSALS["changed"]
        return code, [stop_line, text, "It starts again at the next login until this is fixed."]
    new = kf.autostart_text(base, False)
    progress.writing = True
    kf.make_dirs(state.home, os.path.dirname(kf.MANAGED["autostart"]), 0o755, manifest["created_dirs"])
    entry["written"] = kf.sha256(new)
    manifest["enabled"] = False
    state.save(manifest)
    mode = entry["mode"] if entry["existed"] else kf.DEFAULT_MODES["autostart"]
    kf.write_atomic(state.path("autostart"), new, mode)
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
    state, manifest = load_state(home)
    if manifest is None:
        return EXIT_OK, [NOT_INSTALLED]
    check_no_links(state)
    current = current_files(state)
    if kf.changed_since_setup(manifest, current):
        raise Refused("changed")
    before = originals(state)
    stop_running(system, state)
    progress.writing = True
    manifest["status"] = "undoing"
    state.save(manifest)
    for key in reversed(kf.WRITE_ORDER):  # the autostart line goes first
        if before[key] is None:
            kf.remove_file(state.path(key))
        else:
            kf.write_atomic(state.path(key), before[key], manifest["files"][key]["mode"])
    try:
        session = det.find_session(system) if det.platform_supported(system) else None
    except det.CannotTell:
        session = None
    reloaded = session is not None and session.ok
    if reloaded:
        reload_session(system, session)
    created = list(manifest["created_dirs"])
    autologin_before = manifest["autologin_before"]
    state.remove()
    kf.remove_created_dirs(home, created)
    lines = [
        "Kiosk removed. labwc autostart, labwc rc.xml and the kanshi config are back as they were before setup "
        "(files that did not exist then were removed). The launcher, its browser profile and the snapshot "
        "were deleted.",
        "Rotation and touch mapping were reloaded." if reloaded else "Rotation and touch mapping return at the next login.",
        "Screen blanking is back as it was from the next login. The hub and its data were not touched.",
    ]
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
    ("reason", ("none", "root", "unsupported_os", "no_desktop", "other_desktop", "session", "no_chromium", "cannot_tell", "unknown")),
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
        installed = "yes" if state.present() else "no"
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
    current = _try(lambda: current_files(state), None)
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
        if current is not None:
            found = set(statuses(manifest, current).values())
            if kf.changed_since_setup(manifest, current) and manifest["status"] == "installed":
                report["files"] = "changed"
            else:
                report["files"] = "changed" if "changed" in found else "partial" if "original" in found else "as_set_up"
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
