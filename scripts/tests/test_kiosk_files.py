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
    """write_atomic and remove_file in a real folder (the real renameat2 on
    Linux; fake_renameat2, which behaves the same, elsewhere)."""

    def setUp(self):
        kfk.portable(self)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name

    def path(self, name):
        return os.path.join(self.dir, name)

    def write(self, name, data, mode=0o644):
        kf.write_atomic(self.dir, name, data, mode, kf.observe(self.dir, name))
        return kf.observe(self.dir, name)

    def test_write_atomic_verifies_and_leaves_no_temp(self):
        self.write("rc.xml", b"one", 0o640)
        self.write("rc.xml", b"two", 0o640)
        seen = kf.observe(self.dir, "rc.xml")
        self.assertEqual((seen.data, seen.mode, seen.uid, seen.gid, seen.nlink), (b"two", 0o640, os.getuid(), os.getgid(), 1))
        self.assertEqual(os.listdir(self.dir), ["rc.xml"])

    def test_write_atomic_keeps_the_old_file_when_the_write_fails(self):
        self.write("autostart", b"old\n")
        with mock.patch.object(kf, "renameat2", side_effect=OSError(28, "No space left")) as swap:
            with self.assertRaises(OSError):
                kf.write_atomic(self.dir, "autostart", b"new\n", 0o644, kf.observe(self.dir, "autostart"))
        self.assertTrue(swap.called)
        self.assertEqual(kf.read_file(self.dir, "autostart"), b"old\n")
        self.assertEqual(os.listdir(self.dir), ["autostart"])  # the temporary file is gone

    def test_write_atomic_reads_back(self):
        real = kf.observe_at
        calls = []

        def observe_at(dir_fd, name):
            seen = real(dir_fd, name)
            calls.append(name)
            if name == "config" and seen.exists and len([c for c in calls if c == "config"]) > 1:
                seen.sha256 = kf.sha256(b"other")
            return seen

        with mock.patch.object(kf, "observe_at", side_effect=observe_at):
            with self.assertRaises(kf.WriteCheckFailed):
                kf.write_atomic(self.dir, "config", b"wanted", 0o644, kf.ABSENT)
        self.assertIn("config", calls)

    def test_a_change_before_the_final_check_stops_the_write(self):
        for change in ("bytes", "mode", "replaced", "removed", "hard link"):
            with self.subTest(change):
                checked = self.write("rc.xml", b"checked")
                if change == "bytes":
                    with open(self.path("rc.xml"), "wb") as handle:
                        handle.write(b"edited by Control Centre")
                elif change == "mode":
                    os.chmod(self.path("rc.xml"), 0o600)
                elif change == "replaced":  # same bytes and mode, new inode (an editor's save)
                    self.write("rc.xml", b"checked")
                elif change == "hard link":
                    os.link(self.path("rc.xml"), self.path("other"))
                else:
                    os.unlink(self.path("rc.xml"))
                before = kf.observe(self.dir, "rc.xml")
                with self.assertRaises(kf.ChangedMeanwhile):
                    kf.write_atomic(self.dir, "rc.xml", b"ours", 0o644, checked)
                self.assertTrue(kf.observe(self.dir, "rc.xml").same_file(before))  # left as it was
                expected = {"removed": [], "hard link": ["other", "rc.xml"]}.get(change, ["rc.xml"])
                self.assertEqual(sorted(os.listdir(self.dir)), expected)
                if change == "hard link":
                    os.unlink(self.path("other"))

    def inject(self, when):
        real = kf.renameat2
        reached = []

        def renameat2(src_fd, src, dst_fd, dst, flags):
            if when(src, dst, flags, reached):
                reached.append((src, dst, flags))
            return real(src_fd, src, dst_fd, dst, flags)

        return mock.patch.object(kf, "renameat2", side_effect=renameat2), reached

    def users_save(self, how, data=b"saved by the person"):
        if how == "in place":
            with open(self.path("rc.xml"), "r+b") as handle:
                handle.truncate(0)
                handle.write(data)
        else:
            with open(self.path("editor.tmp"), "wb") as handle:
                handle.write(data)
            os.rename(self.path("editor.tmp"), self.path("rc.xml"))

    def test_a_save_between_the_final_check_and_the_exchange(self):
        for how in ("in place", "new file"):
            with self.subTest(how):
                checked = self.write("rc.xml", b"checked")

                def when(src, dst, flags, reached, how=how):
                    if not reached and flags == kf.RENAME_EXCHANGE:
                        self.users_save(how)
                        return True
                    return False

                patch, reached = self.inject(when)
                with patch, self.assertRaises(kf.ChangedMeanwhile):
                    kf.write_atomic(self.dir, "rc.xml", b"ours", 0o644, checked)
                self.assertEqual(len(reached), 1)
                self.assertEqual(kf.read_file(self.dir, "rc.xml"), b"saved by the person")
                self.assertEqual(os.listdir(self.dir), ["rc.xml"])

    def test_a_save_between_the_final_check_and_a_removal(self):
        for how in ("in place", "new file"):
            with self.subTest(how):
                checked = self.write("rc.xml", b"checked")

                def when(src, dst, flags, reached, how=how):
                    if not reached and dst.endswith(kf.QUARANTINE_SUFFIX):
                        self.users_save(how)
                        return True
                    return False

                patch, reached = self.inject(when)
                with patch, self.assertRaises(kf.ChangedMeanwhile):
                    kf.remove_file(self.dir, "rc.xml", checked)
                self.assertEqual(len(reached), 1)
                self.assertEqual(kf.read_file(self.dir, "rc.xml"), b"saved by the person")
                self.assertEqual(os.listdir(self.dir), ["rc.xml"])

    def test_a_removal_whose_name_is_taken_meanwhile_keeps_both(self):
        checked = self.write("rc.xml", b"checked")

        def when(src, dst, flags, reached):
            if dst.endswith(kf.QUARANTINE_SUFFIX):
                self.users_save("in place", b"mine")
                return True
            if src.endswith(kf.QUARANTINE_SUFFIX) and dst == "rc.xml":
                with open(self.path("rc.xml"), "wb") as handle:
                    handle.write(b"newer")
                return True
            return False

        patch, reached = self.inject(when)
        with patch, self.assertRaises(kf.KeptAside):
            kf.remove_file(self.dir, "rc.xml", checked)
        self.assertEqual(len(reached), 2)
        self.assertEqual(sorted(os.listdir(self.dir)), ["rc.xml", "rc.xml.sproutwall-kept-1"])
        self.assertEqual(kf.read_file(self.dir, "rc.xml.sproutwall-kept-1"), b"mine")
        self.assertEqual(kf.read_file(self.dir, "rc.xml"), b"newer")

    def around(self, before=None, after=None):
        """Wrap kf.renameat2: before(n, src, dst, flags) and after(...) run
        around the n-th real call (1-based). Returns the patch and the log
        of (src, dst, flags) calls."""
        real = kf.renameat2
        log = []

        def renameat2(src_fd, src, dst_fd, dst, flags):
            log.append((src, dst, flags))
            if before:
                before(len(log), src, dst, flags)
            result = real(src_fd, src, dst_fd, dst, flags)
            if after:
                after(len(log), src, dst, flags)
            return result

        return mock.patch.object(kf, "renameat2", side_effect=renameat2), log

    def test_a_save_during_the_rollback_is_kept_not_deleted(self):
        """The first save (between the last check and the swap) makes the
        swap roll back. A second save during that rollback, by an editor
        that renames over the file before the swap back, or that writes
        into the file after it, must also survive: the version at the
        temporary name is not provably ours, so it is kept aside."""
        for variant in ("renamed over before the swap back", "written into after the swap back"):
            with self.subTest(variant):
                for name in os.listdir(self.dir):
                    os.unlink(self.path(name))
                checked = self.write("rc.xml", b"checked")
                reached = []

                def before(n, src, dst, flags, variant=variant):
                    if n == 1 and flags == kf.RENAME_EXCHANGE:
                        self.users_save("in place", b"mine")
                        reached.append("first save")
                    if n == 2 and flags == kf.RENAME_EXCHANGE and variant.startswith("renamed"):
                        self.users_save("new file", b"newest")
                        reached.append("save during rollback")

                def after(n, src, dst, flags, variant=variant):
                    if n == 2 and flags == kf.RENAME_EXCHANGE and variant.startswith("written"):
                        with open(self.path(src), "r+b") as handle:  # the editor's open file is now at src
                            handle.truncate(0)
                            handle.write(b"newest")
                        reached.append("save during rollback")

                patch, log = self.around(before, after)
                with patch, self.assertRaises(kf.KeptAside):
                    kf.write_atomic(self.dir, "rc.xml", b"ours", 0o644, checked)
                self.assertEqual(reached, ["first save", "save during rollback"])
                self.assertEqual(sorted(os.listdir(self.dir)), ["rc.xml", "rc.xml.sproutwall-kept-1"])
                self.assertEqual(kf.read_file(self.dir, "rc.xml"), b"mine")
                self.assertEqual(kf.read_file(self.dir, "rc.xml.sproutwall-kept-1"), b"newest")

    def tainting(self, inodes):
        """_xattrs reports an ACL for the files and folders whose inode is in inodes."""
        previous = kf._xattrs

        def xattrs(fd):
            if os.fstat(fd).st_ino in inodes:
                return ("system.posix_acl_access",)
            return previous(fd)

        return mock.patch.object(kf, "_xattrs", side_effect=xattrs)

    def test_a_generated_file_must_pass_the_undo_check(self):
        """A temporary file that comes out with an ACL is removed before any
        swap; one that gains it after the swap fails the read-back and is
        rolled back; a new file that gains it is taken back. Nothing of the
        person's is touched and nothing of ours is left."""
        inodes = set()
        real_temp = kf._write_temp

        def write_temp(dir_fd, name, data, mode, suffix=kf.TMP_SUFFIX):
            tmp = real_temp(dir_fd, name, data, mode, suffix)
            inodes.add(os.stat(tmp, dir_fd=dir_fd, follow_symlinks=False).st_ino)
            return tmp

        checked = self.write("rc.xml", b"checked")
        patch, log = self.around()
        with self.tainting(inodes), mock.patch.object(kf, "_write_temp", side_effect=write_temp), patch:
            with self.assertRaises(kf.UnsupportedMetadata):
                kf.write_atomic(self.dir, "rc.xml", b"ours", 0o644, checked)
        self.assertEqual(log, [], "refused before any swap")
        self.assertEqual((os.listdir(self.dir), kf.read_file(self.dir, "rc.xml")), (["rc.xml"], b"checked"))

        def taint_at(target):
            def after(n, src, dst, flags):
                if n == 1:
                    inodes.add(os.stat(self.path(target)).st_ino)

            return after

        inodes.clear()
        patch, log = self.around(after=taint_at("rc.xml"))
        with self.tainting(inodes), patch, self.assertRaises(kf.UnsupportedMetadata):
            kf.write_atomic(self.dir, "rc.xml", b"ours", 0o644, checked)
        self.assertEqual([flags for _, _, flags in log], [kf.RENAME_EXCHANGE, kf.RENAME_EXCHANGE], "swapped, then swapped back")
        self.assertEqual((os.listdir(self.dir), kf.read_file(self.dir, "rc.xml")), (["rc.xml"], b"checked"))

        inodes.clear()
        patch, log = self.around(after=taint_at("new.conf"))
        with self.tainting(inodes), patch, self.assertRaises(kf.UnsupportedMetadata):
            kf.write_atomic(self.dir, "new.conf", b"ours", 0o644, kf.ABSENT)
        self.assertEqual(log[0][2], kf.RENAME_NOREPLACE)
        self.assertEqual(os.listdir(self.dir), ["rc.xml"])  # taken back

    def test_a_folder_that_hands_out_acls_is_refused_before_writing(self):
        os.makedirs(self.path(os.path.join(".config", "labwc")))
        folder = os.stat(self.path(os.path.join(".config", "labwc"))).st_ino
        before = sorted(os.listdir(self.dir))
        with self.tainting({folder}), self.assertRaises(kf.UnsupportedMetadata):
            kf.probe_rename_support(self.dir, [os.path.join(".config", "labwc", "rc.xml")])
        self.assertEqual(sorted(os.listdir(self.dir)), before)
        self.assertEqual(os.listdir(self.path(os.path.join(".config", "labwc"))), [])

    @unittest.skipUnless(hasattr(os, "setxattr"), kfk.LINUX_ONLY)
    def test_a_real_default_acl(self):
        """On Linux, with a real POSIX default ACL (an extra user entry): the
        folder is refused, and a file made in it does inherit an ACL, which
        check_generated catches."""
        import struct

        folder = self.path("acl")
        os.mkdir(folder)
        undefined = 0xFFFFFFFF
        entries = ((0x01, 7, undefined), (0x02, 7, os.getuid() + 1), (0x04, 5, undefined), (0x10, 7, undefined), (0x20, 5, undefined))
        acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries)
        try:
            os.setxattr(folder, "system.posix_acl_default", acl)
        except OSError as error:
            self.skipTest("no POSIX ACLs on this file system (%s)" % error.strerror)
        with self.assertRaises(kf.UnsupportedMetadata):
            kf.probe_rename_support(self.dir, [os.path.join("acl", "rc.xml")])
        self.assertEqual(os.listdir(folder), [])
        fd = os.open(folder, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        tmp = kf._write_temp(fd, "rc.xml", b"x", 0o644)
        with self.assertRaises(kf.UnsupportedMetadata):
            kf.check_generated(kf.observe_at(fd, tmp), b"x", 0o644)

    def test_remove_file_removes_only_the_verified_file(self):
        checked = self.write("rc.xml", b"checked")
        kf.remove_file(self.dir, "rc.xml", checked)
        self.assertEqual(os.listdir(self.dir), [])
        kf.remove_file(self.dir, "rc.xml", kf.ABSENT)  # already gone: nothing to do

    def test_unsupported_metadata(self):
        checked = self.write("rc.xml", b"checked")
        kf.check_supported(checked)
        for field, value in (("nlink", 2), ("uid", os.getuid() + 1), ("gid", os.getgid() + 1), ("xattrs", ("user.x",))):
            seen = kf.observe(self.dir, "rc.xml")
            setattr(seen, field, value)
            with self.assertRaises(kf.UnsupportedMetadata, msg=field):
                kf.check_supported(seen)
        kf.check_supported(kf.ABSENT)

    def test_observe_tells_errors_and_types_from_absence(self):
        self.assertFalse(kf.observe(self.dir, "absent").exists)
        self.assertFalse(kf.observe(self.dir, os.path.join("no", "such", "folder")).exists)
        seen = self.write("plain", b"x", 0o640)
        self.assertEqual((seen.exists, seen.data, seen.mode, seen.sha256), (True, b"x", 0o640, kf.sha256(b"x")))
        with self.assertRaises(kf.ManagedFileError):
            kf.observe(self.dir, os.path.join("plain", "below"))  # a path part that is a file
        os.symlink(self.path("plain"), self.path("link"))
        with self.assertRaises(kf.ManagedFileError):
            kf.observe(self.dir, "link")
        os.mkdir(self.path("folder"))
        os.symlink(self.path("folder"), self.path("folderlink"))
        with self.assertRaises(kf.ManagedFileError):
            kf.observe(self.dir, os.path.join("folderlink", "x"))  # a link on the way
        with self.assertRaises(kf.ManagedFileError):
            kf.observe(self.dir, "folder")
        os.mkfifo(self.path("fifo"))
        with self.assertRaises(kf.ManagedFileError):
            kf.observe(self.dir, "fifo")  # never blocks, never read

    def test_xattr_errors(self):
        def failing(error_number):
            def lister(_fd):
                raise OSError(error_number, os.strerror(error_number))

            return lister

        import errno

        # The real _xattrs, not the stand-in portable() installs where
        # os.listxattr is missing (macOS); os.listxattr itself is faked.
        with mock.patch.object(os, "listxattr", side_effect=failing(errno.ENOTSUP), create=True):
            self.assertEqual(kfk.REAL_XATTRS(0), ())
        with mock.patch.object(os, "listxattr", side_effect=failing(errno.EIO), create=True):
            with self.assertRaises(OSError):
                kfk.REAL_XATTRS(0)
        with mock.patch.object(os, "listxattr", return_value=["user.b", "user.a"], create=True):
            self.assertEqual(kfk.REAL_XATTRS(0), ("user.a", "user.b"))

    def test_assert_no_links(self):
        os.makedirs(os.path.join(self.dir, "real", ".config"))
        kf.assert_no_links(self.dir, [os.path.join("real", ".config", "labwc", "rc.xml")])
        os.symlink(os.path.join(self.dir, "real"), self.path("linked"))
        with self.assertRaises(kf.ManagedFileError):
            kf.assert_no_links(self.dir, [os.path.join("linked", ".config", "labwc", "rc.xml")])
        self.write("file", b"x")
        with self.assertRaises(kf.ManagedFileError):
            kf.assert_no_links(self.dir, [os.path.join("file", "labwc", "rc.xml")])


@unittest.skipUnless(kfk.LINUX and kf._renameat2_function() is not None, kfk.LINUX_ONLY)
class RealRenameat2Tests(unittest.TestCase):
    """The real renameat2(2) of this machine, and fake_renameat2 next to it:
    the same results and the same errors."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.fd = os.open(self.dir, os.O_RDONLY)
        self.addCleanup(os.close, self.fd)

    def contents(self):
        found = {}
        for name in sorted(os.listdir(self.dir)):
            st = os.lstat(os.path.join(self.dir, name))
            with open(os.path.join(self.dir, name), "rb") as handle:
                found[name] = (handle.read(), st.st_ino)
        return found

    def reset(self, names):
        for name in os.listdir(self.dir):
            os.unlink(os.path.join(self.dir, name))
        for name in names:
            with open(os.path.join(self.dir, name), "wb") as handle:
                handle.write(name.encode())

    def outcome(self, call, files, src, dst, flags):
        self.reset(files)
        inodes = {name: os.lstat(os.path.join(self.dir, name)).st_ino for name in files}
        try:
            call(self.fd, src, self.fd, dst, flags)
            error = None
        except OSError as raised:
            error = type(raised)
        after = {name: (data, [n for n, i in inodes.items() if i == ino]) for name, (data, ino) in self.contents().items()}
        return error, after

    def test_exchange_really_swaps(self):
        self.reset(["a", "b"])
        before = {name: ino for name, (_, ino) in self.contents().items()}
        kf.renameat2(self.fd, "a", self.fd, "b", kf.RENAME_EXCHANGE)
        after = self.contents()
        self.assertEqual(after["a"], (b"b", before["b"]))
        self.assertEqual(after["b"], (b"a", before["a"]))

    def test_probe_passes_here(self):
        kf.probe_rename_support(self.dir, ["x"])
        self.assertEqual(os.listdir(self.dir), [])

    def test_fake_behaves_like_the_real_call(self):
        cases = (
            (["a"], "a", "b", kf.RENAME_NOREPLACE),
            (["a", "b"], "a", "b", kf.RENAME_NOREPLACE),
            (["a", "b"], "a", "b", kf.RENAME_EXCHANGE),
            (["a"], "a", "b", kf.RENAME_EXCHANGE),
            (["b"], "a", "b", kf.RENAME_EXCHANGE),
            ([], "a", "b", kf.RENAME_NOREPLACE),
        )
        for case in cases:
            with self.subTest(case):
                self.assertEqual(self.outcome(kfk.fake_renameat2, *case), self.outcome(kf.renameat2, *case))


class RenameSupportTests(unittest.TestCase):
    def setUp(self):
        kfk.portable(self)

    def test_unsupported_errors_and_no_symbol(self):
        """The real wrapper (not the stand-in portable() installs off Linux),
        with the libc function faked."""
        import ctypes
        import errno

        for code in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):

            def unsupported(*_args, code=code):
                ctypes.set_errno(code)
                return -1

            with mock.patch.object(kf, "_renameat2_function", return_value=unsupported):
                with self.assertRaises(kf.RenameUnsupported):
                    kfk.REAL_RENAMEAT2(0, "a", 0, "b", kf.RENAME_EXCHANGE)

        def exists(*_args):
            ctypes.set_errno(errno.EEXIST)
            return -1

        with mock.patch.object(kf, "_renameat2_function", return_value=exists):
            with self.assertRaises(FileExistsError):
                kfk.REAL_RENAMEAT2(0, "a", 0, "b", kf.RENAME_NOREPLACE)
        with mock.patch.object(kf, "_renameat2_function", return_value=None):
            with self.assertRaises(kf.RenameUnsupported):
                kfk.REAL_RENAMEAT2(0, "a", 0, "b", kf.RENAME_EXCHANGE)

    def test_probe_refuses_before_writing(self):
        home = kfk.temp_home(self)
        with mock.patch.object(kf, "renameat2", side_effect=kf.RenameUnsupported("x")):
            with self.assertRaises(kf.RenameUnsupported):
                kf.probe_rename_support(home, [os.path.join(".config", "labwc", "rc.xml")])
        self.assertEqual(os.listdir(home), [])  # the probe files are gone too


class StrictJsonTests(unittest.TestCase):
    def test_duplicates_and_constants(self):
        from sproutwall_lib import kiosk_launcher

        samples = ('{"a": 1}', '{"a": 1, "a": 2}', '{"a": {"b": 1, "b": 1}}', '[{"x": 1}, {"x": 2}]', '{"a": NaN}', '{"a": Infinity}', "[1, 2]")
        for text in samples:
            outcomes = []
            for loads in (kiosk.loads_strict, kiosk_launcher.loads_strict):
                try:
                    outcomes.append(("ok", loads(text)))
                except ValueError:
                    outcomes.append(("refused", None))
            with self.subTest(text):
                self.assertEqual(outcomes[0], outcomes[1])
                self.assertEqual(outcomes[0][0], "refused" if ("a\": 1, \"a" in text or "b\": 1, \"b" in text or "NaN" in text or "Infinity" in text) else "ok")


def state(sha="a", mode=0o644):
    return {"exists": True, "sha256": sha * 64, "mode": mode, "uid": 1000, "gid": 1000}


ABSENT_STATE = {"exists": False, "sha256": None, "mode": None, "uid": None, "gid": None}


def manifest(phase="done", **changes):
    files = {}
    for key in kf.MANAGED:
        original = ABSENT_STATE if key == "launcher" else state("a")
        if phase == "done":
            files[key] = {"original": original, "installed": state("b"), "previous": None, "target": None}
        elif phase == "init":
            files[key] = {"original": original, "installed": None, "previous": None, "target": None}
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
        "created_files": {
            ".local/state/sproutwall/kiosk/setup.lock": {"sha256": kf.sha256(b""), "mode": 0o600, "dev": 2049, "ino": 77},
            ".local/state/sproutwall/kiosk/original/rc_xml": {"sha256": "a" * 64, "mode": 0o600, "dev": None, "ino": None},
        },
        "files": files,
    }
    data.update(changes)
    return data


class ManifestTests(unittest.TestCase):
    def setUp(self):
        kfk.portable(self)

    def test_valid(self):
        kf.validate_manifest(manifest())
        kf.validate_manifest(manifest("writing"))
        kf.validate_manifest(manifest("init"))

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
            {"uid": None},
            {"gid": -1},
            {"uid": "1000"},
            {"extra": 1},
        ):
            data = manifest()
            data["files"]["rc_xml"]["installed"] = dict(state("b"), **change)
            with self.assertRaises(kf.StateDamaged, msg=change):
                kf.validate_manifest(data)
        data = manifest()
        data["files"]["rc_xml"]["installed"] = dict(ABSENT_STATE, sha256="b" * 64)
        with self.assertRaises(kf.StateDamaged):
            kf.validate_manifest(data)
        data = manifest("init")
        data["files"]["rc_xml"]["installed"] = state("b")  # init has only originals
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
            {"created_files": {".local/state/sproutwall/kiosk/manifest.json": {"sha256": "a" * 64, "mode": 0o600, "dev": None, "ino": None}}},
            {"created_files": {".bashrc": {"sha256": "a" * 64, "mode": 0o600, "dev": None, "ino": None}}},
            {"created_files": {".local/state/sproutwall/kiosk/setup.lock": {"sha256": "a" * 64, "mode": 0o600, "dev": 1, "ino": None}}},
            {"created_files": [".local/state/sproutwall/kiosk/setup.lock"]},
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
        self.assertEqual(kf.accepted_states(manifest("init"), "rc_xml"), [state("a")])
        home = kfk.temp_home(self)
        kfk.write(home, "x", b"x")
        seen = {key: kf.observe(home, "x") for key in kf.MANAGED}
        self.assertEqual(kf.changed_since_setup(done, seen), list(kf.MANAGED))

    def test_unparsable_rc_xml_is_not_unmapped(self):
        with self.assertRaises(kf.RcXmlError):
            kf.effective_touch_output([kfk.SYSTEM_RC.encode(), b"<openbox_config>"], "ILITEK ILITEK-TP")


class StateFolderTests(unittest.TestCase):
    def setUp(self):
        kfk.portable(self)
        self.home = kfk.temp_home(self)
        self.state = kf.State(self.home)

    def test_classify(self):
        self.assertEqual(self.state.classify(), "absent")
        os.makedirs(self.state.dir)
        self.assertEqual(self.state.classify(), "foreign")  # even empty: not this tool's
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "setup.lock"), b"")
        self.assertEqual(self.state.classify(), "foreign")
        os.makedirs(os.path.join(self.state.dir, "browser"))
        self.assertEqual(self.state.classify(), "foreign")  # a profile without a record
        os.rmdir(os.path.join(self.state.dir, "browser"))
        kfk.write(self.home, kiosk.KIOSK_LAUNCHER, b"#!/bin/sh\n")
        self.assertEqual(self.state.classify(), "foreign")  # a launcher without a record
        os.unlink(os.path.join(self.home, kiosk.KIOSK_LAUNCHER))
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "manifest.json"), b"{}")
        self.assertEqual(self.state.classify(), "manifest")
        os.unlink(os.path.join(self.state.dir, "manifest.json"))
        os.symlink(os.path.join(self.state.dir, "setup.lock"), os.path.join(self.state.dir, "manifest.json"))
        with self.assertRaises(kf.StateLink):
            self.state.classify()

    def test_create_makes_only_a_new_folder(self):
        created = []
        self.state.create(created)
        self.assertEqual(created, [".local", ".local/state", ".local/state/sproutwall", kiosk.KIOSK_STATE_DIR])
        self.assertEqual(os.stat(self.state.dir).st_mode & 0o777, 0o700)
        self.state.close()
        with self.assertRaises(kf.StateExists):
            kf.State(self.home).create([])

    def test_lock(self):
        self.state.create([])
        lock = kf.lock_fd(self.state.fd, create=True)
        other = kf.State(self.home)
        other.open()
        self.addCleanup(other.close)
        with self.assertRaises(kf.Busy):
            kf.lock_fd(other.fd)
        with self.assertRaises(kf.Busy):
            kf.lock_fd(other.fd, shared=True)  # a starting launcher waits for nobody
        os.close(lock)
        shared = kf.lock_fd(other.fd, shared=True)
        with self.assertRaises(kf.Busy):
            kf.lock_fd(self.state.fd)  # --off and --undo cannot start while a launcher is starting
        os.close(shared)
        os.close(kf.lock_fd(self.state.fd))
        self.state.close()

    def test_lock_file_replaced_while_waiting(self):
        self.state.create([])
        os.close(kf.lock_fd(self.state.fd, create=True))
        real_flock = kf.fcntl.flock

        def flock(fd, op):
            real_flock(fd, op)
            os.unlink(os.path.join(self.state.dir, "setup.lock"))  # a finishing run removed it meanwhile
            kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "setup.lock"), b"")

        with mock.patch.object(kf.fcntl, "flock", side_effect=flock):
            with self.assertRaises(kf.Busy):
                kf.lock_fd(self.state.fd)
        self.state.close()

    def test_a_link_for_the_lock_or_a_subfolder(self):
        self.state.create([])
        os.symlink(os.path.join(self.home, "elsewhere"), os.path.join(self.state.dir, "setup.lock"))
        with self.assertRaises(kf.StateLink):
            kf.lock_fd(self.state.fd)
        os.mkdir(os.path.join(self.home, "outside"))
        os.symlink(os.path.join(self.home, "outside"), os.path.join(self.state.dir, "original"))
        with self.assertRaises(kf.StateLink):
            self.state.check_dirs()
        with self.assertRaises(kf.StateLink):
            self.state.observe_created(os.path.join("original", "rc_xml"))
        self.state.close()

    def test_empty_profile_removes_links_without_following(self):
        self.state.create([])
        outside = os.path.join(self.home, "outside")
        kfk.write(self.home, os.path.join("outside", "keep"), b"keep")
        profile = os.path.join(self.state.dir, "browser")
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "browser", "Default", "Cookies"), b"unlock", 0o600)
        os.makedirs(os.path.join(profile, "Default", "Cache"))
        os.symlink("host-1234", os.path.join(profile, "SingletonLock"))
        os.symlink(outside, os.path.join(profile, "Default", "escape"))
        self.state.empty_profile()
        self.assertEqual(os.listdir(profile), [])
        self.assertEqual(os.listdir(outside), ["keep"])
        self.state.close()

    def test_created_files_are_checked_before_removal(self):
        self.state.create([])
        rel = os.path.join(kiosk.KIOSK_STATE_DIR, "run", "starting.html")
        os.mkdir(os.path.join(self.state.dir, "run"))
        record = self.state.write_created(os.path.join("run", "starting.html"), b"page", 0o600)
        manifest = {"created_files": {rel: record}}
        self.assertIs(self.state.created_matches(manifest, rel), True)
        kfk.write(self.home, rel + ".new", b"page", mode=0o600)
        os.rename(os.path.join(self.home, rel + ".new"), os.path.join(self.home, rel))  # same bytes, another file
        self.assertIs(self.state.created_matches(manifest, rel), False)
        self.assertFalse(self.state.remove_created(manifest, rel))
        self.assertEqual(kfk.read(self.home, rel), b"page")  # kept
        os.unlink(os.path.join(self.home, rel))
        self.assertIsNone(self.state.created_matches(manifest, rel))
        record = self.state.write_created(os.path.join("run", "starting.html"), b"page", 0o600)
        manifest = {"created_files": {rel: record}}
        self.assertTrue(self.state.remove_created(manifest, rel))
        self.assertEqual(os.listdir(os.path.join(self.state.dir, "run")), [])
        self.state.close()
