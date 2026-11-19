"""setup kiosk detection: platform, the labwc session, outputs, touch inputs,
orientation transforms, autologin and blanking. Read-only, from fakes.

Every source has a "cannot tell" test: an error other than ENOENT, or input
that does not parse exactly, raises CannotTell and is never read as
missing or off."""

import json
import unittest

from sproutwall_lib import kiosk_detect as det
from sproutwall_lib.system import CommandResult

from . import kiosk_fakes as kfk
from .fakes import ok


def pi():
    return kfk.KioskPi("/home/pi")


class PlatformTests(unittest.TestCase):
    def test_raspberry_pi_os_64_bit(self):
        s = pi()
        self.assertTrue(det.platform_supported(s))
        self.assertIn(det.DT_MODEL, s.reads)

    def test_refused_elsewhere(self):
        s = pi()
        s.arch = "x86_64"
        self.assertFalse(det.platform_supported(s))  # an amd64 mini PC: hub yes, kiosk tool no
        s = pi()
        s.set(["dpkg", "--print-architecture"], ok("armhf\n"))
        self.assertFalse(det.platform_supported(s))
        s = pi()
        s.set(["dpkg", "--print-architecture"], CommandResult(None, missing=True))
        self.assertFalse(det.platform_supported(s))
        s = pi()
        del s.files["/etc/rpi-issue"]
        self.assertFalse(det.platform_supported(s))  # Debian or Ubuntu on a Pi
        s = pi()
        s.files["/proc/device-tree/model"] = b"Sample ARM Board\x00"
        self.assertFalse(det.platform_supported(s))
        s = pi()
        del s.files["/proc/device-tree/model"]
        self.assertFalse(det.platform_supported(s))

    def test_cannot_tell(self):
        for change in ("dpkg_fails", "dpkg_timeout", "dpkg_odd", "issue_stat", "model_read"):
            s = pi()
            if change == "dpkg_fails":
                s.set(["dpkg", "--print-architecture"], ok("", "error", rc=2))
            elif change == "dpkg_timeout":
                s.set(["dpkg", "--print-architecture"], CommandResult(None, timed_out=True))
            elif change == "dpkg_odd":
                s.set(["dpkg", "--print-architecture"], ok(" arm64\n"))
            elif change == "issue_stat":
                s.probe_errors.add("/etc/rpi-issue")
            else:
                s.files["/proc/device-tree/model"] = PermissionError(13, "denied")
            with self.assertRaises(det.CannotTell, msg=change):
                det.platform_supported(s)

    def test_dpkg_output_is_strict(self):
        for out in ("arm64\n\n", "arm64 \n", "ARM64\n", "arm64\r\n"):
            s = pi()
            s.set(["dpkg", "--print-architecture"], ok(out))
            with self.assertRaises(det.CannotTell, msg=repr(out)):
                det.platform_supported(s)


class SessionTests(unittest.TestCase):
    def test_labwc_session_found_through_kanshi(self):
        s = pi()
        session = det.find_session(s)
        self.assertEqual(session.reason, "ok")
        self.assertEqual(session.labwc_pid, kfk.LABWC_PID)
        self.assertEqual(session.kanshi_pids, [kfk.KANSHI_PID])
        self.assertEqual(session.env, {"WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": kfk.RUNTIME})
        self.assertEqual(s.process_reads, 1)

    def test_ssh_environment_is_not_used(self):
        s = pi()
        s.env = {"WAYLAND_DISPLAY": "wayland-9", "SSH_CONNECTION": "x"}
        self.assertEqual(det.find_session(s).env["WAYLAND_DISPLAY"], "wayland-0")

    def test_root(self):
        s = pi()
        s.euid_value = 0
        self.assertEqual(det.find_session(s).reason, "root")

    def test_lite_or_logged_out(self):
        s = pi()
        s.procs = [p for p in s.procs if p[2] not in ("labwc", "kanshi", "wf-panel-pi")]
        self.assertEqual(det.find_session(s).reason, "no_desktop")

    def test_x11_and_wayfire_are_other_desktops(self):
        for comm in ("Xorg", "wayfire"):
            s = pi()
            s.procs = [p for p in s.procs if p[2] != "labwc"] + [(901, kfk.UID, comm, ["/usr/bin/" + comm])]
            self.assertEqual(det.find_session(s).reason, "other_desktop", comm)

    def test_another_users_labwc_does_not_count(self):
        s = pi()
        s.procs = [(p[0], 1001 if p[2] == "labwc" else p[1], p[2], p[3]) for p in s.procs]
        self.assertEqual(det.find_session(s).reason, "no_desktop")

    def test_labwc_without_merge_config(self):
        s = pi()
        s.procs = [(p[0], p[1], p[2], ["/usr/bin/labwc"] if p[2] == "labwc" else p[3]) for p in s.procs]
        self.assertEqual(det.find_session(s).reason, "no_merge")

    def test_no_kanshi(self):
        s = pi()
        s.procs = [p for p in s.procs if p[2] != "kanshi"]
        self.assertEqual(det.find_session(s).reason, "no_kanshi")
        s = pi()
        s.environs[kfk.KANSHI_PID]["LABWC_PID"] = "12345"  # kanshi of some other session
        self.assertEqual(det.find_session(s).reason, "no_kanshi")
        s = pi()
        del s.environs[kfk.KANSHI_PID]  # exited meanwhile: not "unreadable"
        self.assertEqual(det.find_session(s).reason, "no_kanshi")

    def test_unreadable_process_table(self):
        s = pi()
        s.procs = PermissionError(13, "denied")
        with self.assertRaises(det.CannotTell):
            det.find_session(s)

    def test_unreadable_environments(self):
        for pid in (kfk.KANSHI_PID, kfk.LABWC_PID):
            s = pi()
            s.environs[pid] = PermissionError(13, "denied")
            s.env = {"LABWC_PID": str(kfk.LABWC_PID), "WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": kfk.RUNTIME}
            with self.assertRaises(det.CannotTell, msg=pid):
                det.find_session(s)  # never "no kanshi", and no fallback to the caller's environment
        s = pi()
        del s.environs[kfk.LABWC_PID]  # labwc gone meanwhile
        with self.assertRaises(det.CannotTell):
            det.find_session(s)

    def test_non_standard_config_places(self):
        cases = {
            "labwc -C": lambda s: s.procs.__setitem__(2, (kfk.LABWC_PID, kfk.UID, "labwc", ["/usr/bin/labwc", "-m", "-C", "/srv/labwc"])),
            "labwc --config-dir=": lambda s: s.procs.__setitem__(2, (kfk.LABWC_PID, kfk.UID, "labwc", ["/usr/bin/labwc", "-m", "--config-dir=/srv"])),
            "labwc -mC": lambda s: s.procs.__setitem__(2, (kfk.LABWC_PID, kfk.UID, "labwc", ["/usr/bin/labwc", "-mC", "/srv"])),
            "labwc --config": lambda s: s.procs.__setitem__(2, (kfk.LABWC_PID, kfk.UID, "labwc", ["/usr/bin/labwc", "-m", "--config", "/srv/rc.xml"])),
            "kanshi -c": lambda s: s.procs.__setitem__(3, (kfk.KANSHI_PID, kfk.UID, "kanshi", ["/usr/bin/kanshi", "-c", "/etc/xdg/labwc-greeter/config.kanshi"])),
            "kanshi --config=": lambda s: s.procs.__setitem__(3, (kfk.KANSHI_PID, kfk.UID, "kanshi", ["/usr/bin/kanshi", "--config=/srv/k"])),
            "XDG_CONFIG_HOME in labwc": lambda s: s.environs[kfk.LABWC_PID].__setitem__("XDG_CONFIG_HOME", "/srv/config"),
            "XDG_CONFIG_HOME in kanshi": lambda s: s.environs[kfk.KANSHI_PID].__setitem__("XDG_CONFIG_HOME", "/home/pi/.cfg"),
            "another HOME": lambda s: s.environs[kfk.LABWC_PID].__setitem__("HOME", "/home/someone"),
            "no HOME": lambda s: s.environs[kfk.KANSHI_PID].pop("HOME"),
        }
        for name, change in cases.items():
            s = pi()
            self.assertEqual(s.procs[2][2], "labwc")
            self.assertEqual(s.procs[3][2], "kanshi")
            change(s)
            self.assertEqual(det.find_session(s).reason, "config_path", name)
        s = pi()
        s.environs[kfk.LABWC_PID]["XDG_CONFIG_HOME"] = "/home/pi/.config/"
        s.environs[kfk.KANSHI_PID]["XDG_CONFIG_HOME"] = "/home/pi/.config"
        self.assertEqual(det.find_session(s).reason, "ok")  # the default, spelled out

    def test_socket(self):
        s = pi()
        del s.files[kfk.RUNTIME + "/wayland-0"]
        self.assertEqual(det.find_session(s).reason, "no_socket")
        s = pi()
        s.probe_errors.add(kfk.RUNTIME + "/wayland-0")
        with self.assertRaises(det.CannotTell):
            det.find_session(s)

    def test_strict_environment_values(self):
        for key, value in (
            ("WAYLAND_DISPLAY", "../../tmp/x"),
            ("WAYLAND_DISPLAY", "wayland-0\n"),
            ("WAYLAND_DISPLAY", " wayland-0"),
            ("WAYLAND_DISPLAY", "wayland-٣"),
            ("XDG_RUNTIME_DIR", "run/user/1000"),
            ("XDG_RUNTIME_DIR", "/run/user/1000/../0"),
            ("XDG_RUNTIME_DIR", "/run/user/1000\n"),
        ):
            s = pi()
            s.environs[kfk.KANSHI_PID][key] = value
            with self.assertRaises(det.CannotTell, msg=(key, value)):
                det.find_session(s)


class ChromiumTests(unittest.TestCase):
    def test_either_name(self):
        s = pi()
        self.assertEqual(det.find_chromium(s), "/usr/bin/chromium")
        del s.files["/usr/bin/chromium"]
        s.files["/usr/bin/chromium-browser"] = b"x"
        s.executables = {"/usr/bin/chromium-browser"}
        self.assertEqual(det.find_chromium(s), "/usr/bin/chromium-browser")
        s.executables = set()  # present but not executable for this user
        self.assertIsNone(det.find_chromium(s))
        del s.files["/usr/bin/chromium-browser"]
        self.assertIsNone(det.find_chromium(s))

    def test_cannot_tell(self):
        s = pi()
        s.probe_errors.add("/usr/bin/chromium")
        with self.assertRaises(det.CannotTell):
            det.find_chromium(s)


class OutputTests(unittest.TestCase):
    def outputs(self, items, json_randr=True):
        s = kfk.KioskPi("/home/pi", outputs=items, json_randr=json_randr)
        result = det.read_outputs(s, det.find_session(s))
        self.assertIn(("wlr-randr",) if not json_randr else ("wlr-randr", "--json"), [argv for argv, _ in s.calls])
        return result

    def test_json_and_plain_text_agree(self):
        items = [kfk.output_json("HDMI-A-1", transform="90"), kfk.output_json("DSI-1", enabled=False)]
        from_json = self.outputs(items)
        from_text = self.outputs(items, json_randr=False)
        self.assertEqual(from_json, from_text)
        self.assertEqual(from_json[0].transform, "90")
        self.assertEqual((from_json[0].native_mode().width, from_json[0].native_mode().height), (1920, 1080))
        self.assertFalse(from_json[1].enabled)

    def test_zero_one_two_outputs(self):
        self.assertEqual(det.classify_outputs(self.outputs([]))[0], "none")
        kind, output = det.classify_outputs(self.outputs([kfk.output_json("HDMI-A-1")]))
        self.assertEqual((kind, output.name), ("one", "HDMI-A-1"))
        kind, output = det.classify_outputs(self.outputs([kfk.output_json("DSI-1")]))
        self.assertEqual((kind, output.name), ("one", "DSI-1"))
        two = [kfk.output_json("HDMI-A-1"), kfk.output_json("HDMI-A-2")]
        self.assertEqual(det.classify_outputs(self.outputs(two)), ("several", None))

    def test_connector_must_be_hdmi_or_dsi(self):
        for name in ("DPI-1", "Composite-1", "NOOP-1", "HEADLESS-1", "eDP-1", "DP-1", "HDMI-A-10", "HDMI-B-1"):
            self.assertEqual(det.classify_outputs(self.outputs([kfk.output_json(name)])), ("unsupported_connector", None), name)
        # A virtual output beside the panel still counts: kanshi would never match.
        self.assertEqual(det.classify_outputs(self.outputs([kfk.output_json("HDMI-A-1"), kfk.output_json("NOOP-1")]))[0], "several")

    def test_connector_pattern_is_strict(self):
        for good in ("HDMI-A-1", "HDMI-A-2", "DSI-1", "DSI-2"):
            self.assertIsNotNone(det.CONNECTOR_RE.fullmatch(good))
        for bad in ("HDMI-A-1\n", " HDMI-A-1", "HDMI-A-١", "hdmi-a-1", "DSI-0", "DSI-1 "):
            self.assertIsNone(det.CONNECTOR_RE.fullmatch(bad), repr(bad))

    def test_single_switched_off_output(self):
        self.assertEqual(det.classify_outputs(self.outputs([kfk.output_json("HDMI-A-1", enabled=False)])), ("none", None))

    def test_unexpected_json_falls_back_to_plain(self):
        s = pi()
        s.set(["wlr-randr", "--json"], ok(json.dumps({"outputs": "?"})))
        self.assertEqual([o.name for o in det.read_outputs(s, det.find_session(s))], ["HDMI-A-1"])
        self.assertIn(("wlr-randr",), [argv for argv, _ in s.calls])

    def test_strict_json(self):
        good = kfk.output_json()
        for change in (
            {"enabled": "yes"},
            {"name": "HDMI-A-1\n"},
            {"name": "HDMI A 1"},
            {"transform": "45"},
            {"modes": [{"width": "1920", "height": 1080}]},
            {"modes": [{"width": 1920, "height": 1080, "current": 1}]},
            {"modes": {"width": 1920}},
        ):
            item = dict(good, **change)
            with self.assertRaises(ValueError, msg=change):
                det.parse_wlr_randr_json(json.dumps([item]))

    def test_strict_text(self):
        good = kfk.wlr_randr_text([kfk.output_json()])
        self.assertEqual(len(det.parse_wlr_randr_text(good)), 1)
        for bad in (
            good.replace("  Enabled: yes", "  Enabled: maybe"),
            good.replace("  Enabled: yes\n", ""),
            good.replace("  Transform: normal\n", ""),
            good.replace("  Transform: normal", "  Transform: 45"),
            good.replace("    1920x1080 px", "   1920x1080 px"),
            good.replace("    1920x1080 px", "    1920x1080px"),
            good.replace("1920x1080", "١920x1080"),
            "garbage before\n" + good,
            good + "\tstray tab line\n",
            good.replace("  Make:", "  Make:\x00"),
            good + "  Enabled: no\n",
        ):
            with self.assertRaises(ValueError, msg=bad[:80]):
                det.parse_wlr_randr_text(bad)

    def test_wlr_randr_missing_failing_or_garbled(self):
        s = pi()
        s.set(["wlr-randr", "--json"], CommandResult(None, missing=True))
        with self.assertRaises(det.OutputsUnreadable):
            det.read_outputs(s, det.find_session(s))
        s = pi()
        s.set(["wlr-randr", "--json"], ok(rc=1))
        s.set(["wlr-randr"], ok(rc=1))
        with self.assertRaises(det.CannotTell):
            det.read_outputs(s, det.find_session(s))
        s = pi()
        s.set(["wlr-randr", "--json"], ok("{"))
        s.set(["wlr-randr"], ok("HDMI-A-1 \"x\"\n  Enabled: sometimes\n"))
        with self.assertRaises(det.CannotTell):
            det.read_outputs(s, det.find_session(s))

    def test_runs_in_the_desktop_session(self):
        s = pi()
        det.read_outputs(s, det.find_session(s))
        argv, env = s.calls[-1]
        self.assertEqual(argv, ("wlr-randr", "--json"))
        self.assertEqual((env["WAYLAND_DISPLAY"], env["XDG_RUNTIME_DIR"]), ("wayland-0", kfk.RUNTIME))

    def test_connector_kind(self):
        self.assertEqual(det.connector_kind("HDMI-A-2"), "hdmi")
        self.assertEqual(det.connector_kind("DSI-1"), "dsi")
        with self.assertRaises(ValueError):
            det.connector_kind("DPI-1")


class ModeCertaintyTests(unittest.TestCase):
    """The panel's own mode must be known for certain; nothing is assumed."""

    def test_json_needs_every_mode_field(self):
        good = kfk.output_json()
        for change in (
            {"modes": [{"width": 1920, "height": 1080, "preferred": True}]},
            {"modes": [{"width": 1920, "height": 1080, "current": True}]},
        ):
            with self.assertRaises(ValueError, msg=change):
                det.parse_wlr_randr_json(json.dumps([dict(good, **change)]))
        missing = dict(good)
        del missing["modes"]
        with self.assertRaises(ValueError):
            det.parse_wlr_randr_json(json.dumps([missing]))

    def test_native_mode(self):
        def output(*modes):
            return det.Output("HDMI-A-1", True, [det.Mode(w, h, p, c) for w, h, p, c in modes], "normal")

        self.assertEqual(det.transform_for("portrait", output((1920, 1080, True, False), (720, 1280, False, True))), "90")
        self.assertEqual(det.transform_for("portrait", output((720, 1280, False, True), (1920, 1080, False, False))), "normal")
        for modes in ((), ((1920, 1080, False, False),), ((1920, 1080, True, False), (720, 1280, True, False)), ((1920, 1080, False, True), (1280, 720, False, True))):
            with self.assertRaises(det.CannotTell, msg=modes):
                det.transform_for("portrait", output(*modes))

    def test_setup_without_a_known_mode_cannot_tell(self):
        item = kfk.output_json()
        item["modes"] = [dict(m, preferred=False, current=False) for m in item["modes"]]
        s = kfk.KioskPi("/home/pi", outputs=[item])
        output = det.read_outputs(s, det.find_session(s))[0]
        with self.assertRaises(det.CannotTell):
            det.transform_for("portrait", output)


class OrientationTests(unittest.TestCase):
    def test_landscape_panel(self):
        out = det.parse_wlr_randr_json(json.dumps([kfk.output_json(width=1920, height=1080)]))[0]
        got = {o: det.transform_for(o, out) for o in det.ORIENTATIONS}
        self.assertEqual(got, {"portrait": "90", "portrait-flipped": "270", "landscape": "normal", "landscape-flipped": "180"})

    def test_portrait_panel(self):
        out = det.parse_wlr_randr_json(json.dumps([kfk.output_json("DSI-1", width=720, height=1280)]))[0]
        got = {o: det.transform_for(o, out) for o in det.ORIENTATIONS}
        self.assertEqual(got, {"portrait": "normal", "portrait-flipped": "180", "landscape": "90", "landscape-flipped": "270"})

    def test_default_is_portrait(self):
        self.assertEqual(det.DEFAULT_ORIENTATION, "portrait")


class TouchTests(unittest.TestCase):
    def find(self, *devices):
        s = pi()
        s.files["/proc/bus/input/devices"] = "\n".join(devices)
        result = det.find_touch(s)
        self.assertIn(det.INPUT_DEVICES, s.reads)
        return result

    def test_classification(self):
        for text, expected in (
            (kfk.usb_touch(), True),
            (kfk.dsi_touch(), True),
            (kfk.keyboard(), False),
            (kfk.mouse(), False),
            (kfk.touchpad(), False),
            (kfk.pen_tablet(), False),
            (kfk.abs_mouse(), False),
        ):
            devices = det.parse_input_devices(text)
            self.assertEqual(len(devices), 1)
            self.assertEqual(det.is_touchscreen(devices[0]), expected, text)

    def test_no_event_handler_is_not_a_libinput_device(self):
        self.assertEqual(self.find(kfk.device("x", ev=(0, 1, 3), key=(0x14A,), abs_=(0, 1), prop=(1,), handlers="js0")), ("none", None))

    def test_one_touch_among_other_inputs(self):
        self.assertEqual(self.find(kfk.keyboard(), kfk.mouse(), kfk.touchpad(), kfk.usb_touch()), ("one", "ILITEK ILITEK-TP"))

    def test_two_devices_with_the_same_name_are_ambiguous(self):
        self.assertEqual(self.find(kfk.usb_touch(), kfk.usb_touch()), ("several", None))

    def test_ambiguous(self):
        self.assertEqual(self.find(kfk.usb_touch(), kfk.dsi_touch()), ("several", None))

    def test_none(self):
        self.assertEqual(self.find(kfk.keyboard(), kfk.mouse()), ("none", None))
        s = pi()
        del s.files["/proc/bus/input/devices"]  # ENOENT: no input devices at all
        self.assertEqual(det.find_touch(s), ("none", None))

    def test_cannot_tell(self):
        good = kfk.usb_touch()
        for value in (
            PermissionError(13, "denied"),
            OSError(5, "I/O error"),
            b"\xff\xfe" + good.encode(),
            good.replace("B: EV=", "B: EV= "),
            good.replace("B: EV=", "B: XY="),
            good.replace("H: Handlers=", "X: Handlers="),
            good.replace('N: Name="ILITEK ILITEK-TP"\n', ""),
            good.replace("ILITEK", "bad\x1bname"),
            good.replace("B: KEY=", "B: KEY=٤"),
            good + good.split("\n")[1] + "\n",  # two names in one record
            good.replace("P: Phys=usb-xhci-hcd.0-1/input0\n", ""),  # a line the kernel always prints
            "\n".join(line for line in good.split("\n") if not line.startswith("B: PROP")),
            "\n".join(line for line in good.split("\n") if not line.startswith("B: ABS")),  # EV_ABS set, no ABS
            good.rstrip("\n") + "\nB: REL=3\n",  # REL printed without EV_REL
            'N: Name="only a name"\nH: Handlers=event9\n',
        ):
            s = pi()
            s.files["/proc/bus/input/devices"] = value
            with self.assertRaises(det.CannotTell, msg=repr(value)[:60]):
                det.find_touch(s)


class AutologinTests(unittest.TestCase):
    def state(self, text, user="pi", extra=None):
        s = pi()
        s.user = user
        if text is None:
            del s.files["/etc/lightdm/lightdm.conf"]
        else:
            s.files["/etc/lightdm/lightdm.conf"] = text
        s.files.update(extra or {})
        return det.autologin_state(s), s

    def test_states(self):
        self.assertEqual(self.state(kfk.lightdm())[0], "off")
        self.assertEqual(self.state(kfk.lightdm("pi"))[0], "on")
        self.assertEqual(self.state(kfk.lightdm("guest"))[0], "other_user")
        self.assertEqual(self.state(kfk.lightdm(""))[0], "off")
        self.assertEqual(self.state(None)[0], "unknown")

    def test_only_seat_sections_count(self):
        self.assertEqual(self.state("[LightDM]\nautologin-user=pi\n[Seat:*]\n")[0], "off")
        self.assertEqual(self.state("[XDMCPServer]\nautologin-user=pi\n")[0], "off")
        self.assertEqual(self.state("[SeatDefaults]\nautologin-user=pi\n")[0], "on")
        self.assertEqual(self.state("[Seat:*]\nautologin-user=pi\n[Seat:seat0]\nautologin-user=guest\n")[0], "other_user")
        self.assertEqual(self.state("[Seat:seat0]\nautologin-user=pi\n[Seat:*]\nautologin-user=\n")[0], "on")
        self.assertEqual(self.state("[Seat:seat1]\nautologin-user=pi\n")[0], "off")
        self.assertEqual(self.state("[Seat:*]\nautologin-user=guest\n[Seat:seat*]\nautologin-user=pi\n")[0], "on")
        got, _ = self.state("[Seat:*]\n", extra={"/etc/lightdm/lightdm.conf.d/50-old.conf": "[SeatDefaults]\nautologin-user=pi\n"})
        self.assertEqual(got, "on")

    def test_malformed_is_unknown_not_off(self):
        for text in (
            "autologin-user=pi\n[Seat:*]\n",  # a key before any section
            "[Seat:*]\nthis is not a setting\n",
            "[Seat:*\nautologin-user=pi\n",
            "[Seat:*]\n=pi\n",
            b"\xff[Seat:*]\nautologin-user=pi\n",
            PermissionError(13, "denied"),
        ):
            self.assertEqual(self.state(text)[0], "unknown", repr(text))

    def test_load_order(self):
        # /etc/lightdm/lightdm.conf is read last and wins; conf.d files in name order before it.
        got, s = self.state(
            "[Seat:*]\nautologin-user=pi\n",
            extra={
                "/usr/share/lightdm/lightdm.conf.d/01-defaults.conf": "[Seat:*]\nautologin-user=guest\n",
                "/etc/lightdm/lightdm.conf.d/50-a.conf": "[Seat:*]\nautologin-user=guest\n",
            },
        )
        self.assertEqual(got, "on")
        self.assertEqual(
            [p for p in s.reads if "lightdm" in p],
            ["/usr/share/lightdm/lightdm.conf.d/01-defaults.conf", "/etc/lightdm/lightdm.conf.d/50-a.conf", "/etc/lightdm/lightdm.conf"],
        )
        got, _ = self.state("[Seat:*]\n", extra={"/etc/lightdm/lightdm.conf.d/50-kiosk.conf": "[Seat:*]\nautologin-user=pi\n"})
        self.assertEqual(got, "on")

    def test_unreadable_folder_is_unknown(self):
        s = pi()
        s.files["/etc/lightdm/lightdm.conf.d/50-kiosk.conf"] = "[Seat:*]\n"
        s.list_errors[det.LIGHTDM_CONF_D] = PermissionError(13, "denied")
        self.assertEqual(det.autologin_state(s), "unknown")

    def test_commands(self):
        self.assertEqual(det.AUTOLOGIN_ON, ["sudo", "raspi-config", "nonint", "do_boot_behaviour", "B4"])
        self.assertEqual(det.AUTOLOGIN_OFF, ["sudo", "raspi-config", "nonint", "do_boot_behaviour", "B3"])


class BlankingTests(unittest.TestCase):
    LINE = "swayidle -w timeout 600 'wlopm --off \\*' resume 'wlopm --on \\*' &"

    def test_swayidle_lines(self):
        self.assertTrue(det.is_blanking_line(self.LINE))
        self.assertTrue(det.is_blanking_line("/usr/bin/swayidle -w timeout 300 'wlopm --off *' &"))
        self.assertFalse(det.is_blanking_line("# " + self.LINE))
        self.assertFalse(det.is_blanking_line("/usr/bin/kanshi &"))

    def test_system_wide(self):
        s = pi()
        self.assertIs(det.system_blanking(s), False)
        s.files["/etc/xdg/labwc/autostart"] += self.LINE + "\n"
        self.assertIs(det.system_blanking(s), True)
        del s.files["/etc/xdg/labwc/autostart"]
        self.assertIs(det.system_blanking(s), False)

    def test_cannot_tell(self):
        for value in (PermissionError(13, "denied"), b"\xff\xfe"):
            s = pi()
            s.files["/etc/xdg/labwc/autostart"] = value
            with self.assertRaises(det.CannotTell):
                det.system_blanking(s)


class ManualKioskLineTests(unittest.TestCase):
    def test_detects_chromium_lines(self):
        self.assertTrue(det.launches_chromium("chromium http://localhost:3847 --kiosk --noerrdialogs &"))
        self.assertTrue(det.launches_chromium("/usr/bin/chromium-browser --kiosk http://localhost:3847 &"))
        self.assertFalse(det.launches_chromium("# chromium http://localhost:3847 --kiosk &"))
        self.assertFalse(det.launches_chromium("/usr/bin/lwrespawn /usr/bin/wf-panel-pi &"))


if __name__ == "__main__":
    unittest.main()
