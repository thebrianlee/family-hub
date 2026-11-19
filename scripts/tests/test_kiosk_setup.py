"""setup kiosk end to end on a fake Raspberry Pi OS desktop with a real,
temporary home folder: refusals that change nothing (each proven to reach
the step it is about), the files written, --check, --off and re-enable,
--undo back to the original bytes, edits made after setup to each managed
file, unreadable sources, and doctor's kiosk check on the result."""

import ctypes
import errno
import io
import json
import os
import signal
import unittest
from unittest import mock

from sproutwall_lib import checks, cli, kiosk, kiosk_detect as det, kiosk_files as kf, kiosk_setup as ks
from sproutwall_lib.checks import Context

from . import kiosk_fakes as kfk
from .fakes import ROOT, ok

AUTOSTART = kiosk.KIOSK_AUTOSTART
RC = kiosk.KIOSK_RC_XML
KANSHI = kiosk.KIOSK_KANSHI
LAUNCHER = kiosk.KIOSK_LAUNCHER
MANAGED = (AUTOSTART, RC, KANSHI, LAUNCHER)
SWAYIDLE = "swayidle -w timeout 600 'wlopm --off \\*' resume 'wlopm --on \\*' &\n"
USER_AUTOSTART = "# added by me\nsqueekboard &\n" + SWAYIDLE
USER_RC = (
    '<?xml version="1.0" encoding="UTF-8"?>\n<openbox_config xmlns="http://openbox.org/3.4/rc">\n'
    '  <keyboard><keybind key="W-t"><action name="Execute" command="lxterminal"/></keybind></keyboard>\n'
    "</openbox_config>\n"
)
EXPECTED_CHECK_KEYS = [
    "schema", "result", "reason", "installed", "launch", "files", "running",
    "output", "orientation", "rotation", "touch", "blanking", "autologin",
]


def main(system, *args):
    out, err = io.StringIO(), io.StringIO()
    code = cli.main(["setup", "kiosk"] + list(args), system=system, root=ROOT, out=out, err=err)
    return code, out.getvalue(), err.getvalue()


def doctor_kiosk(system, wanted):
    """Doctor's kiosk check on what setup wrote. Doctor reads through System,
    whose fake keeps files in memory, so hand it the real file's bytes."""
    path = os.path.join(system.home(), AUTOSTART)
    system.files.pop(path, None)
    if os.path.exists(path):
        with open(path, "rb") as handle:
            system.files[path] = handle.read()
    return checks.check_kiosk(Context(system, ROOT, "final", "A", wanted))


class Base(unittest.TestCase):
    def setUp(self):
        kfk.portable(self)
        self.home = kfk.temp_home(self)
        # labwc-pi creates an empty kanshi config at login; the user has an
        # autostart with blanking on and an rc.xml of their own.
        kfk.write(self.home, KANSHI, b"")
        kfk.write(self.home, AUTOSTART, USER_AUTOSTART, mode=0o640)
        kfk.write(self.home, RC, USER_RC)
        self.before = kfk.tree(self.home)

    def pi(self, **kwargs):
        return kfk.KioskPi(self.home, **kwargs)

    def assert_unchanged(self, system=None, snapshot=None):
        self.assertEqual(kfk.tree(self.home), snapshot if snapshot is not None else self.before)
        if system is not None:
            self.assertEqual(system.kills, [], "nothing was signalled")

    def randr_called(self, system):
        return ("wlr-randr", "--json") in [argv for argv, _ in system.calls]


class RefusalTests(Base):
    def refused(self, system, code, *needles, args=()):
        got, out, err = main(system, *args)
        self.assertEqual(got, code, err)
        self.assertEqual(out, "")
        for needle in needles:
            self.assertIn(needle, err)
        self.assert_unchanged(system)
        return err

    def test_root(self):
        s = self.pi()
        s.euid_value = 0
        self.refused(s, ks.EXIT_UNSUPPORTED, "without sudo", "Nothing was changed.")
        self.assertEqual(s.calls, [])

    def test_other_device(self):
        s = self.pi()
        s.arch = "x86_64"
        self.refused(s, ks.EXIT_UNSUPPORTED, "Kiosk on other devices", "Nothing was changed.")

    def test_non_labwc_sessions(self):
        for comm in ("Xorg", "wayfire"):
            s = self.pi()
            s.procs = [p for p in s.procs if p[2] != "labwc"] + [(901, kfk.UID, comm, [comm])]
            self.refused(s, ks.EXIT_UNSUPPORTED, "never configures those", "Nothing was changed.")
            self.assertGreaterEqual(s.process_reads, 1)
            self.assertFalse(self.randr_called(s))

    def test_lite_image(self):
        s = self.pi()
        s.procs = [p for p in s.procs if p[2] not in ("labwc", "kanshi")]
        self.refused(s, ks.EXIT_UNSUPPORTED, "(Lite) is not supported")
        self.assertGreaterEqual(s.process_reads, 1)

    def test_no_chromium(self):
        s = self.pi()
        del s.files["/usr/bin/chromium"]
        self.refused(s, ks.EXIT_UNSUPPORTED, "Chromium was not found")
        self.assertIn("/usr/bin/chromium-browser", s.probes)

    def test_output_counts(self):
        cases = (
            ([], ks.EXIT_NOT_READY, "Reconnect or switch on"),
            ([kfk.output_json("HDMI-A-1"), kfk.output_json("HDMI-A-2")], ks.EXIT_NOT_READY, "more than one screen"),
            ([kfk.output_json("DPI-1")], ks.EXIT_UNSUPPORTED, "not on an HDMI or DSI connector"),
        )
        for outputs, code, needle in cases:
            s = self.pi(outputs=outputs)
            self.refused(s, code, needle)
            self.assertTrue(self.randr_called(s))
            self.assertNotIn(det.INPUT_DEVICES, s.reads)  # stopped at the output step

    def test_touch_ambiguity_and_absence(self):
        for touch, needle in ((kfk.usb_touch() + "\n" + kfk.dsi_touch(), "more than one touch input"), ("", "no touch input")):
            s = self.pi(touch=touch)
            self.refused(s, ks.EXIT_NOT_READY, needle)
            self.assertTrue(self.randr_called(s))
            self.assertIn(det.INPUT_DEVICES, s.reads)

    def test_system_wide_blanking(self):
        s = self.pi()
        s.files["/etc/xdg/labwc/autostart"] += SWAYIDLE
        self.refused(s, ks.EXIT_UNSUPPORTED, "every user of this Pi")
        self.assertIn(det.SYSTEM_AUTOSTART, s.reads)

    def test_hand_made_kiosk_line(self):
        kfk.write(self.home, AUTOSTART, USER_AUTOSTART + "chromium http://localhost:3847 --kiosk &\n", mode=0o640)
        self.before = kfk.tree(self.home)
        s = self.pi()
        self.refused(s, ks.EXIT_NOT_READY, "added by hand")
        self.assertIn(det.INPUT_DEVICES, s.reads)

    def test_unmergeable_rc_xml(self):
        kfk.write(self.home, RC, "<openbox_config><oops></openbox_config>")
        self.before = kfk.tree(self.home)
        s = self.pi()
        self.refused(s, ks.EXIT_UNSUPPORTED, "could not be merged safely")
        self.assertIn(det.INPUT_DEVICES, s.reads)

    def test_links_and_non_folders(self):
        target = kfk.write(self.home, "dotfiles/rc.xml", USER_RC)
        os.unlink(os.path.join(self.home, RC))
        os.symlink(target, os.path.join(self.home, RC))
        self.before = kfk.tree(self.home)
        self.refused(self.pi(), ks.EXIT_UNSUPPORTED, "is a link")

    def test_a_file_where_a_folder_belongs(self):
        kfk.write(self.home, ".local", "not a folder")
        self.before = kfk.tree(self.home)
        self.refused(self.pi(), ks.EXIT_UNSUPPORTED, "is a link or not a regular file or folder")

    def test_off_and_undo_without_setup(self):
        for action in ("--off", "--undo"):
            code, out, err = main(self.pi(), action)
            self.assertEqual((code, err), (0, ""))
            self.assertIn("not set up by this tool", out)
            self.assert_unchanged()


class CannotTellTests(Base):
    """A read that fails for any reason but ENOENT, or input that does not
    parse, stops setup before any edit (exit 6), never read as absent."""

    def cannot_tell(self, system, *args, reached=None):
        code, out, err = main(system, *args)
        self.assertEqual(code, ks.EXIT_CANNOT_TELL, err)
        self.assertIn("cannot tell whether changing the screen settings is safe", err)
        self.assertIn("Nothing was changed.", err)
        self.assert_unchanged(system)
        if reached is not None:
            reached(system)

    def test_sources(self):
        cases = {
            "process table": lambda s: setattr(s, "procs", PermissionError(13, "denied")),
            "kanshi environment": lambda s: s.environs.__setitem__(kfk.KANSHI_PID, PermissionError(13, "denied")),
            "wayland socket": lambda s: s.probe_errors.add(kfk.RUNTIME + "/wayland-0"),
            "chromium": lambda s: s.probe_errors.add("/usr/bin/chromium"),
            "rpi-issue": lambda s: s.probe_errors.add("/etc/rpi-issue"),
            "device model": lambda s: s.files.__setitem__("/proc/device-tree/model", OSError(5, "I/O error")),
            "dpkg": lambda s: s.set(["dpkg", "--print-architecture"], ok(rc=2)),
            "system autostart": lambda s: s.files.__setitem__("/etc/xdg/labwc/autostart", PermissionError(13, "denied")),
            "input devices": lambda s: s.files.__setitem__("/proc/bus/input/devices", PermissionError(13, "denied")),
            "input devices garbled": lambda s: s.files.__setitem__("/proc/bus/input/devices", "Z: what\n"),
            "wlr-randr garbled": lambda s: (s.set(["wlr-randr", "--json"], ok("[1]")), s.set(["wlr-randr"], ok("??\n"))),
            "wlr-randr failing": lambda s: (s.set(["wlr-randr", "--json"], ok(rc=1)), s.set(["wlr-randr"], ok(rc=1))),
        }
        for name, change in cases.items():
            with self.subTest(name):
                s = self.pi()
                change(s)
                self.cannot_tell(s)

    def test_home_files_and_state(self):
        real_observe = kf.observe
        for rel in MANAGED:

            def failing(home, path, target=rel):
                if path == target:
                    raise PermissionError(13, "denied")
                return real_observe(home, path)

            with self.subTest(rel), mock.patch.object(kf, "observe", side_effect=failing) as observer:
                self.cannot_tell(self.pi())
                self.assertIn(mock.call(self.home, rel), observer.call_args_list)
        with mock.patch.object(kf.State, "classify", side_effect=PermissionError(13, "denied")) as classify:
            self.cannot_tell(self.pi())
            self.cannot_tell(self.pi(), "--off")
            self.cannot_tell(self.pi(), "--undo")
        self.assertEqual(classify.call_count, 3)

    def test_off_and_undo_with_an_unreadable_process_table(self):
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        self.before = kfk.tree(self.home)  # as installed
        for action in ("--off", "--undo"):
            s = self.pi()
            s.procs = PermissionError(13, "denied")
            self.cannot_tell(s, action)

    def test_check_reports_unknown(self):
        s = self.pi()
        s.files["/proc/bus/input/devices"] = PermissionError(13, "denied")  # check does not need it
        s.set(["wlr-randr", "--json"], ok(rc=1))
        s.set(["wlr-randr"], ok(rc=1))
        s.files["/etc/lightdm/lightdm.conf"] = PermissionError(13, "denied")
        code, out, _ = main(s, "--check", "--json")
        data = json.loads(out)
        self.assertEqual((data["output"], data["autologin"], data["installed"]), ("unknown", "unknown", "no"))
        self.assertEqual((data["rotation"], data["touch"], data["files"]), ("none", "none", "none"))
        # Any field not read makes the whole result unknown, never not_installed or ok.
        self.assertEqual((code, data["result"]), (ks.EXIT_CANNOT_TELL, "unknown"))
        self.assertTrue(self.randr_called(s))


class SetupTests(Base):
    def test_writes_exactly_what_it_manages(self):
        s = self.pi()
        code, out, err = main(s)
        self.assertEqual(code, 0, err)
        self.assertIn("Kiosk set up on the HDMI screen: portrait (output transform 90).", out)
        self.assertIn("applied now", out)
        self.assertIn("tap the four corners", out)
        self.assertIn("sudo raspi-config nonint do_boot_behaviour B4", out)
        self.assertNotIn("HDMI-A-1", out + err)

        autostart = kfk.read(self.home, AUTOSTART).decode()
        self.assertEqual(autostart, "# added by me\nsqueekboard &\n" + kiosk.LAUNCH_LINE + "\n")
        self.assertEqual(os.stat(os.path.join(self.home, AUTOSTART)).st_mode & 0o777, 0o640)
        rc = kfk.read(self.home, RC)
        self.assertEqual(kf.effective_touch_output([kfk.SYSTEM_RC.encode(), rc], "ILITEK ILITEK-TP"), "HDMI-A-1")
        block = "  " + kf.TOUCH_MARK + '\n  <touch deviceName="ILITEK ILITEK-TP" mapToOutput="HDMI-A-1" />\n'
        self.assertEqual(rc.decode().replace(block, ""), USER_RC)
        self.assertIn(b"output HDMI-A-1 enable transform 90", kfk.read(self.home, KANSHI))
        self.assertEqual(kfk.read(self.home, LAUNCHER), kf.launcher_bytes())
        self.assertEqual(os.stat(os.path.join(self.home, LAUNCHER)).st_mode & 0o777, 0o755)
        state = os.path.join(self.home, kiosk.KIOSK_STATE_DIR)
        self.assertEqual(os.stat(state).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(os.path.join(state, "manifest.json")).st_mode & 0o777, 0o600)
        self.assertEqual(set(os.listdir(os.path.join(state, "original"))), {"autostart", "rc_xml", "kanshi"})
        no_temp = [n for _, _, names in os.walk(self.home) for n in names if n.endswith(kf.TMP_SUFFIX)]
        self.assertEqual(no_temp, [])
        # labwc and kanshi were reloaded with SIGHUP; nothing else was signalled.
        self.assertEqual(sorted(s.kills), sorted([(kfk.KANSHI_PID, signal.SIGHUP), (kfk.LABWC_PID, signal.SIGHUP)]))
        self.assertEqual(s.outputs[0]["transform"], "90")
        self.assertEqual(doctor_kiosk(s, "on"), ("pass", "none"))

    def test_creates_missing_files(self):
        for rel in (AUTOSTART, RC, KANSHI):
            os.unlink(os.path.join(self.home, rel))
        code, _, err = main(self.pi())
        self.assertEqual(code, 0, err)
        self.assertEqual(kfk.read(self.home, AUTOSTART).decode(), kiosk.LAUNCH_LINE + "\n")
        self.assertIsNotNone(kfk.read(self.home, RC))

    def test_second_run_adds_nothing(self):
        s = self.pi()
        main(s)
        first = kfk.tree(self.home)
        code, _, err = main(s)
        self.assertEqual(code, 0, err)
        second = kfk.tree(self.home)
        for rel in MANAGED:
            self.assertEqual(second[rel], first[rel], rel)
        self.assertEqual(kiosk.active_marker_lines(kfk.read(self.home, AUTOSTART).decode()), 1)

    def test_orientations(self):
        expected = {"portrait": "90", "portrait-flipped": "270", "landscape": "normal", "landscape-flipped": "180"}
        s = self.pi()
        for orientation, transform in expected.items():
            code, out, err = main(s, "--orientation", orientation)
            self.assertEqual(code, 0, err)
            self.assertIn(b"enable transform %s\n" % transform.encode(), kfk.read(self.home, KANSHI))
            self.assertEqual(s.outputs[0]["transform"], transform)

    def test_portrait_panel_stays_normal(self):
        s = self.pi(outputs=[kfk.output_json("DSI-1", width=720, height=1280)], touch=kfk.dsi_touch())
        code, out, err = main(s)
        self.assertEqual(code, 0, err)
        self.assertIn("on the DSI screen: portrait (output transform normal)", out)

    def test_plain_wlr_randr(self):
        s = self.pi(json_randr=False)
        code, out, err = main(s)
        self.assertEqual(code, 0, err)
        self.assertIn("applied now", out)
        self.assertIn(("wlr-randr",), [argv for argv, _ in s.calls])

    def test_rotation_not_confirmed(self):
        s = self.pi()
        s.kill = lambda pid, sig: s.kills.append((pid, sig)) or "sent"  # kanshi does not react
        code, out, _ = main(s)
        self.assertEqual(code, 0)
        self.assertIn("not confirmed yet", out)
        self.assertEqual(len(s.sleeps), 5)

    def test_autologin_already_on(self):
        s = self.pi()
        s.files["/etc/lightdm/lightdm.conf"] = kfk.lightdm("pi")
        code, out, _ = main(s)
        self.assertIn("Autologin: already on", out)
        self.assertNotIn("do_boot_behaviour", out)

    def test_a_failed_write_check_says_writing_started(self):
        s = self.pi()
        with mock.patch.object(kf, "write_atomic", side_effect=kf.WriteCheckFailed("x")) as writer:
            code, out, err = main(s)
        self.assertTrue(writer.called)
        self.assertEqual(code, 2)
        self.assertEqual(err, ks.CRASH_DURING + "\n")


class CheckTests(Base):
    def report(self, system):
        code, out, err = main(system, "--check", "--json")
        lines = out.splitlines()
        self.assertEqual(len(lines), 1)
        data = json.loads(lines[0])
        self.assertEqual(list(data), EXPECTED_CHECK_KEYS)
        return code, data

    def test_before_and_after_setup(self):
        s = self.pi()
        code, data = self.report(s)
        self.assertEqual((code, data["result"], data["installed"], data["blanking"]), (1, "not_installed", "no", "on"))
        main(s)
        code, data = self.report(s)
        self.assertEqual((data["result"], data["autologin"]), ("attention", "off"))
        s.files["/etc/lightdm/lightdm.conf"] = kfk.lightdm("pi")
        code, data = self.report(s)
        self.assertEqual(code, 0)
        self.assertEqual(
            data,
            {
                "schema": 1, "result": "ok", "reason": "none", "installed": "yes", "launch": "on",
                "files": "as_set_up", "running": "no", "output": "one", "orientation": "portrait",
                "rotation": "applied", "touch": "mapped", "blanking": "off", "autologin": "on",
            },
        )
        code, out, _ = main(s, "--check")
        self.assertEqual(code, 0)
        self.assertIn("Result: ok (exit 0)", out)

    def test_notices_problems(self):
        s = self.pi()
        s.files["/etc/lightdm/lightdm.conf"] = kfk.lightdm("pi")
        main(s)
        s.outputs[0]["transform"] = "normal"  # rotated back in Control Centre (live only)
        self.assertEqual(self.report(s)[1]["rotation"], "not_applied")
        with open(os.path.join(self.home, AUTOSTART), "a", encoding="utf-8") as handle:
            handle.write(kiosk.LAUNCH_LINE + "\n")
        code, data = self.report(s)
        self.assertEqual((code, data["launch"], data["files"]), (1, "duplicate", "changed"))
        code, out, _ = main(s, "--check")
        self.assertIn("Not everything is as setup left it (files, launch, rotation)", out)

    def test_refused_off_device(self):
        s = self.pi()
        s.arch = "x86_64"
        code, data = self.report(s)
        self.assertEqual((code, data["result"], data["reason"]), (3, "unsupported", "unsupported_os"))
        self.assertEqual({data[k] for k in EXPECTED_CHECK_KEYS[3:]}, {"unknown"})  # nothing was looked at

    def test_every_refusal_reason_serializes(self):
        cases = {
            "root": lambda s: setattr(s, "euid_value", 0),
            "unsupported_os": lambda s: setattr(s, "arch", "x86_64"),
            "no_desktop": lambda s: setattr(s, "procs", [p for p in s.procs if p[2] not in ("labwc", "kanshi")]),
            "other_desktop": lambda s: setattr(s, "procs", [p for p in s.procs if p[2] != "labwc"] + [(9, kfk.UID, "wayfire", ["wayfire"])]),
            "session": lambda s: setattr(s, "procs", [p for p in s.procs if p[2] != "kanshi"]),
            "config_path": lambda s: s.environs[kfk.LABWC_PID].__setitem__("XDG_CONFIG_HOME", "/srv"),
            "no_chromium": lambda s: s.files.pop("/usr/bin/chromium"),
            "cannot_tell": lambda s: setattr(s, "procs", PermissionError(13, "denied")),
        }
        for reason, change in cases.items():
            s = self.pi()
            change(s)
            code, data = self.report(s)
            self.assertEqual(data["reason"], reason)
            self.assertEqual(data["result"], "unknown" if reason == "cannot_tell" else "unsupported")
            self.assertEqual(code, ks.EXIT_CANNOT_TELL if reason == "cannot_tell" else ks.EXIT_UNSUPPORTED, reason)
            code, out, err = main(s, "--check")
            self.assertEqual(out, "")
            self.assertIn("Nothing was changed.", err)

    def test_damaged_state(self):
        s = self.pi()
        main(s)
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "manifest.json"), "{}", mode=0o600)
        code, data = self.report(s)
        # Without a usable record, files, rotation and touch cannot be judged: unknown.
        self.assertEqual((code, data["installed"], data["result"], data["files"]), (6, "damaged", "unknown", "unknown"))

    def test_any_unknown_field_is_never_ok(self):
        s = self.pi()
        s.files["/etc/lightdm/lightdm.conf"] = kfk.lightdm("pi")
        main(s)
        self.assertEqual(self.report(s)[1]["result"], "ok")
        real = ks.launcher_processes

        def unreadable(system, state):
            raise det.CannotTell("process table")

        with mock.patch.object(ks, "launcher_processes", side_effect=unreadable) as reader:
            code, data = self.report(s)
        self.assertTrue(reader.called)
        self.assertEqual((code, data["running"], data["result"]), (ks.EXIT_CANNOT_TELL, "unknown", "unknown"))
        self.assertIs(ks.launcher_processes, real)

    def test_missing_tools(self):
        """--check never crashes when a tool it runs is missing: the items
        that need it are unknown, in text and JSON, before and after setup."""
        removals = {
            "wlr-randr": lambda s: [s.commands.pop(key) for key in (("wlr-randr", "--json"), ("wlr-randr",))],
            "dpkg": lambda s: s.commands.pop(("dpkg", "--print-architecture")),
            "chromium": lambda s: s.files.pop("/usr/bin/chromium"),
        }
        for installed in (False, True):
            if installed:
                self.assertEqual(main(self.pi())[0], 0)
            for tool, remove in removals.items():
                for args in (("--check",), ("--check", "--json")):
                    with self.subTest(tool, installed=installed, args=args):
                        s = self.pi()
                        remove(s)
                        code, out, err = main(s, *args)
                        self.assertNotIn(code, (0, 2), (out, err))
                        self.assertNotIn("unexpected error", out + err)
                        if "--json" in args:
                            data = json.loads(out)
                            self.assertEqual(list(data), EXPECTED_CHECK_KEYS)
                            if tool == "wlr-randr":
                                self.assertEqual((data["output"], data["result"]), ("unknown", "unknown"))
                                self.assertEqual(data["rotation"], "unknown" if installed else "none")
                        if tool == "wlr-randr":
                            self.assertIn(("wlr-randr", "--json"), [argv for argv, _ in s.calls])

    def test_duplicate_keys_in_the_record(self):
        s = self.pi()
        main(s)
        path = os.path.join(self.home, kiosk.KIOSK_STATE_DIR, "manifest.json")
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        kfk.write(self.home, os.path.relpath(path, self.home), text.replace('"enabled": true', '"enabled": true, "enabled": false'), mode=0o600)
        self.assertIn('"enabled": false', kfk.read(self.home, os.path.relpath(path, self.home)).decode())
        self.assertEqual(self.report(s)[1]["installed"], "damaged")
        snapshot = kfk.tree(self.home)
        for args in ((), ("--off",), ("--undo",)):
            code, _, err = main(s, *args)
            self.assertEqual(code, ks.EXIT_CHANGED, args)
            self.assertIn("damaged", err)
            self.assertEqual(kfk.tree(self.home), snapshot)

    def test_json_usage_errors(self):
        for args in (["--check", "--json", "--off"], ["--json"], ["--orientation", "Riley", "--check", "--json"], ["--help", "--json"]):
            code, out, err = main(self.pi(), *args)
            self.assertEqual(code, 2, args)
            self.assertEqual(json.loads(out), dict({"schema": 1}, **{k: "unknown" for k in EXPECTED_CHECK_KEYS[1:]}))
            self.assertEqual(err, "")


class OffTests(Base):
    def test_off_then_on(self):
        s = self.pi()
        s.files["/etc/lightdm/lightdm.conf"] = kfk.lightdm("pi")
        main(s)
        installed = kfk.tree(self.home)
        launcher = os.path.join(self.home, LAUNCHER)
        profile = os.path.join(self.home, kiosk.KIOSK_STATE_DIR, "browser")
        base = list(s.procs)
        s.procs = base + [
            (1200, kfk.UID, "python3", ["/usr/bin/python3", "-I", launcher]),
            (1201, kfk.UID, "chromium", ["/usr/lib/chromium/chromium", "--kiosk", "--user-data-dir=" + profile, "http://127.0.0.1:3847/"]),
            (1202, kfk.UID, "chromium", ["/usr/lib/chromium/chromium", "--type=renderer", "--user-data-dir=" + profile]),
            (1300, kfk.UID, "chromium", ["/usr/lib/chromium/chromium", "--user-data-dir=/elsewhere"]),
            (1400, 1001, "python3", ["/usr/bin/python3", "-I", launcher]),  # another user's: never touched
        ]
        s.kills.clear()
        original_kill = s.kill

        def kill(pid, sig):
            s.procs = [p for p in s.procs if p[0] != pid]  # the launcher exits on SIGTERM
            return original_kill(pid, sig)

        s.kill = kill
        code, out, err = main(s, "--off")
        self.assertEqual(code, 0, err)
        self.assertIn("Stopped the running kiosk browser.", out)
        self.assertIn("phones on the home network still reach it", out)
        self.assertEqual(sorted(s.kills), [(1200, signal.SIGTERM), (1201, signal.SIGTERM)])
        text = kfk.read(self.home, AUTOSTART).decode()
        self.assertEqual((kiosk.active_marker_lines(text), kiosk.inactive_marker_lines(text)), (0, 1))
        self.assertEqual(doctor_kiosk(s, "off"), ("pass", "none"))
        self.assertEqual(doctor_kiosk(s, "on"), ("fail", "repair_kiosk"))
        for rel in (RC, KANSHI, LAUNCHER):  # configuration kept for re-enable
            self.assertEqual(kfk.read(self.home, rel), installed[rel][2])
        s.procs = base
        code, out, _ = main(s, "--check")
        self.assertEqual(code, 0, out)
        self.assertIn("launch       off", out)
        before = kfk.tree(self.home)
        self.assertEqual(main(s, "--off")[0], 0)  # a second --off changes nothing
        self.assertEqual(kfk.tree(self.home)[AUTOSTART], before[AUTOSTART])
        code, _, err = main(s)  # re-enable: the bytes of the first setup, one active line
        self.assertEqual(code, 0, err)
        after = kfk.tree(self.home)
        for rel in MANAGED:
            self.assertEqual(after[rel], installed[rel], rel)
        self.assertEqual(doctor_kiosk(s, "on"), ("pass", "none"))

    def test_a_browser_that_ignores_sigterm_is_killed(self):
        s = self.pi()
        main(s)
        profile = os.path.join(self.home, kiosk.KIOSK_STATE_DIR, "browser")
        s.procs.append((1201, kfk.UID, "chromium", ["chromium", "--user-data-dir=" + profile]))
        s.kills.clear()
        real_kill = s.kill

        def kill(pid, sig):
            if sig == signal.SIGKILL:
                s.procs = [p for p in s.procs if p[0] != pid]
            return real_kill(pid, sig)

        s.kill = kill
        self.assertEqual(main(s, "--off")[0], 0)
        self.assertEqual(s.kills, [(1201, signal.SIGTERM), (1201, signal.SIGKILL)])

    def test_a_process_that_cannot_be_stopped(self):
        """A signal that is refused, or a process still there after SIGKILL,
        stops --off and --undo before they write anything (exit 4)."""
        for action in ("--off", "--undo"):
            for case in ("denied", "survives"):
                with self.subTest(action=action, case=case):
                    self.setUp()
                    s = self.pi()
                    self.assertEqual(main(s)[0], 0)
                    profile = os.path.join(self.home, kiosk.KIOSK_STATE_DIR, "browser")
                    s.procs.append((1201, kfk.UID, "chromium", ["chromium", "--user-data-dir=" + profile]))
                    if case == "denied":
                        s.kill_results[1201] = "denied"
                    s.kills.clear()
                    snapshot = kfk.tree(self.home)
                    code, _, err = main(s, action)
                    self.assertEqual(code, ks.EXIT_NOT_READY, err)
                    self.assertIn("could not be stopped", err)
                    self.assertIn("Nothing was changed.", err)
                    self.assertEqual(kfk.tree(self.home), snapshot)
                    expected = [(1201, signal.SIGTERM)] if case == "denied" else [(1201, signal.SIGTERM), (1201, signal.SIGKILL)]
                    self.assertEqual(s.kills, expected)

    def test_orientation_is_kept_on_re_enable(self):
        s = self.pi()
        main(s, "--orientation", "landscape-flipped")
        main(s, "--off")
        main(s)
        self.assertIn(b"enable transform 180\n", kfk.read(self.home, KANSHI))

    def test_off_after_an_outside_edit_still_stops_the_browser(self):
        s = self.pi()
        main(s)
        launcher = os.path.join(self.home, LAUNCHER)
        s.procs.append((1200, kfk.UID, "python3", ["/usr/bin/python3", "-I", launcher]))
        real_kill = s.kill

        def kill(pid, sig):
            s.procs = [p for p in s.procs if p[0] != pid]  # the launcher exits on SIGTERM
            return real_kill(pid, sig)

        s.kill = kill
        with open(os.path.join(self.home, AUTOSTART), "a", encoding="utf-8") as handle:
            handle.write("my-new-app &\n")
        snapshot = kfk.tree(self.home)
        code, out, err = main(s, "--off")
        self.assertEqual(code, ks.EXIT_CHANGED)
        self.assertIn("Stopped the running kiosk browser.", err)
        self.assertEqual(kfk.tree(self.home), snapshot)


class UndoTests(Base):
    def test_restores_the_original_bytes(self):
        os.unlink(os.path.join(self.home, KANSHI))  # absent before setup
        self.before = kfk.tree(self.home)
        s = self.pi()
        main(s)
        self.assertNotEqual(kfk.tree(self.home), self.before)
        s.kills.clear()
        code, out, err = main(s, "--undo")
        self.assertEqual(code, 0, err)
        self.assertIn("Kiosk removed.", out)
        self.assertIn("Rotation and touch mapping were reloaded.", out)
        self.assertEqual(kfk.tree(self.home), self.before)  # bytes, modes, absent files and folders
        self.assertEqual(s.outputs[0]["transform"], "normal")
        self.assertIn((kfk.LABWC_PID, signal.SIGHUP), s.kills)
        self.assertEqual(doctor_kiosk(s, "off"), ("pass", "none"))

    def test_into_an_empty_home(self):
        empty = kfk.temp_home(self, "fresh")
        s = kfk.KioskPi(empty)
        self.assertEqual(main(s)[0], 0)
        self.assertEqual(main(s, "--undo")[0], 0)
        self.assertEqual(kfk.tree(empty), {})

    def test_after_off_and_reenable_after_undo(self):
        s = self.pi()
        main(s)
        main(s, "--off")
        self.assertEqual(main(s, "--undo")[0], 0)
        self.assertEqual(kfk.tree(self.home), self.before)
        code, _, err = main(s)
        self.assertEqual(code, 0, err)
        self.assertEqual(kiosk.active_marker_lines(kfk.read(self.home, AUTOSTART).decode()), 1)
        self.assertEqual(main(s, "--undo")[0], 0)
        self.assertEqual(kfk.tree(self.home), self.before)

    def test_damaged_snapshot(self):
        s = self.pi()
        main(s)
        with open(os.path.join(self.home, kiosk.KIOSK_STATE_DIR, "original", "rc_xml"), "ab") as handle:
            handle.write(b"x")
        snapshot = kfk.tree(self.home)
        code, _, err = main(s, "--undo")
        self.assertEqual(code, ks.EXIT_CHANGED)
        self.assertIn("damaged", err)
        self.assertEqual(kfk.tree(self.home), snapshot)

    def test_autologin_hint(self):
        s = self.pi()
        main(s)
        s.files["/etc/lightdm/lightdm.conf"] = kfk.lightdm("pi")  # the person ran the B4 command
        code, out, _ = main(s, "--undo")
        self.assertIn("sudo raspi-config nonint do_boot_behaviour B3", out)


class InterruptedRunTests(Base):
    """A run that stopped halfway (a crash between two file writes) can be
    finished: the files found as they were before setup are accepted only
    while the manifest says a run was in progress."""

    def fail_on_second_write(self):
        """write_atomic fails (no space) on its second managed file, before
        writing it; the wrapper takes the real signature, expect included."""
        real = kf.write_atomic
        calls = []

        def write(home, rel, data, mode, expect):
            calls.append(rel)
            if len(calls) == 2:
                raise OSError(28, "No space left on device")
            return real(home, rel, data, mode, expect)

        return mock.patch.object(kf, "write_atomic", side_effect=write), calls

    def test_setup_then_finish(self):
        s = self.pi()
        patch, calls = self.fail_on_second_write()
        with patch:
            code, _, err = main(s)
        self.assertEqual((code, err), (2, ks.CRASH_DURING + "\n"))
        self.assertEqual(calls, [LAUNCHER, KANSHI])  # the failure point was reached
        code, _, err = main(s)  # finishes setup
        self.assertEqual(code, 0, err)
        self.assertEqual(main(s, "--undo")[0], 0)
        self.assertEqual(kfk.tree(self.home), self.before)

    def test_undo_then_finish(self):
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        patch, calls = self.fail_on_second_write()
        with patch:
            code, _, err = main(s, "--undo")
        self.assertEqual((code, err), (2, ks.CRASH_DURING + "\n"))
        self.assertEqual(calls, [AUTOSTART, RC])  # the failure point was reached
        self.assertNotEqual(kfk.tree(self.home), self.before)
        code, _, err = main(s, "--undo")  # finishes the undo
        self.assertEqual(code, 0, err)
        self.assertEqual(kfk.tree(self.home), self.before)


EDITS = {
    AUTOSTART: lambda data: data + b"my-new-app &\n",
    RC: lambda data: data.replace(b"</openbox_config>", b"  <core><gap>4</gap></core>\n</openbox_config>"),
    KANSHI: lambda data: data + b"profile docked {\n\toutput HDMI-A-2 enable\n}\n",
    LAUNCHER: lambda data: data + b"# my tweak\n",
}


class EditedAfterSetupTests(Base):
    """For every managed file: an edit (or a deletion) after setup stops
    setup, --undo and (for autostart) --off with exit 5, and changes nothing.
    Putting the file back lets --undo restore the original."""

    def edited(self, rel, change):
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        path = os.path.join(self.home, rel)
        with open(path, "rb") as handle:
            written = handle.read()
        self.written_mode = os.stat(path).st_mode & 0o7777
        if change == "delete":
            os.unlink(path)
        else:
            with open(path, "wb") as handle:
                handle.write(EDITS[rel](written))
        return s, path, written

    def test_every_file_and_action(self):
        for rel in MANAGED:
            for change in ("edit", "delete"):
                with self.subTest(rel=rel, change=change):
                    self.setUp()
                    s, path, written = self.edited(rel, change)
                    snapshot = kfk.tree(self.home)
                    for action in ([], ["--undo"]):
                        s.kills.clear()
                        code, out, err = main(s, *action)
                        self.assertEqual(code, ks.EXIT_CHANGED, (rel, change, action, err))
                        self.assertIn("were changed after setup", err)
                        self.assertEqual(kfk.tree(self.home), snapshot)
                        self.assertEqual(s.kills, [])
                    code, _, _ = main(s, "--off")
                    self.assertEqual(code, ks.EXIT_CHANGED)
                    self.assertEqual(kfk.tree(self.home), snapshot)
                    with open(path, "wb") as handle:
                        handle.write(written)
                    os.chmod(path, self.written_mode)  # bytes and mode back as setup left them
                    self.assertEqual(main(s, "--undo")[0], 0)
                    self.assertEqual(kfk.tree(self.home), self.before)


def managed(tree):
    return {rel: tree.get(rel) for rel in MANAGED}


class TransactionTests(Base):
    """A failure right after any single file write (the record, a snapshot
    copy, a launcher run file or a managed file, or a managed file removed)
    leaves a state the same command finishes, and --undo restores the
    original exactly (bytes, modes, owner and group), for every operation.
    Each injected failure point is asserted to have been reached."""

    SCENARIOS = {
        "setup": ((), ()),
        "re-orientation": (((),), ("--orientation", "landscape")),
        "off": (((),), ("--off",)),
        "re-enable": (((), ("--off",)), ()),
        "undo": (((),), ("--undo",)),
    }

    def prepare(self, steps):
        s = self.pi()
        for args in steps:
            self.assertEqual(main(s, *args)[0], 0, args)
        return s

    def counting(self, fail_at):
        count = [0]

        def after(real):
            def wrapped(*args, **kwargs):
                result = real(*args, **kwargs)
                count[0] += 1
                if count[0] == fail_at:
                    raise OSError(5, "Input/output error")
                return result

            return wrapped

        patches = [
            mock.patch.object(kf, name, side_effect=after(getattr(kf, name)))
            for name in ("write_atomic", "remove_file", "write_state_file")
        ]
        return patches, count

    def run_with(self, s, args, fail_at=None):
        patches, count = self.counting(fail_at)
        for patch in patches:
            patch.start()
        try:
            code, out, err = main(s, *args)
        finally:
            for patch in patches:
                patch.stop()
        return code, err, count[0]

    def test_every_write_of_every_operation(self):
        for name, (steps, args) in self.SCENARIOS.items():
            # A clean run: how many writes, and what it leaves.
            self.setUp()
            s = self.prepare(steps)
            code, err, writes = self.run_with(s, args)
            self.assertEqual(code, 0, (name, err))
            self.assertGreaterEqual(writes, 3, name)
            finished = managed(kfk.tree(self.home))
            for fail_at in range(1, writes + 1):
                for recovery in ("same command", "undo"):
                    with self.subTest(operation=name, fail_after_write=fail_at, recovery=recovery):
                        self.setUp()
                        s = self.prepare(steps)
                        code, err, reached = self.run_with(s, args, fail_at)
                        self.assertEqual(reached, fail_at, "the failure point was reached")
                        self.assertEqual((code, err), (2, ks.CRASH_DURING + "\n"))
                        if recovery == "same command":
                            code, _, err = main(s, *args)
                            self.assertEqual(code, 0, err)
                            self.assertEqual(managed(kfk.tree(self.home)), finished)
                        code, _, err = main(s, "--undo")
                        self.assertEqual(code, 0, err)
                        self.assertEqual(kfk.tree(self.home), self.before)


class ModeDriftTests(Base):
    """Blocker 3: a permission change after setup counts as an edit."""

    def test_chmod_of_each_managed_file(self):
        for rel in MANAGED:
            with self.subTest(rel):
                self.setUp()
                s = self.pi()
                self.assertEqual(main(s)[0], 0)
                path = os.path.join(self.home, rel)
                os.chmod(path, 0o644 if rel == LAUNCHER else 0o600)  # the launcher loses its exec bit
                snapshot = kfk.tree(self.home)
                for args in ((), ("--off",), ("--undo",)):
                    code, _, err = main(s, *args)
                    self.assertEqual(code, ks.EXIT_CHANGED, (rel, args, err))
                    self.assertEqual(kfk.tree(self.home), snapshot)
                code, out, _ = main(s, "--check", "--json")
                self.assertEqual(json.loads(out)["files"], "changed")
                self.assertEqual(code, ks.EXIT_ATTENTION)

    def test_a_link_in_place_of_a_managed_file(self):
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        path = os.path.join(self.home, RC)
        os.rename(path, path + ".mine")
        os.symlink(path + ".mine", path)
        snapshot = kfk.tree(self.home)
        for args in ((), ("--off",), ("--undo",)):
            self.assertEqual(main(s, *args)[0], ks.EXIT_UNSUPPORTED, args)
            self.assertEqual(kfk.tree(self.home), snapshot)


class RaceTests(Base):
    """Blocker 4: an edit saved while the tool works is never overwritten,
    and a second run waits for nobody: it stops."""

    def editing_randr(self, s, rel, data):
        real = s.commands[("wlr-randr", "--json")]
        calls = []

        def randr(key, env):
            if not calls:
                kfk.write(self.home, rel, data, mode=os.stat(os.path.join(self.home, rel)).st_mode & 0o7777)
            calls.append(key)
            return real(key, env)

        s.set(["wlr-randr", "--json"], randr)
        return calls

    def test_edit_during_display_detection_first_setup(self):
        s = self.pi()
        calls = self.editing_randr(s, RC, USER_RC.replace("W-t", "W-x"))
        code, _, err = main(s)
        self.assertTrue(calls)
        self.assertEqual(code, ks.EXIT_CHANGED, err)
        edited = dict(self.before)
        edited[RC] = kfk.tree(self.home)[RC]
        self.assertIn(b"W-x", edited[RC][2])
        self.assertEqual(kfk.tree(self.home), edited)  # the edit kept; no state folder, lock or file left

    def test_edit_during_display_detection_on_a_second_run(self):
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        installed_rc = kfk.read(self.home, RC)
        calls = self.editing_randr(s, RC, installed_rc.replace(b"</openbox_config>", b"<core/></openbox_config>"))
        before = kfk.tree(self.home)
        code, _, err = main(s, "--orientation", "landscape")
        self.assertTrue(calls)
        self.assertEqual(code, ks.EXIT_CHANGED, err)
        after = kfk.tree(self.home)
        self.assertIn(b"<core/>", after[RC][2])
        for rel in (AUTOSTART, KANSHI, LAUNCHER):
            self.assertEqual(after[rel], before[rel])

    def save_by_user(self, rel, data, how):
        """The person's editor saves rel: in place (same inode) or by
        writing a new file and renaming it over (new inode)."""
        path = os.path.join(self.home, rel)
        if how == "in place":
            with open(path, "r+b") as handle:
                handle.truncate(0)
                handle.write(data)
        else:
            kfk.write(self.home, rel + ".editor-tmp", data, mode=os.stat(path).st_mode & 0o7777)
            os.rename(path + ".editor-tmp", path)

    def inject(self, when):
        """Wrap kf.renameat2 (the real call on Linux): when(src, dst, flags)
        runs first, at the exact point between write_atomic's or
        remove_file's last check and the swap. Returns the patch, the list
        of points reached and the list of every (src, dst, flags) call."""
        real = kf.renameat2
        reached, calls = [], []

        def renameat2(src_fd, src, dst_fd, dst, flags):
            calls.append((src, dst, flags))
            if when(src, dst, flags):
                reached.append((src, dst, flags))
            return real(src_fd, src, dst_fd, dst, flags)

        self.calls = calls
        return mock.patch.object(kf, "renameat2", side_effect=renameat2), reached

    def no_hidden_files(self):
        return [n for _, _, names in os.walk(self.home) for n in names if n.startswith(".") and "sproutwall" in n]

    def test_a_save_between_the_last_check_and_the_exchange(self):
        """The exchange moves the person's version aside; it is checked,
        swapped back and kept; ours is removed (exit 5)."""
        mine = b"<openbox_config><edited/></openbox_config>\n"
        for how in ("in place", "new file"):
            with self.subTest(how):
                self.setUp()
                s = self.pi()

                saved = []

                def when(src, dst, flags, how=how, saved=saved):
                    if not saved and flags == kf.RENAME_EXCHANGE and dst == "rc.xml" and src.endswith(kf.TMP_SUFFIX):
                        self.save_by_user(RC, mine, how)
                        saved.append(src)
                        return True
                    return False

                patch, reached = self.inject(when)
                with patch:
                    code, _, err = main(s)
                self.assertEqual(len(reached), 1, "the injection point was reached")
                swaps = [c for c in self.calls if c[2] == kf.RENAME_EXCHANGE and "rc.xml" in c[:2]]
                self.assertEqual(len(swaps), 2, "exchanged, then exchanged back")
                self.assertEqual(code, ks.EXIT_CHANGED, err)
                self.assertIn("changed while it was being updated", err)
                self.assertNotIn("Nothing was changed", err)
                self.assertEqual(kfk.read(self.home, RC), mine)
                self.assertEqual(self.no_hidden_files(), [])
                self.assertEqual(kfk.tree(self.home)[AUTOSTART], self.before[AUTOSTART])  # nothing more was written
                kfk.write(self.home, RC, USER_RC)  # put the change back: the same command finishes
                self.assertEqual(main(s)[0], 0)
                self.assertEqual(main(s, "--undo")[0], 0)
                self.assertEqual(kfk.tree(self.home), self.before)

    def test_a_save_between_the_last_check_and_a_removal(self):
        """--undo removes the launcher by moving it to a quarantine name
        first; the person's version found there is moved back (exit 5)."""
        mine = b"#!/bin/sh\n# my own launcher\n"
        for how in ("in place", "new file"):
            with self.subTest(how):
                self.setUp()
                s = self.pi()
                self.assertEqual(main(s)[0], 0)

                def when(src, dst, flags, how=how):
                    if flags == kf.RENAME_NOREPLACE and src == "sproutwall-kiosk" and dst.endswith(kf.QUARANTINE_SUFFIX):
                        self.save_by_user(LAUNCHER, mine, how)
                        return True
                    return False

                patch, reached = self.inject(when)
                with patch:
                    code, _, err = main(s, "--undo")
                self.assertEqual(len(reached), 1, "the injection point was reached")
                self.assertEqual(code, ks.EXIT_CHANGED, err)
                self.assertIn("changed while it was being updated", err)
                self.assertEqual(kfk.read(self.home, LAUNCHER), mine)
                self.assertEqual(self.no_hidden_files(), [])

    def test_a_save_during_the_rollback(self):
        """A first save rolls the swap back; a second save during the
        rollback (renamed over the file before the swap back, or written
        into the file after it) is kept as rc.xml.sproutwall-kept-1, never
        deleted (exit 5)."""
        mine, newest = b"<openbox_config><mine/></openbox_config>\n", b"<openbox_config><newest/></openbox_config>\n"
        for variant in ("renamed over before the swap back", "written into after the swap back"):
            with self.subTest(variant):
                self.setUp()
                s = self.pi()
                real = kf.renameat2
                swaps, reached = [], []

                def renameat2(src_fd, src, dst_fd, dst, flags, variant=variant):
                    is_swap = flags == kf.RENAME_EXCHANGE and "rc.xml" in (src, dst) and kf.TMP_SUFFIX in src + dst
                    if is_swap:
                        swaps.append(src)
                        if len(swaps) == 1:
                            self.save_by_user(RC, mine, "in place")
                            reached.append("first save")
                        elif len(swaps) == 2 and variant.startswith("renamed"):
                            self.save_by_user(RC, newest, "new file")
                            reached.append("save during rollback")
                    result = real(src_fd, src, dst_fd, dst, flags)
                    if is_swap and len(swaps) == 2 and variant.startswith("written"):
                        with open(os.path.join(self.home, os.path.dirname(RC), src), "r+b") as handle:
                            handle.truncate(0)
                            handle.write(newest)
                        reached.append("save during rollback")
                    return result

                with mock.patch.object(kf, "renameat2", side_effect=renameat2):
                    code, _, err = main(s)
                self.assertEqual(reached, ["first save", "save during rollback"])
                self.assertEqual(code, ks.EXIT_CHANGED, err)
                self.assertIn(".sproutwall-kept-", err)
                self.assertNotIn("rc.xml", err)
                self.assertEqual(kfk.read(self.home, RC), mine)
                self.assertEqual(kfk.read(self.home, RC + ".sproutwall-kept-1"), newest)
                self.assertEqual(self.no_hidden_files(), [])

    def test_a_name_taken_while_a_removal_is_undone(self):
        """If a new file takes the name before the person's version can be
        moved back, both are kept: theirs as <name>.sproutwall-kept-1 (exit 5)."""
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        mine, newer = b"#!/bin/sh\n# mine\n", b"#!/bin/sh\n# newer\n"

        def when(src, dst, flags):
            if flags != kf.RENAME_NOREPLACE:
                return False
            if src == "sproutwall-kiosk" and dst.endswith(kf.QUARANTINE_SUFFIX):
                self.save_by_user(LAUNCHER, mine, "in place")
                return True
            if src.endswith(kf.QUARANTINE_SUFFIX) and dst == "sproutwall-kiosk":
                kfk.write(self.home, LAUNCHER, newer, mode=0o755)
                return True
            return False

        patch, reached = self.inject(when)
        with patch:
            code, _, err = main(s, "--undo")
        self.assertEqual(len(reached), 2, "both injection points were reached")
        self.assertEqual(code, ks.EXIT_CHANGED, err)
        self.assertIn(".sproutwall-kept-", err)
        self.assertNotIn("sproutwall-kiosk", err)  # the name itself is never printed
        self.assertEqual(kfk.read(self.home, LAUNCHER), newer)
        self.assertEqual(self.no_hidden_files(), [])
        self.assertEqual(kfk.read(self.home, LAUNCHER + ".sproutwall-kept-1"), mine)

    def hold_lock(self):
        import fcntl

        path = os.path.join(self.home, kiosk.KIOSK_STATE_DIR, "setup.lock")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_a_second_concurrent_run_stops(self):
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        self.hold_lock()
        snapshot = kfk.tree(self.home)
        for args in ((), ("--off",), ("--undo",), ("--orientation", "landscape")):
            code, out, err = main(s, *args)
            self.assertEqual(code, ks.EXIT_NOT_READY, args)
            self.assertIn("another setup kiosk run is in progress", err)
            self.assertEqual(kfk.tree(self.home), snapshot)

    def test_a_second_run_during_a_first_setup(self):
        self.hold_lock()  # a first setup holds the lock and has not written its record yet
        snapshot = kfk.tree(self.home)
        code, _, err = main(self.pi())
        self.assertEqual(code, ks.EXIT_NOT_READY, err)
        self.assertEqual(kfk.tree(self.home), snapshot)


class OwnershipTests(Base):
    """Never take over or delete a state folder or launcher this tool has
    no record of; undo removes only what setup created."""

    def test_state_folder_without_a_record(self):
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "original", "rc_xml"), b"someone's snapshot")
        self.before = kfk.tree(self.home)
        for args in ((), ("--off",), ("--undo",)):
            code, _, err = main(self.pi(), *args)
            self.assertEqual(code, ks.EXIT_CHANGED, args)
            self.assertIn("without the record this tool writes", err)
            self.assert_unchanged()

    def test_launcher_without_a_record(self):
        kfk.write(self.home, LAUNCHER, "#!/bin/sh\n", mode=0o755)
        self.before = kfk.tree(self.home)
        code, _, err = main(self.pi())
        self.assertEqual(code, ks.EXIT_CHANGED)
        self.assert_unchanged()

    def test_a_folder_without_a_record_is_never_taken_over(self):
        """Even an empty state folder, or one holding only setup.lock, is not
        this tool's: refused (exit 5) and left as it is."""
        cases = {
            "empty": lambda: os.makedirs(os.path.join(self.home, kiosk.KIOSK_STATE_DIR)),
            "only setup.lock": lambda: kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "setup.lock"), b"", mode=0o600),
        }
        for name, make in cases.items():
            for args in ((), ("--off",), ("--undo",)):
                with self.subTest(name, args=args):
                    self.setUp()
                    make()
                    self.before = kfk.tree(self.home)
                    code, out, err = main(self.pi(), *args)
                    self.assertEqual(code, ks.EXIT_CHANGED, err)
                    self.assertIn("without the record this tool writes", err)
                    self.assert_unchanged()

    def test_a_record_without_its_lock_is_never_given_a_new_one(self):
        """setup.lock removed by hand: nothing is created before the checks;
        every command stops as a damaged state (exit 5), truthfully saying
        nothing was changed."""
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        os.unlink(os.path.join(self.home, kiosk.KIOSK_STATE_DIR, "setup.lock"))
        snapshot = kfk.tree(self.home)
        for args in ((), ("--off",), ("--undo",), ("--orientation", "landscape")):
            code, _, err = main(s, *args)
            self.assertEqual(code, ks.EXIT_CHANGED, (args, err))
            self.assertIn("damaged", err)
            self.assertIn("Nothing was changed.", err)
            self.assertEqual(kfk.tree(self.home), snapshot)

    def test_only_folders_setup_made_are_recorded(self):
        os.makedirs(os.path.join(self.home, ".local", "state"))  # the person's own
        self.before = kfk.tree(self.home)
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        with open(os.path.join(self.home, kiosk.KIOSK_STATE_DIR, "manifest.json"), encoding="utf-8") as handle:
            dirs = json.load(handle)["created_dirs"]
        self.assertNotIn(os.path.join(".local", "state"), dirs)
        self.assertIn(os.path.join(".local", "state", "sproutwall"), dirs)
        self.assertIn(kiosk.KIOSK_STATE_DIR, dirs)
        self.assertEqual(main(s, "--undo")[0], 0)
        self.assertEqual(kfk.tree(self.home), self.before)

    def test_the_record_is_written_right_after_the_folder(self):
        """The first write after mkdir is the record (phase "init"), through
        the folder fd; nothing else is written before it."""
        real_save = kf.State.save
        phases = []

        def save(state, manifest):
            phases.append((manifest["phase"], sorted(os.listdir(state.dir))))
            return real_save(state, manifest)

        with mock.patch.object(kf.State, "save", autospec=True, side_effect=save):
            self.assertEqual(main(self.pi())[0], 0)
        self.assertEqual(phases[0], ("init", ["setup.lock"]))
        self.assertEqual([phase for phase, _ in phases], ["init", "writing", "done"])

    def test_undo_keeps_files_it_did_not_create(self):
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "my-notes.txt"), b"mine")
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "browser", "Default", "Cookies"), b"unlock", mode=0o600)
        code, out, err = main(s, "--undo")
        self.assertEqual(code, 0, err)
        self.assertIn("state folder was kept", out)
        left = {rel for rel in kfk.tree(self.home) if rel.startswith(kiosk.KIOSK_STATE_DIR)}
        self.assertEqual(left, {kiosk.KIOSK_STATE_DIR, os.path.join(kiosk.KIOSK_STATE_DIR, "my-notes.txt")})
        for rel in MANAGED:
            self.assertEqual(kfk.tree(self.home).get(rel), self.before.get(rel))
        code, _, _ = main(s)  # the kept folder is not this tool's any more
        self.assertEqual(code, ks.EXIT_CHANGED)


class MetadataTests(Base):
    """Files this tool could not put back exactly (extra hard links, another
    owner or group, extended attributes) are refused before any write
    (exit 6, unsupported_metadata)."""

    def faking(self, rel, **fields):
        """observe_at reports fields (uid, gid, xattrs) for rel's file."""
        real = kf.observe_at
        name = os.path.basename(rel)
        hits = []

        def observe_at(dir_fd, entry):
            seen = real(dir_fd, entry)
            if entry == name and seen.exists:
                hits.append(entry)
                for key, value in fields.items():
                    setattr(seen, key, value)
            return seen

        return mock.patch.object(kf, "observe_at", side_effect=observe_at), hits

    def refused(self, system, *args):
        code, out, err = main(system, *args)
        self.assertEqual(code, ks.EXIT_CANNOT_TELL, err)
        self.assertIn("could not put such a file back exactly", err)
        self.assertIn("Nothing was changed.", err)
        self.assertEqual(out, "")

    def test_unsupported_originals(self):
        cases = {
            "hard link": None,
            "another owner": {"uid": os.getuid() + 1},
            "another group": {"gid": os.getgid() + 1},
            "extended attribute": {"xattrs": ("system.posix_acl_access",)},
        }
        for case, fields in cases.items():
            for rel in (AUTOSTART, RC, KANSHI):
                with self.subTest(case, rel=rel):
                    self.setUp()
                    if fields is None:
                        os.link(os.path.join(self.home, rel), os.path.join(self.home, "elsewhere"))
                        self.before = kfk.tree(self.home)
                        self.refused(self.pi())
                    else:
                        patch, hits = self.faking(rel, **fields)
                        with patch:
                            self.refused(self.pi())
                        self.assertTrue(hits)
                    self.assert_unchanged()

    def test_after_setup(self):
        """A hard link made after setup stops --off and --undo too."""
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        os.link(os.path.join(self.home, RC), os.path.join(self.home, "elsewhere"))
        snapshot = kfk.tree(self.home)
        for args in ((), ("--off",), ("--undo",)):
            self.refused(s, *args)
            self.assertEqual(kfk.tree(self.home), snapshot)

    def acl_for(self, inodes):
        """_xattrs reports a default ACL for these inodes (files or folders)."""
        previous = kf._xattrs

        def xattrs(fd):
            if os.fstat(fd).st_ino in inodes:
                return ("system.posix_acl_default",)
            return previous(fd)

        return mock.patch.object(kf, "_xattrs", side_effect=xattrs)

    def test_a_folder_with_a_default_acl(self):
        """New files would inherit it, and --undo could not accept them:
        refused before any write, for setup and for --undo."""
        folder = os.stat(os.path.join(self.home, os.path.dirname(RC))).st_ino
        with self.acl_for({folder}):
            self.refused(self.pi())
        self.assert_unchanged()
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        snapshot = kfk.tree(self.home)
        with self.acl_for({folder}):
            self.refused(s, "--undo")
        self.assertEqual(kfk.tree(self.home), snapshot)

    def test_a_generated_file_with_an_acl_is_rolled_back(self):
        """A file setup writes must pass the check --undo applies; one that
        comes out with an ACL is removed again (it is ours), the run stops
        with exit 6, and --undo then restores everything."""
        inodes = set()
        real_temp = kf._write_temp

        def write_temp(dir_fd, name, data, mode, suffix=kf.TMP_SUFFIX):
            tmp = real_temp(dir_fd, name, data, mode, suffix)
            if name == "rc.xml":
                inodes.add(os.stat(tmp, dir_fd=dir_fd, follow_symlinks=False).st_ino)
            return tmp

        s = self.pi()
        with self.acl_for(inodes), mock.patch.object(kf, "_write_temp", side_effect=write_temp):
            code, out, err = main(s)
        self.assertEqual(len(inodes), 1, "the generated rc.xml was reached")
        self.assertEqual(code, ks.EXIT_CANNOT_TELL, err)
        self.assertIn("could not put such a file back exactly", err)
        self.assertIn("It had already started writing", err)
        self.assertNotIn("Nothing was changed", err)
        self.assertEqual(kfk.tree(self.home)[RC], self.before[RC])
        stray = [n for _, _, names in os.walk(self.home) for n in names if "sproutwall-" in n and n != "sproutwall-kiosk"]
        self.assertEqual(stray, [])
        self.assertEqual(main(s, "--undo")[0], 0)
        self.assertEqual(kfk.tree(self.home), self.before)

    @unittest.skipUnless(hasattr(os, "setxattr"), kfk.LINUX_ONLY)
    def test_a_real_extended_attribute(self):
        path = os.path.join(self.home, RC)
        try:
            os.setxattr(path, "user.sproutwall-test", b"1")
        except OSError as error:
            self.skipTest("this file system has no user extended attributes (%s)" % error.strerror)
        self.before = kfk.tree(self.home)
        self.refused(self.pi())
        self.assert_unchanged()

    def test_exact_restore_keeps_owner_and_group(self):
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        with open(os.path.join(self.home, kiosk.KIOSK_STATE_DIR, "manifest.json"), encoding="utf-8") as handle:
            files = json.load(handle)["files"]
        for key, entry in files.items():
            if entry["original"]["exists"]:
                self.assertEqual((entry["original"]["uid"], entry["original"]["gid"]), (os.getuid(), os.getgid()), key)
        self.assertEqual(main(s, "--undo")[0], 0)
        self.assertEqual(kfk.tree(self.home), self.before)  # uid and gid are part of the tree


class RenameSupportTests(Base):
    def test_no_atomic_exchange_refuses_before_any_write(self):
        for code in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
            for args in ((), ("--undo",)):
                with self.subTest(errno.errorcode[code], args=args):
                    self.setUp()
                    s = self.pi()
                    if args:
                        self.assertEqual(main(s)[0], 0)
                        self.before = kfk.tree(self.home)
                    def unsupported(*_args, code=code):
                        ctypes.set_errno(code)
                        return -1

                    with mock.patch.object(kf, "_renameat2_function", return_value=unsupported) as lookup, mock.patch.object(kf, "renameat2", side_effect=REAL_RENAMEAT2):
                        exit_code, out, err = main(s, *args)
                    self.assertTrue(lookup.called)
                    self.assertEqual(exit_code, ks.EXIT_CANNOT_TELL, err)
                    self.assertIn("atomic swap", err)
                    self.assertIn("Nothing was changed.", err)
                    self.assert_unchanged()


class StateLinkTests(Base):
    """Everything in the state folder is reached through folder fds with
    O_NOFOLLOW: a link anywhere stops the run before any write (exit 5)."""

    def setup_done(self):
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        return s

    def state(self, *parts):
        return os.path.join(self.home, kiosk.KIOSK_STATE_DIR, *parts)

    def refused_everywhere(self, s, actions=((), ("--off",), ("--undo",))):
        snapshot = kfk.tree(self.home)
        for args in actions:
            code, out, err = main(s, *args)
            self.assertEqual(code, ks.EXIT_CHANGED, (args, err))
            self.assertIn("is a link or not the kind of file this tool made", err)
            self.assertEqual(kfk.tree(self.home), snapshot)

    def test_original_folder_replaced_by_a_link(self):
        s = self.setup_done()
        os.rename(self.state("original"), os.path.join(self.home, "elsewhere"))
        os.symlink(os.path.join(self.home, "elsewhere"), self.state("original"))
        self.refused_everywhere(s)

    def test_state_folder_replaced_by_a_link(self):
        s = self.setup_done()
        os.rename(self.state(), os.path.join(self.home, "elsewhere"))
        os.symlink(os.path.join(self.home, "elsewhere"), self.state())
        snapshot = kfk.tree(self.home)
        for args in ((), ("--off",), ("--undo",)):
            code, _, err = main(s, *args)
            self.assertEqual(code, ks.EXIT_CHANGED, (args, err))
            self.assertEqual(kfk.tree(self.home), snapshot)

    def test_a_link_inside_run(self):
        s = self.setup_done()
        os.unlink(self.state("run", "launcher.lock"))
        os.symlink(os.path.join(self.home, ".config", "labwc", "rc.xml"), self.state("run", "launcher.lock"))
        self.refused_everywhere(s)

    def test_a_replaced_waiting_page(self):
        """A run file changed after setup is kept by --undo and reported;
        everything else is restored."""
        s = self.setup_done()
        os.unlink(self.state("run", "starting.html"))
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "run", "starting.html"), b"<p>mine</p>", mode=0o600)
        code, _, err = main(s)
        self.assertEqual(code, ks.EXIT_CHANGED, err)  # setup: a damaged snapshot
        code, out, err = main(s, "--undo")
        self.assertEqual(code, 0, err)
        self.assertIn("state folder was kept", out)
        left = sorted(rel for rel in kfk.tree(self.home) if rel.startswith(kiosk.KIOSK_STATE_DIR))
        run = os.path.join(kiosk.KIOSK_STATE_DIR, "run")
        self.assertEqual(left, [kiosk.KIOSK_STATE_DIR, run, os.path.join(run, "starting.html")])
        self.assertEqual(kfk.read(self.home, os.path.join(run, "starting.html")), b"<p>mine</p>")
        for rel in MANAGED:
            self.assertEqual(kfk.tree(self.home).get(rel), self.before.get(rel))

    def test_setup_writes_the_launcher_run_files(self):
        self.setup_done()
        with open(self.state("manifest.json"), encoding="utf-8") as handle:
            created = json.load(handle)["created_files"]
        for name in ("launcher.lock", "starting.html"):
            rel = os.path.join(kiosk.KIOSK_STATE_DIR, "run", name)
            st = os.lstat(os.path.join(self.home, rel))
            self.assertEqual((created[rel]["dev"], created[rel]["ino"], created[rel]["mode"]), (st.st_dev, st.st_ino, 0o600))
        self.assertEqual(kfk.read(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "run", "starting.html")), kf.wait_page_bytes())


class ReloadTests(Base):
    def test_a_reload_that_fails_is_not_success(self):
        for result in ("denied", "gone"):
            for pid in (kfk.LABWC_PID, kfk.KANSHI_PID):
                with self.subTest(result, pid=pid):
                    self.setUp()
                    s = self.pi()
                    s.kill_results[(pid, signal.SIGHUP)] = result
                    code, out, err = main(s)
                    self.assertEqual(code, ks.EXIT_ATTENTION, out)
                    self.assertIn("could not be told to reload", err)
                    self.assertNotIn("applied now", err)
                    s.kill_results.clear()
                    s.kill_results[(pid, signal.SIGHUP)] = result
                    code, out, err = main(s, "--undo")
                    self.assertEqual(code, ks.EXIT_ATTENTION, out)
                    self.assertIn("could not be told to reload", err)
                    self.assertNotIn("were reloaded", err)


REAL_RENAMEAT2 = kf.renameat2

if __name__ == "__main__":
    unittest.main()
