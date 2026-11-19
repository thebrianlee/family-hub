"""setup kiosk file transforms: labwc autostart, labwc rc.xml and the kanshi
config. Unrelated content must survive byte for byte, and a second run must
give the same bytes as the first."""

import unittest
import xml.etree.ElementTree as ET

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


class StatusTests(unittest.TestCase):
    def test_file_status(self):
        entry = {"existed": True, "original": kf.sha256(b"a"), "written": kf.sha256(b"b")}
        self.assertEqual(kf.file_status(entry, b"b"), "as_set_up")
        self.assertEqual(kf.file_status(entry, b"a"), "original")
        self.assertEqual(kf.file_status(entry, b"c"), "changed")
        self.assertEqual(kf.file_status(entry, None), "changed")
        absent = {"existed": False, "original": None, "written": kf.sha256(b"b")}
        self.assertEqual(kf.file_status(absent, None), "original")


if __name__ == "__main__":
    unittest.main()


class DiskTests(unittest.TestCase):
    def setUp(self):
        import tempfile

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name

    def test_write_atomic_verifies_and_leaves_no_temp(self):
        import os

        path = os.path.join(self.dir, "rc.xml")
        kf.write_atomic(path, b"one", 0o640)
        kf.write_atomic(path, b"two", 0o640)
        self.assertEqual(kf.read_file(path), b"two")
        self.assertEqual(kf.file_mode(path), 0o640)
        self.assertEqual(os.listdir(self.dir), ["rc.xml"])

    def test_write_atomic_keeps_the_old_file_when_the_write_fails(self):
        import os
        from unittest import mock

        path = os.path.join(self.dir, "autostart")
        kf.write_atomic(path, b"old\n", 0o644)
        with mock.patch.object(kf.os, "replace", side_effect=OSError(28, "No space left")):
            with self.assertRaises(OSError):
                kf.write_atomic(path, b"new\n", 0o644)
        self.assertEqual(kf.read_file(path), b"old\n")
        self.assertEqual(os.listdir(self.dir), ["autostart"])  # the temporary file is gone

    def test_write_atomic_reads_back(self):
        import os
        from unittest import mock

        path = os.path.join(self.dir, "config")
        real = kf.read_file
        with mock.patch.object(kf, "read_file", side_effect=lambda p: b"other" if p == path else real(p)) as reader:
            with self.assertRaises(kf.WriteCheckFailed):
                kf.write_atomic(path, b"wanted", 0o644)
        self.assertTrue(reader.called)

    def test_read_file_tells_errors_from_absence(self):
        import os

        self.assertIsNone(kf.read_file(os.path.join(self.dir, "absent")))
        self.assertIsNone(kf.read_file(os.path.join(self.dir, "no", "such", "folder")))
        plain = os.path.join(self.dir, "plain")
        kf.write_atomic(plain, b"x", 0o644)
        with self.assertRaises(NotADirectoryError):
            kf.read_file(os.path.join(plain, "below"))  # a path part that is a file
        os.symlink(plain, os.path.join(self.dir, "link"))
        with self.assertRaises(kf.ManagedFileError):
            kf.read_file(os.path.join(self.dir, "link"))
        os.mkdir(os.path.join(self.dir, "folder"))
        with self.assertRaises(kf.ManagedFileError):
            kf.read_file(os.path.join(self.dir, "folder"))

    def test_assert_no_links(self):
        import os

        os.makedirs(os.path.join(self.dir, "real", ".config"))
        kf.assert_no_links(self.dir, [os.path.join("real", ".config", "labwc", "rc.xml")])
        os.symlink(os.path.join(self.dir, "real"), os.path.join(self.dir, "linked"))
        with self.assertRaises(kf.ManagedFileError):
            kf.assert_no_links(self.dir, [os.path.join("linked", ".config", "labwc", "rc.xml")])
        kf.write_atomic(os.path.join(self.dir, "file"), b"x", 0o644)
        with self.assertRaises(kf.ManagedFileError):
            kf.assert_no_links(self.dir, [os.path.join("file", "labwc", "rc.xml")])


def manifest(**changes):
    entry = {"existed": True, "mode": 0o644, "original": "a" * 64, "written": "b" * 64}
    data = {
        "schema": 1,
        "status": "installed",
        "enabled": True,
        "orientation": "portrait",
        "connector": "HDMI-A-1",
        "transform": "90",
        "touch_device": "ILITEK ILITEK-TP",
        "autologin_before": "off",
        "created_dirs": [".local/state/sproutwall/kiosk"],
        "files": {key: dict(entry) for key in kf.MANAGED},
    }
    data.update(changes)
    return data


class ManifestTests(unittest.TestCase):
    def test_valid(self):
        kf.validate_manifest(manifest())
        absent = manifest()
        absent["files"]["kanshi"] = {"existed": False, "mode": None, "original": None, "written": "c" * 64}
        kf.validate_manifest(absent)

    def test_strict(self):
        bad_entries = (
            {"original": "A" * 64},
            {"original": "a" * 63},
            {"original": "a" * 64 + "\n"},
            {"original": " " + "a" * 63},
            {"original": "١" * 64},
            {"written": None},
            {"mode": "644"},
            {"mode": 0o10000},
            {"existed": 1},
        )
        for change in bad_entries:
            data = manifest()
            data["files"]["rc_xml"] = dict(data["files"]["rc_xml"], **change)
            with self.assertRaises(kf.StateDamaged, msg=change):
                kf.validate_manifest(data)
        for change in (
            {"connector": "HDMI-A-1\n"},
            {"connector": "DPI-1"},
            {"transform": "flipped"},
            {"orientation": "sideways"},
            {"enabled": "yes"},
            {"schema": 2},
            {"schema": True},
            {"status": "done"},
            {"autologin_before": "maybe"},
            {"touch_device": "bad\x1bname"},
            {"created_dirs": ["../../etc"]},
            {"created_dirs": [".ssh"]},
            {"extra": 1},
        ):
            with self.assertRaises(kf.StateDamaged, msg=change):
                kf.validate_manifest(manifest(**change))
        data = manifest()
        del data["files"]["launcher"]
        with self.assertRaises(kf.StateDamaged):
            kf.validate_manifest(data)

    def test_unparsable_rc_xml_is_not_unmapped(self):
        with self.assertRaises(kf.RcXmlError):
            kf.effective_touch_output([kfk.SYSTEM_RC.encode(), b"<openbox_config>"], "ILITEK ILITEK-TP")
