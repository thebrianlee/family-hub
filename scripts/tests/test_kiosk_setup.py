"""setup kiosk end to end on a fake Raspberry Pi OS desktop with a real,
temporary home folder: refusals that change nothing (each proven to reach
the step it is about), the files written, --check, --off and re-enable,
--undo back to the original bytes, edits made after setup to each managed
file, unreadable sources, and doctor's kiosk check on the result."""

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
            target = os.path.join(self.home, rel)

            def failing(path, target=target):
                if path == target:
                    raise PermissionError(13, "denied")
                return real_observe(path)

            with self.subTest(rel), mock.patch.object(kf, "observe", side_effect=failing) as observer:
                self.cannot_tell(self.pi())
                self.assertIn(mock.call(target), observer.call_args_list)
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
        self.assertEqual(code, ks.EXIT_ATTENTION)  # not installed
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
        s.kill = lambda pid, sig: s.kills.append((pid, sig)) or True  # kanshi does not react
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
        self.assertEqual((code, data["installed"], data["result"]), (1, "damaged", "attention"))

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
        self.assertEqual(main(s, "--off")[0], 0)
        self.assertEqual(s.kills, [(1201, signal.SIGTERM), (1201, signal.SIGKILL)])

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
        real = kf.write_atomic
        calls = []

        def write(path, data, mode):
            calls.append(path)
            if len([c for c in calls if not c.endswith("manifest.json") and "/original/" not in c]) == 2:
                raise OSError(28, "No space left on device")
            return real(path, data, mode)

        return mock.patch.object(kf, "write_atomic", side_effect=write), calls

    def test_setup_then_finish(self):
        s = self.pi()
        patch, calls = self.fail_on_second_write()
        with patch:
            code, _, err = main(s)
        self.assertEqual((code, err), (2, ks.CRASH_DURING + "\n"))
        self.assertGreaterEqual(len(calls), 2)
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
    """Blocker 2: a failure right after any single file write (manifest,
    snapshot copy or managed file) leaves a state the same command finishes,
    and --undo restores the original exactly, for every operation."""

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
        real_write, real_remove = kf.write_atomic, kf.remove_file
        count = [0]

        def after(real):
            def wrapped(*args, **kwargs):
                result = real(*args, **kwargs)
                count[0] += 1
                if count[0] == fail_at:
                    raise OSError(5, "Input/output error")
                return result

            return wrapped

        patches = [mock.patch.object(kf, "write_atomic", side_effect=after(real_write)), mock.patch.object(kf, "remove_file", side_effect=after(real_remove))]
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
                        code, err, _ = self.run_with(s, args, fail_at)
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

    def test_edit_between_the_last_check_and_the_write(self):
        s = self.pi()
        real = kf.write_atomic
        target = os.path.join(self.home, RC)
        edits = []

        def write(path, data, mode, expect=None):
            if path == target and not edits:
                edits.append(path)
                kfk.write(self.home, RC, b"<openbox_config><edited/></openbox_config>\n")
            return real(path, data, mode, expect=expect)

        with mock.patch.object(kf, "write_atomic", side_effect=write):
            code, _, err = main(s)
        self.assertEqual(edits, [target])
        self.assertEqual(code, ks.EXIT_CHANGED)
        self.assertIn("changed while it was being updated", err)
        self.assertNotIn("Nothing was changed", err)
        self.assertEqual(kfk.read(self.home, RC), b"<openbox_config><edited/></openbox_config>\n")
        self.assertEqual(kfk.tree(self.home)[AUTOSTART], self.before[AUTOSTART])  # nothing more was written
        kfk.write(self.home, RC, USER_RC)  # put the change back: the same command finishes
        self.assertEqual(main(s)[0], 0)

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
    """Blocker 5: never take over or delete a state folder or launcher this
    tool has no record of; undo removes only what setup created."""

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

    def test_a_leftover_lock_from_an_interrupted_run_is_taken_over(self):
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "setup.lock"), b"", mode=0o600)
        before = kfk.tree(self.home)
        s = self.pi()
        self.assertEqual(main(s)[0], 0)
        self.assertEqual(main(s, "--undo")[0], 0)
        # The leftover folder and lock count as this tool's and go; their parents stay.
        expected = {rel: v for rel, v in before.items() if not rel.startswith(kiosk.KIOSK_STATE_DIR)}
        self.assertEqual(kfk.tree(self.home), expected)

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


if __name__ == "__main__":
    unittest.main()
