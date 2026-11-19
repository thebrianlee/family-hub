"""A fake Raspberry Pi OS desktop for `setup kiosk` tests.

System files (/etc, /proc), the process table, wlr-randr and signals are
fakes; the user's own files live in a real temporary home folder. Only the
fictional sample household is used.
"""

import json
import os
import re
import signal
import tempfile

from .fakes import FakeSystem, ok

UID = 1000
LABWC_PID = 900
KANSHI_PID = 950
RUNTIME = "/run/user/%d" % UID

# /etc/xdg/labwc/autostart and the touch entries of /etc/xdg/labwc/rc.xml as
# raspberrypi-ui/raspberrypi-ui-mods ships them.
SYSTEM_AUTOSTART = (
    "/usr/bin/lwrespawn /usr/bin/pcmanfm --desktop --profile LXDE-pi &\n"
    "/usr/bin/lwrespawn /usr/bin/wf-panel-pi &\n"
    "/usr/bin/kanshi &\n"
    "/usr/bin/lxsession-xdg-autostart\n"
)
SYSTEM_RC = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<openbox_config xmlns="http://openbox.org/3.4/rc">\n'
    "  <theme><name>PiXflat</name></theme>\n"
    '  <touch deviceName="10-0038 generic ft5x06 (79)" mapToOutput="DSI-1" mouseEmulation="yes" />\n'
    '  <touch deviceName="11-0038 generic ft5x06 (79)" mapToOutput="DSI-2" mouseEmulation="yes" />\n'
    "</openbox_config>\n"
)
LIGHTDM_OFF = "[LightDM]\n\n[Seat:*]\ngreeter-session=pi-greeter-labwc\nuser-session=LXDE-pi-labwc\n#autologin-user=\n"


def lightdm(user=None):
    return LIGHTDM_OFF if user is None else LIGHTDM_OFF.replace("#autologin-user=", "autologin-user=" + user)


# --- /proc/bus/input/devices ---------------------------------------------------------


def bitmap(*bits):
    """The kernel's text for a bitmap with these bits set (64-bit words, high first)."""
    value = 0
    for bit in bits:
        value |= 1 << bit
    words = []
    while True:
        words.append(value & ((1 << 64) - 1))
        value >>= 64
        if not value:
            break
    return " ".join("%x" % word for word in reversed(words))


def device(name, ev=(), key=(), abs_=(), rel=(), prop=(), handlers="event5"):
    lines = [
        "I: Bus=0003 Vendor=222a Product=0001 Version=0110",
        'N: Name="%s"' % name,
        "P: Phys=usb-xhci-hcd.0-1/input0",
        "S: Sysfs=/devices/platform/axi/usb/input/input5",
        "U: Uniq=",
        "H: Handlers=%s" % handlers,
        "B: PROP=%s" % bitmap(*prop),
        "B: EV=%s" % bitmap(*ev),
    ]
    if key:
        lines.append("B: KEY=%s" % bitmap(*key))
    if rel:
        lines.append("B: REL=%s" % bitmap(*rel))
    if abs_:
        lines.append("B: ABS=%s" % bitmap(*abs_))
    return "\n".join(lines) + "\n"


EV_SYN, EV_KEY, EV_REL, EV_ABS, EV_MSC = 0, 1, 2, 3, 4
MT = (0x2F, 0x35, 0x36, 0x39)  # slot, position x/y, tracking id


def usb_touch(name="ILITEK ILITEK-TP"):
    """A USB HID multitouch panel (the usual HDMI touch screen)."""
    return device(name, ev=(EV_SYN, EV_KEY, EV_ABS), key=(0x14A,), abs_=(0, 1) + MT, prop=(1,), handlers="mouse0 event5")


def dsi_touch(name="10-0038 generic ft5x06 (79)"):
    return device(name, ev=(EV_SYN, EV_KEY, EV_ABS), key=(0x14A,), abs_=(0, 1) + MT, prop=(1,), handlers="event4")


def keyboard(name="Sample USB Keyboard"):
    return device(name, ev=(EV_SYN, EV_KEY, EV_MSC), key=tuple(range(1, 100)), handlers="sysrq kbd event2")


def mouse(name="Sample USB Mouse"):
    return device(name, ev=(EV_SYN, EV_KEY, EV_REL), key=(0x110, 0x111, 0x112), rel=(0, 1, 8), handlers="mouse1 event3")


def touchpad(name="Sample Touchpad"):
    return device(name, ev=(EV_SYN, EV_KEY, EV_ABS), key=(0x110, 0x145, 0x14A), abs_=(0, 1) + MT, prop=(0, 2), handlers="mouse2 event6")


def pen_tablet(name="Sample Pen Tablet"):
    return device(name, ev=(EV_SYN, EV_KEY, EV_ABS), key=(0x140, 0x14A, 0x14B), abs_=(0, 1, 0x18), handlers="event7")


def abs_mouse(name="Sample Absolute Mouse"):
    return device(name, ev=(EV_SYN, EV_KEY, EV_ABS), key=(0x110, 0x111), abs_=(0, 1), handlers="mouse3 event8")


# --- wlr-randr ---------------------------------------------------------------------------


def output_json(name="HDMI-A-1", enabled=True, width=1920, height=1080, transform="normal"):
    return {
        "name": name,
        "description": "Sample Display Co. Kitchen 24 (%s)" % name,
        "make": "Sample Display Co.",
        "model": "Kitchen 24",
        "serial": "0000",
        "physical_size": {"width": 530, "height": 300},
        "enabled": enabled,
        "modes": [
            {"width": width, "height": height, "refresh": 60.0, "preferred": True, "current": enabled},
            {"width": 1280, "height": 720, "refresh": 60.0, "preferred": False, "current": False},
        ],
        "position": {"x": 0, "y": 0},
        "transform": transform,
        "scale": 1.0,
        "adaptive_sync": False,
    }


def wlr_randr_text(outputs):
    lines = []
    for item in outputs:
        lines.append('%s "%s"' % (item["name"], item["description"]))
        lines.append("  Make: %s" % item["make"])
        lines.append("  Physical size: 530x300 mm")
        lines.append("  Enabled: %s" % ("yes" if item["enabled"] else "no"))
        lines.append("  Modes:")
        for mode in item["modes"]:
            flags = [f for f in ("preferred", "current") if mode[f]]
            suffix = " (%s)" % ", ".join(flags) if flags else ""
            lines.append("    %dx%d px, %f Hz%s" % (mode["width"], mode["height"], mode["refresh"], suffix))
        if item["enabled"]:
            lines.append("  Position: 0,0")
            lines.append("  Transform: %s" % item["transform"])
            lines.append("  Scale: 1.000000")
    return "\n".join(lines) + "\n"


class KioskPi(FakeSystem):
    """Raspberry Pi OS 64-bit Desktop, labwc -m session with kanshi, one screen.

    kanshi's SIGHUP is simulated: the transform of the first matching
    profile in the user's kanshi config becomes the live transform.
    """

    def __init__(self, home, outputs=None, touch=None, json_randr=True):
        super().__init__()
        self.home_dir = home
        self.uid_value = self.euid_value = UID
        self.set(["dpkg", "--print-architecture"], ok("arm64\n"))
        self.files["/etc/rpi-issue"] = "Raspberry Pi reference 2026-10-01\n"
        self.files["/proc/device-tree/model"] = b"Raspberry Pi 5 Model B Rev 1.1\x00"
        self.files["/usr/bin/chromium"] = b"#!/bin/sh\n"
        self.executables.add("/usr/bin/chromium")
        self.reads = []
        self.procs = [
            (1, 0, "systemd", ["/sbin/init"]),
            (700, 0, "lightdm", ["/usr/sbin/lightdm"]),
            (LABWC_PID, UID, "labwc", ["/usr/bin/labwc", "-m"]),
            (KANSHI_PID, UID, "kanshi", ["/usr/bin/kanshi"]),
            (960, UID, "wf-panel-pi", ["/usr/bin/wf-panel-pi"]),
        ]
        self.environs[KANSHI_PID] = {
            "LABWC_PID": str(LABWC_PID),
            "WAYLAND_DISPLAY": "wayland-0",
            "XDG_RUNTIME_DIR": RUNTIME,
            "HOME": home,
        }
        self.files[RUNTIME + "/wayland-0"] = b""  # a socket: stat says "not a folder"
        self.files["/etc/xdg/labwc/autostart"] = SYSTEM_AUTOSTART
        self.files["/etc/xdg/labwc/rc.xml"] = SYSTEM_RC
        self.files["/etc/lightdm/lightdm.conf"] = LIGHTDM_OFF
        self.files["/proc/bus/input/devices"] = keyboard() + "\n" + mouse() + "\n" + (touch if touch is not None else usb_touch())
        self.outputs = [output_json()] if outputs is None else outputs
        self.json_randr = json_randr
        self.set(["wlr-randr", "--json"], self._randr_json)
        self.set(["wlr-randr"], self._randr_text)

    def read_bytes(self, path):
        self.reads.append(path)
        return super().read_bytes(path)

    def probe(self, path):
        self.probes = getattr(self, "probes", [])
        self.probes.append(path)
        return super().probe(path)

    def _randr_json(self, key, env):
        if not self.json_randr:
            return ok("", "wlr-randr: unrecognized option '--json'\n", rc=1)
        return ok(json.dumps(self.outputs))

    def _randr_text(self, key, env):
        if key != ("wlr-randr",):
            return ok("", "", rc=1)
        return ok(wlr_randr_text(self.outputs))

    def kill(self, pid, sig):
        super().kill(pid, sig)
        if pid == KANSHI_PID and sig == signal.SIGHUP:
            path = os.path.join(self.home_dir, ".config", "kanshi", "config")
            try:
                with open(path, encoding="utf-8") as handle:
                    text = handle.read()
            except FileNotFoundError:
                text = ""
            names = [o["name"] for o in self.outputs]
            for body in re.findall(r"profile[^{]*\{([^}]*)\}", text):
                outs = re.findall(r"output (\S+)(?: enable)?(?: transform (\S+))?", body)
                if sorted(n for n, _ in outs) == sorted(names):
                    for name, transform in outs:
                        for item in self.outputs:
                            if item["name"] == name:
                                item["transform"] = transform or "normal"
                    break
            else:
                for item in self.outputs:
                    item["transform"] = "normal"
        return True


def temp_home(test, name="home"):
    tmp = tempfile.TemporaryDirectory()
    test.addCleanup(tmp.cleanup)
    home = os.path.join(tmp.name, name)
    os.makedirs(home)
    return home


def tree(root):
    """{relative path: (kind, mode, bytes or link target)} for everything under root."""
    found = {}
    for base, dirs, files in os.walk(root):
        for name in dirs + files:
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root)
            st = os.lstat(path)
            if os.path.islink(path):
                found[rel] = ("link", 0, os.readlink(path))
            elif os.path.isdir(path):
                found[rel] = ("dir", st.st_mode & 0o7777, None)
            else:
                with open(path, "rb") as handle:
                    found[rel] = ("file", st.st_mode & 0o7777, handle.read())
    return found


def write(home, rel, data, mode=0o644):
    path = os.path.join(home, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data if isinstance(data, bytes) else data.encode("utf-8"))
    os.chmod(path, mode)
    return path


def read(home, rel):
    path = os.path.join(home, rel)
    if not os.path.exists(path):
        return None
    with open(path, "rb") as handle:
        return handle.read()
