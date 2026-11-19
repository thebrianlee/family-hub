"""setup kiosk file transforms: labwc autostart, labwc rc.xml and the kanshi
config. Unrelated content must survive byte for byte, and a second run must
give the same bytes as the first."""

import os
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest import mock

from sproutwall_lib import kiosk, kiosk_files as kf

from . import kiosk_fakes as kfk

SWAYIDLE = "swayidle -w timeout 600 'wlopm --off \\*' resume 'wlopm --on \\*' &\n"
USER_AUTOSTART = (
    "# my own additions\n"
    "/usr/bin/lwrespawn /usr/bin/wf-panel-pi &\n" + SWAYIDLE + "squeekboard &\n"
)
USER_RC = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    "<!-- my keyboard tweaks -->\n"
    '<openbox_config xmlns="http://openbox.org/3.4/rc">\n'
    "\t<keyboard>\n"
    '\t\t<keybind key="W-t"><action name="Execute" command="lxterminal"/></keybind>\n'
    "\t</keyboard>\n"
    '\t<touch deviceName="ILITEK ILITEK-TP" mapToOutput="HDMI-A-2" mouseEmulation="yes"/>\n'
    "</openbox_config>\n"
)
KANSHI = "profile docked {\n\toutput HDMI-A-1 enable mode 1920x1080@60.000 position 0,0 transform normal\n\toutput HDMI-A-2 enable position 1920,0\n}\n\nprofile {\n\toutput HDMI-A-1 enable scale 1.000000 mode 1920x1080@60.000 position 0,0 transform normal\n}\n"


class AutostartTests(unittest.TestCase):
    def test_new_file_has_one_line(self):
        data = kf.autostart_text(None, True)
        self.assertEqual(data.decode(), kiosk.LAUNCH_LINE + "\n")
        self.assertEqual(kiosk.active_marker_lines(data.decode()), 1)

    def test_keeps_other_lines_and_drops_blanking(self):
        data = kf.autostart_text(USER_AUTOSTART.encode(), True).decode()
        self.assertEqual(data, USER_AUTOSTART.replace(SWAYIDLE, "") + kiosk.LAUNCH_LINE + "\n")
        self.assertNotIn("swayidle", data)

    def test_idempotent_and_exactly_once(self):
        once = kf.autostart_text(USER_AUTOSTART.encode(), True)
        twice = kf.autostart_text(once, True)
        self.assertEqual(once, twice)
        self.assertEqual(kiosk.active_marker_lines(twice.decode()), 1)
        # An earlier marker line in the original (any form) is replaced, not kept.
        stale = (USER_AUTOSTART + kiosk.LAUNCH_LINE + "\n" + kiosk.LAUNCH_LINE_OFF + "\n").encode()
        self.assertEqual(kf.autostart_text(stale, True), once)

    def test_off_form(self):
        data = kf.autostart_text(USER_AUTOSTART.encode(), False).decode()
        self.assertEqual(kiosk.active_marker_lines(data), 0)
        self.assertEqual(kiosk.inactive_marker_lines(data), 1)
        self.assertEqual(kf.autostart_text(data.encode(), True), kf.autostart_text(USER_AUTOSTART.encode(), True))

    def test_missing_final_newline_and_odd_bytes(self):
        base = b"squeekboard &\n/usr/bin/caf\xe9-tool &"
        data = kf.autostart_text(base, True)
        self.assertTrue(data.startswith(base + b"\n"))
        self.assertTrue(data.endswith((kiosk.LAUNCH_LINE + "\n").encode()))

    def test_line_uses_home_not_a_user_name(self):
        self.assertTrue(kiosk.LAUNCH_LINE.startswith('"$HOME/.local/bin/sproutwall-kiosk" &'))
        self.assertTrue(kiosk.LAUNCH_LINE.endswith(kiosk.KIOSK_MARKER))


class RcXmlTests(unittest.TestCase):
    def test_new_file(self):
        data = kf.rc_xml_text(None, "ILITEK ILITEK-TP", "HDMI-A-1")
        root = ET.fromstring(data)
        self.assertEqual(root.tag, "{http://openbox.org/3.4/rc}openbox_config")
        touches = [e.attrib for e in root]
        self.assertEqual(touches, [{"deviceName": "ILITEK ILITEK-TP", "mapToOutput": "HDMI-A-1"}])

    def test_preserves_every_original_byte(self):
        data = kf.rc_xml_text(USER_RC.encode(), "ILITEK ILITEK-TP", "HDMI-A-1").decode()
        block = "  " + kf.TOUCH_MARK + '\n  <touch deviceName="ILITEK ILITEK-TP" mapToOutput="HDMI-A-1" />\n'
        self.assertEqual(data.replace(block, ""), USER_RC)
        self.assertTrue(data.endswith(block + "</openbox_config>\n"))

    def test_last_entry_wins_over_the_users_older_one_and_the_system(self):
        data = kf.rc_xml_text(USER_RC.encode(), "ILITEK ILITEK-TP", "HDMI-A-1")
        self.assertEqual(kf.effective_touch_output([kfk.SYSTEM_RC.encode(), data], "ilitek ilitek-tp"), "HDMI-A-1")
        self.assertEqual(kf.effective_touch_output([kfk.SYSTEM_RC.encode(), USER_RC.encode()], "ILITEK ILITEK-TP"), "HDMI-A-2")
        dsi = "10-0038 generic ft5x06 (79)"
        self.assertEqual(kf.effective_touch_output([kfk.SYSTEM_RC.encode(), None], dsi), "DSI-1")
        merged = kf.rc_xml_text(None, dsi, "DSI-2")
        self.assertEqual(kf.effective_touch_output([kfk.SYSTEM_RC.encode(), merged], dsi), "DSI-2")

    def test_idempotent(self):
        once = kf.rc_xml_text(USER_RC.encode(), "ILITEK ILITEK-TP", "HDMI-A-1")
        self.assertEqual(kf.rc_xml_text(once, "ILITEK ILITEK-TP", "HDMI-A-1"), once)
        other = kf.rc_xml_text(once, "ILITEK ILITEK-TP", "DSI-1")
        self.assertEqual(other.count(kf.TOUCH_MARK.encode()), 1)
        self.assertEqual(kf.rc_xml_text(other, "ILITEK ILITEK-TP", "HDMI-A-1"), once)

    def test_end_tag_layouts(self):
        flat = b'<openbox_config xmlns="http://openbox.org/3.4/rc"><theme><name>X</name></theme></openbox_config>'
        data = kf.rc_xml_text(flat, "T", "HDMI-A-1")
        self.assertTrue(data.startswith(b'<openbox_config xmlns="http://openbox.org/3.4/rc"><theme><name>X</name></theme>\n'))
        ET.fromstring(data)
        indented = b"<labwc_config>\n  <core/>\n  </labwc_config>\n"
        data = kf.rc_xml_text(indented, "T", "DSI-1")
        self.assertTrue(data.endswith(b"  </labwc_config>\n"))
        self.assertEqual(kf.effective_touch_output([data], "T"), "DSI-1")

    def test_escapes_the_device_name(self):
        name = 'Sample & "Touch" <Panel>'
        data = kf.rc_xml_text(USER_RC.encode(), name, "HDMI-A-1")
        self.assertIn(b'deviceName="Sample &amp; &quot;Touch&quot; &lt;Panel&gt;"', data)
        self.assertEqual(kf.effective_touch_output([data], name), "HDMI-A-1")

    def test_refuses_what_it_cannot_merge(self):
        for bad in (
            b"<openbox_config><unclosed></openbox_config>",
            b'<openbox_config xmlns="http://openbox.org/3.4/rc"/>',
            b"<something_else/>",
            b"",
            b"<openbox_config>\xff</openbox_config>",
        ):
            with self.assertRaises(kf.RcXmlError, msg=bad):
                kf.rc_xml_text(bad, "T", "HDMI-A-1")


class KanshiTests(unittest.TestCase):
    def test_each_orientation_transform(self):
        for transform in ("90", "270", "normal", "180"):
            data = kf.kanshi_text(None, "HDMI-A-1", transform).decode()
            self.assertIn("profile sproutwall-kiosk {\n\toutput HDMI-A-1 enable transform %s\n}\n" % transform, data)

    def test_first_and_other_profiles_untouched(self):
        data = kf.kanshi_text(KANSHI.encode(), "DSI-1", "90").decode()
        self.assertTrue(data.startswith(kf.KANSHI_BEGIN + "\nprofile sproutwall-kiosk {"))
        self.assertTrue(data.endswith("\n\n" + KANSHI))

    def test_idempotent(self):
        once = kf.kanshi_text(KANSHI.encode(), "HDMI-A-1", "90")
        self.assertEqual(kf.kanshi_text(once, "HDMI-A-1", "90"), once)
        self.assertEqual(kf.kanshi_text(kf.kanshi_text(once, "HDMI-A-1", "270"), "HDMI-A-1", "90"), once)
        self.assertEqual(kf.kanshi_text(b"", "HDMI-A-1", "90"), kf.kanshi_text(None, "HDMI-A-1", "90"))


class DiskTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name

    def path(self, name):
        return os.path.join(self.dir, name)

    def test_write_atomic_verifies_and_leaves_no_temp(self):
        path = self.path("rc.xml")
        kf.write_atomic(path, b"one", 0o640)
        kf.write_atomic(path, b"two", 0o640, expect=kf.observe(path))
        seen = kf.observe(path)
        self.assertEqual((seen.data, seen.mode), (b"two", 0o640))
        self.assertEqual(os.listdir(self.dir), ["rc.xml"])

    def test_write_atomic_keeps_the_old_file_when_the_write_fails(self):
        path = self.path("autostart")
        kf.write_atomic(path, b"old\n", 0o644)
        with mock.patch.object(kf.os, "replace", side_effect=OSError(28, "No space left")) as replace:
            with self.assertRaises(OSError):
                kf.write_atomic(path, b"new\n", 0o644)
        self.assertTrue(replace.called)
        self.assertEqual(kf.read_file(path), b"old\n")
        self.assertEqual(os.listdir(self.dir), ["autostart"])  # the temporary file is gone

    def test_write_atomic_reads_back(self):
        path = self.path("config")
        real = kf.observe
        calls = []

        def observe(p):
            calls.append(p)
            seen = real(p)
            return kf.Seen(True, b"other", seen.mode, seen.dev, seen.ino) if p == path and seen.exists else seen

        with mock.patch.object(kf, "observe", side_effect=observe):
            with self.assertRaises(kf.WriteCheckFailed):
                kf.write_atomic(path, b"wanted", 0o644)
        self.assertIn(path, calls)

    def test_a_change_after_the_check_stops_the_write(self):
        path = self.path("rc.xml")
        kf.write_atomic(path, b"checked", 0o644)
        checked = kf.observe(path)
        for change in ("bytes", "mode", "replaced", "removed"):
            with self.subTest(change):
                kf.write_atomic(path, b"checked", 0o644)
                checked = kf.observe(path)
                if change == "bytes":
                    with open(path, "wb") as handle:
                        handle.write(b"edited by Control Centre")
                elif change == "mode":
                    os.chmod(path, 0o600)
                elif change == "replaced":  # same bytes and mode, new inode (an editor's save)
                    kf.write_atomic(path, b"checked", 0o644)
                else:
                    os.unlink(path)
                before = kf.observe(path)
                with self.assertRaises(kf.ChangedMeanwhile):
                    kf.write_atomic(path, b"ours", 0o644, expect=checked)
                self.assertTrue(kf.observe(path).same_file(before))  # left as it was
                self.assertEqual(sorted(os.listdir(self.dir)), [] if change == "removed" else ["rc.xml"])
        kf.write_atomic(path, b"checked", 0o644)
        with self.assertRaises(kf.ChangedMeanwhile):
            kf.remove_file(path, expect=checked)
        self.assertTrue(kf.observe(path).exists)

    def test_observe_tells_errors_and_types_from_absence(self):
        self.assertFalse(kf.observe(self.path("absent")).exists)
        self.assertFalse(kf.observe(os.path.join(self.dir, "no", "such", "folder")).exists)
        plain = self.path("plain")
        kf.write_atomic(plain, b"x", 0o640)
        seen = kf.observe(plain)
        self.assertEqual((seen.exists, seen.data, seen.mode, seen.sha256), (True, b"x", 0o640, kf.sha256(b"x")))
        with self.assertRaises(NotADirectoryError):
            kf.observe(os.path.join(plain, "below"))  # a path part that is a file
        os.symlink(plain, self.path("link"))
        with self.assertRaises(kf.ManagedFileError):
            kf.observe(self.path("link"))
        os.mkdir(self.path("folder"))
        with self.assertRaises(kf.ManagedFileError):
            kf.observe(self.path("folder"))
        os.mkfifo(self.path("fifo"))
        with self.assertRaises(kf.ManagedFileError):
            kf.observe(self.path("fifo"))  # never blocks, never read

    def test_assert_no_links(self):
        os.makedirs(os.path.join(self.dir, "real", ".config"))
        kf.assert_no_links(self.dir, [os.path.join("real", ".config", "labwc", "rc.xml")])
        os.symlink(os.path.join(self.dir, "real"), self.path("linked"))
        with self.assertRaises(kf.ManagedFileError):
            kf.assert_no_links(self.dir, [os.path.join("linked", ".config", "labwc", "rc.xml")])
        kf.write_atomic(self.path("file"), b"x", 0o644)
        with self.assertRaises(kf.ManagedFileError):
            kf.assert_no_links(self.dir, [os.path.join("file", "labwc", "rc.xml")])

    def test_remove_profile_tree_removes_links_without_following(self):
        outside = self.path("outside")
        os.mkdir(outside)
        kf.write_atomic(os.path.join(outside, "keep"), b"keep", 0o644)
        profile = self.path("browser")
        os.makedirs(os.path.join(profile, "Default", "Cache"))
        kf.write_atomic(os.path.join(profile, "Default", "Cookies"), b"unlock", 0o600)
        os.symlink("host-1234", os.path.join(profile, "SingletonLock"))
        os.symlink(outside, os.path.join(profile, "Default", "escape"))
        kf.remove_profile_tree(profile)
        self.assertEqual(os.listdir(profile), [])
        self.assertEqual(os.listdir(outside), ["keep"])


FS = {"exists": True, "sha256": "a" * 64, "mode": 0o644}


def state(sha="a", mode=0o644):
    return {"exists": True, "sha256": sha * 64, "mode": mode}


def manifest(phase="done", **changes):
    absent = {"exists": False, "sha256": None, "mode": None}
    files = {}
    for key in kf.MANAGED:
        original = absent if key == "launcher" else state("a")
        if phase == "done":
            files[key] = {"original": original, "installed": state("b"), "previous": None, "target": None}
        else:
            files[key] = {"original": original, "installed": None, "previous": state("b"), "target": state("c")}
    data = {
        "schema": 1,
        "phase": phase,
        "operation": "setup",
        "enabled": True,
        "orientation": "portrait",
        "connector": "HDMI-A-1",
        "transform": "90",
        "touch_device": "ILITEK ILITEK-TP",
        "autologin_before": "off",
        "created_dirs": [".local/state/sproutwall/kiosk", ".local/state/sproutwall/kiosk/browser"],
        "created_files": [".local/state/sproutwall/kiosk/setup.lock", ".local/state/sproutwall/kiosk/original/rc_xml"],
        "files": files,
    }
    data.update(changes)
    return data


class ManifestTests(unittest.TestCase):
    def test_valid(self):
        kf.validate_manifest(manifest())
        kf.validate_manifest(manifest("writing"))

    def test_strict_file_states(self):
        for change in (
            {"sha256": "A" * 64},
            {"sha256": "a" * 63},
            {"sha256": "a" * 64 + "\n"},
            {"sha256": " " + "a" * 63},
            {"sha256": "١" * 64},
            {"sha256": None},
            {"mode": "644"},
            {"mode": 0o10000},
            {"mode": True},
            {"exists": 1},
            {"extra": 1},
        ):
            data = manifest()
            data["files"]["rc_xml"]["installed"] = dict(state("b"), **change)
            with self.assertRaises(kf.StateDamaged, msg=change):
                kf.validate_manifest(data)
        data = manifest()
        data["files"]["rc_xml"]["installed"] = {"exists": False, "sha256": "b" * 64, "mode": None}
        with self.assertRaises(kf.StateDamaged):
            kf.validate_manifest(data)

    def test_phase_shapes(self):
        data = manifest()
        data["files"]["kanshi"]["target"] = state("c")  # a target in a finished run
        with self.assertRaises(kf.StateDamaged):
            kf.validate_manifest(data)
        data = manifest("writing")
        data["files"]["kanshi"]["installed"] = state("c")
        with self.assertRaises(kf.StateDamaged):
            kf.validate_manifest(data)
        data = manifest()
        data["files"]["launcher"]["original"] = state("d")  # a launcher that was there before
        with self.assertRaises(kf.StateDamaged):
            kf.validate_manifest(data)

    def test_strict_fields(self):
        for change in (
            {"connector": "HDMI-A-1\n"},
            {"connector": "DPI-1"},
            {"transform": "flipped"},
            {"orientation": "sideways"},
            {"enabled": "yes"},
            {"schema": 2},
            {"schema": True},
            {"phase": "installed"},
            {"operation": "delete"},
            {"autologin_before": "maybe"},
            {"touch_device": "bad\x1bname"},
            {"created_dirs": ["../../etc"]},
            {"created_dirs": [".ssh"]},
            {"created_files": [".local/state/sproutwall/kiosk/manifest.json"]},
            {"created_files": [".bashrc"]},
            {"extra": 1},
        ):
            with self.assertRaises(kf.StateDamaged, msg=change):
                kf.validate_manifest(manifest(**change))
        data = manifest()
        del data["files"]["launcher"]
        with self.assertRaises(kf.StateDamaged):
            kf.validate_manifest(data)

    def test_accepted_states(self):
        done = manifest()
        self.assertEqual(kf.accepted_states(done, "rc_xml"), [state("b")])
        writing = manifest("writing")
        self.assertEqual(kf.accepted_states(writing, "rc_xml"), [state("a"), state("b"), state("c")])
        seen = {key: kf.Seen(True, b"x", 0o644) for key in kf.MANAGED}
        self.assertEqual(kf.changed_since_setup(done, seen), list(kf.MANAGED))

    def test_unparsable_rc_xml_is_not_unmapped(self):
        with self.assertRaises(kf.RcXmlError):
            kf.effective_touch_output([kfk.SYSTEM_RC.encode(), b"<openbox_config>"], "ILITEK ILITEK-TP")


class StateFolderTests(unittest.TestCase):
    def setUp(self):
        self.home = kfk.temp_home(self)
        self.state = kf.State(self.home)

    def test_classify(self):
        self.assertEqual(self.state.classify(), "absent")
        os.makedirs(self.state.dir)
        self.assertEqual(self.state.classify(), "leftover")
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "setup.lock"), b"")
        self.assertEqual(self.state.classify(), "leftover")
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "notes.txt"), b"mine")
        self.assertEqual(self.state.classify(), "foreign")
        os.unlink(os.path.join(self.state.dir, "notes.txt"))
        os.makedirs(os.path.join(self.state.dir, "browser"))
        self.assertEqual(self.state.classify(), "foreign")  # a profile without a record
        os.rmdir(os.path.join(self.state.dir, "browser"))
        kfk.write(self.home, kiosk.KIOSK_LAUNCHER, b"#!/bin/sh\n")
        self.assertEqual(self.state.classify(), "foreign")  # a launcher without a record
        os.unlink(os.path.join(self.home, kiosk.KIOSK_LAUNCHER))
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "manifest.json"), b"{}")
        self.assertEqual(self.state.classify(), "manifest")

    def test_lock(self):
        lock = kf.RunLock(self.state).acquire()
        self.assertEqual(lock.created_dirs, [".local", ".local/state", ".local/state/sproutwall", kiosk.KIOSK_STATE_DIR])
        self.assertTrue(lock.created_file)
        with self.assertRaises(kf.Busy):
            kf.RunLock(self.state).acquire()
        lock.release()
        again = kf.RunLock(self.state).acquire()
        self.assertEqual((again.created_dirs, again.created_file), ([], False))
        again.release(remove=True)
        self.assertEqual(os.listdir(self.state.dir), [])

    def test_lock_file_replaced_while_waiting(self):
        lock = kf.RunLock(self.state)
        real_flock = kf.fcntl.flock

        def flock(fd, op):
            real_flock(fd, op)
            os.unlink(lock.path)  # a finishing run removed the lock file meanwhile
            kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "setup.lock"), b"")

        with mock.patch.object(kf.fcntl, "flock", side_effect=flock):
            with self.assertRaises(kf.Busy):
                lock.acquire()
