"""setup kiosk redaction canaries, in the style of test_redaction.py.

A fictional user name, a home path, a touch device name and connector names
are seeded into the home folder, lightdm, the process environment, file
contents, command output and stderr, and exception messages. Every kiosk
subcommand runs in process (with the real process streams, a DEBUG root
logger and warnings captured) and end to end through the real
scripts/sproutwall bootstrap in a subprocess. None of the seeded values may
appear anywhere, and each scenario asserts that it reached the step whose
input it seeds. The expected JSON keys are written out here, not imported.
"""

import contextlib
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import unittest
import warnings

from sproutwall_lib import cli, kiosk
from sproutwall_lib.system import CommandResult

from . import kiosk_fakes as kfk
from .fakes import ROOT

USER = "Riley" + "canaryuser"
TOUCH = "canary" + "touch Quinn Panel"
SEED = "seed for %s and Quinn, %s" % (USER, TOUCH)
CONNECTORS = ("HDMI-A-1", "HDMI-A-2", "DSI-1", "DSI-2")
EXPECTED_KEYS = [
    "schema", "result", "reason", "installed", "launch", "files", "running",
    "output", "orientation", "rotation", "touch", "blanking", "autologin",
]
SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(SCRIPTS)
BOOTSTRAP = os.path.join(SCRIPTS, "sproutwall")
ACTIONS = ([], ["--check"], ["--check", "--json"], ["--off"], ["--check"], [], ["--undo"], ["--undo"], ["--check", "--json"])


class SeededPi(kfk.KioskPi):
    """The fake desktop, with the seed in every input it hands out."""

    def __init__(self, home):
        super().__init__(home, touch=kfk.usb_touch(TOUCH))
        self.user = USER
        self.files["/etc/lightdm/lightdm.conf"] = kfk.lightdm(USER) + "# " + SEED + "\n"
        self.files["/etc/xdg/labwc/rc.xml"] = kfk.SYSTEM_RC.replace("</openbox_config>", "<!-- %s -->\n</openbox_config>" % SEED)
        self.env = {"HOME": home, "USER": USER, "SEED": SEED}
        self.environs[kfk.KANSHI_PID]["SEED"] = SEED
        self.procs.append((990, kfk.UID, "seed", ["/usr/bin/" + USER, SEED, home]))

    def run(self, argv, timeout=15.0, env=None):
        result = super().run(argv, timeout, env)
        return CommandResult(result.rc, result.out, SEED + " " + self.home_dir, result.missing, result.timed_out)


def seeded_home(test):
    tmp = tempfile.TemporaryDirectory()
    test.addCleanup(tmp.cleanup)
    home = os.path.join(tmp.name, "canary" + "home", USER)
    os.makedirs(home)
    kfk.write(home, kiosk.KIOSK_AUTOSTART, "# %s's tablet %s\nswayidle -w timeout 600 'wlopm --off \\*' &\n" % (USER, SEED))
    kfk.write(home, kiosk.KIOSK_RC_XML, '<openbox_config xmlns="http://openbox.org/3.4/rc"><!-- %s --></openbox_config>\n' % SEED)
    return home


def canaries(home):
    return (USER, "Riley", "Quinn", "canary", TOUCH, SEED, home) + CONNECTORS


def run_in_process(argv, system):
    out, err = io.StringIO(), io.StringIO()
    stray_out, stray_err, log = io.StringIO(), io.StringIO(), io.StringIO()
    handler = logging.StreamHandler(log)
    handler.setLevel(logging.DEBUG)
    root_logger = logging.getLogger()
    old_level = root_logger.level
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.DEBUG)
    try:
        with warnings.catch_warnings(record=True) as caught, contextlib.redirect_stdout(stray_out), contextlib.redirect_stderr(stray_err):
            warnings.simplefilter("always")
            code = cli.main(argv, system=system, root=ROOT, out=out, err=err)
    finally:
        root_logger.removeHandler(handler)
        root_logger.setLevel(old_level)
    stray = stray_out.getvalue() + stray_err.getvalue() + log.getvalue() + "".join(str(w.message) for w in caught)
    return code, out.getvalue(), err.getvalue(), stray


class Assertions:
    def assert_clean(self, home, *texts):
        joined = "\n".join(texts)
        for canary in canaries(home):
            self.assertNotIn(canary.lower(), joined.lower(), canary)

    def assert_check_json(self, out):
        lines = out.splitlines()
        self.assertEqual(len(lines), 1)
        data = json.loads(lines[0])
        self.assertEqual(list(data), EXPECTED_KEYS)
        self.assertIs(type(data["schema"]), int)
        for key in EXPECTED_KEYS[1:]:
            self.assertRegex(data[key], r"\A[a-z_-]{1,24}\Z")


class InProcessTests(Assertions, unittest.TestCase):
    def test_every_action(self):
        home = seeded_home(self)
        system = SeededPi(home)
        for args in ACTIONS:
            code, out, err, stray = run_in_process(["setup", "kiosk"] + args, system)
            self.assertIn(code, (0, 1), (args, err))
            self.assert_clean(home, out, err, stray)
            self.assertEqual(stray, "", "nothing outside the given streams, no log record, no warning")
            if "--json" in args:
                self.assert_check_json(out)
        # The runs reached the seeded inputs: the session, the screens, the
        # touch file, lightdm, and the files they wrote and removed.
        self.assertIn(("wlr-randr", "--json"), [argv for argv, _ in system.calls])
        for path in ("/proc/bus/input/devices", "/etc/lightdm/lightdm.conf", "/etc/xdg/labwc/rc.xml"):
            self.assertIn(path, system.reads)
        self.assertIn((kfk.KANSHI_PID, 1), system.kills)  # SIGHUP after setup and undo
        self.assertFalse(os.path.exists(os.path.join(home, kiosk.KIOSK_STATE_DIR)))

    def test_refusals_and_failures(self):
        scenarios = {
            "two touch inputs": lambda s: s.files.__setitem__("/proc/bus/input/devices", kfk.usb_touch(TOUCH) + "\n" + kfk.usb_touch("Quinn B")),
            "no screen": lambda s: setattr(s, "outputs", []),
            "two screens": lambda s: setattr(s, "outputs", [kfk.output_json("HDMI-A-1"), kfk.output_json("DSI-1")]),
            "root": lambda s: setattr(s, "euid_value", 0),
            "unreadable touch": lambda s: s.files.__setitem__("/proc/bus/input/devices", PermissionError(13, SEED, s.home_dir)),
            "garbled screens": lambda s: (s.set(["wlr-randr", "--json"], CommandResult(0, SEED, SEED)), s.set(["wlr-randr"], CommandResult(0, SEED, SEED))),
            "crash": lambda s: setattr(s, "processes", lambda: (_ for _ in ()).throw(RuntimeError(SEED + s.home_dir))),
        }
        for name, change in scenarios.items():
            for args in ([], ["--check"], ["--check", "--json"]):
                with self.subTest(name=name, args=args):
                    home = seeded_home(self)
                    system = SeededPi(home)
                    change(system)
                    code, out, err, stray = run_in_process(["setup", "kiosk"] + args, system)
                    self.assertNotEqual(code, 0)
                    self.assert_clean(home, out, err, stray)
                    self.assertEqual(stray, "")
                    if "--json" in args:
                        self.assert_check_json(out)


HARNESS = r'''
import os, sys, logging, warnings
repo, scripts, home, touch, user, seed, boot = sys.argv[1:8]
sys.path.insert(0, scripts)
sys.path.insert(0, repo)
logging.basicConfig(level=logging.DEBUG, stream=sys.stderr)
warnings.simplefilter("always")
from scripts.tests import kiosk_fakes as kfk
from scripts.tests.test_kiosk_redaction import SeededPi
import sproutwall_lib.cli as cli
cli.System = lambda: SeededPi(home)
sys.argv = [boot] + sys.argv[8:]
import runpy
runpy.run_path(boot, run_name="__main__")
'''


class EndToEndTests(Assertions, unittest.TestCase):
    """The real bootstrap and cli in a subprocess, with the fake desktop as
    its host: the process's real stdout and stderr, a DEBUG root logger on
    stderr and warnings switched on. The files are real, under HOME."""

    def run_script(self, home, harness, *args):
        env = dict(os.environ, HOME=home, USER=USER, PYTHONDONTWRITEBYTECODE="1", SEED=SEED)
        proc = subprocess.run(
            [sys.executable, harness, REPO, SCRIPTS, home, TOUCH, USER, SEED, BOOTSTRAP, "setup", "kiosk"] + list(args),
            env=env,
            cwd=REPO,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
        return proc.returncode, proc.stdout.decode(), proc.stderr.decode()

    def test_every_action_through_the_bootstrap(self):
        home = seeded_home(self)
        harness = os.path.join(os.path.dirname(os.path.dirname(home)), "harness.py")
        with open(harness, "w", encoding="utf-8") as handle:
            handle.write(HARNESS)
        results = []
        for args in ACTIONS:
            code, out, err = self.run_script(home, harness, *args)
            results.append(code)
            self.assertIn(code, (0, 1), (args, err))
            self.assert_clean(home, out, err)
            if "--json" in args:
                self.assert_check_json(out)
        self.assertEqual(results[0], 0)
        # Setup reached the files: the launcher was installed by the first run
        # and the last --undo removed it again.
        self.assertFalse(os.path.exists(os.path.join(home, kiosk.KIOSK_LAUNCHER)))
        code, out, err = self.run_script(home, harness)
        self.assertEqual(code, 0, err)
        self.assertTrue(os.path.exists(os.path.join(home, kiosk.KIOSK_LAUNCHER)))

    def test_the_real_host_refuses_cleanly(self):
        """No fake at all: this machine is not a Raspberry Pi OS desktop
        session (or runs as root), so --check refuses and writes nothing."""
        home = seeded_home(self)
        before = kfk.tree(home)
        env = dict(os.environ, HOME=home, USER=USER, PYTHONDONTWRITEBYTECODE="1")
        for args in (["--check"], ["--check", "--json"], [], ["--off"], ["--undo"]):
            proc = subprocess.run(
                [sys.executable, BOOTSTRAP, "setup", "kiosk"] + args,
                env=env, cwd=REPO, stdin=subprocess.DEVNULL, capture_output=True, timeout=120, check=False,
            )
            out, err = proc.stdout.decode(), proc.stderr.decode()
            self.assertIn(proc.returncode, (0, 1, 3, 6), (args, err))
            self.assert_clean(home, out, err)
            if "--json" in args:
                self.assert_check_json(out)
        self.assertEqual(kfk.tree(home), before)


class BootstrapFallbackTests(unittest.TestCase):
    """scripts/sproutwall's own fallback for `setup kiosk`, when the library
    cannot even be imported: the kiosk object with every value unknown, or
    a fixed line that does not claim nothing was changed."""

    def test_constants_match_the_library(self):
        from sproutwall_lib import kiosk_setup as ks

        from .test_bootstrap import load_bootstrap

        boot = load_bootstrap()
        self.assertEqual(boot._KIOSK_FAILED, ks.FAILED + "\n")
        self.assertEqual(list(boot._KIOSK_FIELDS), [key for key, _ in ks.CHECK_FIELDS])
        self.assertEqual(boot._fallback_json(["setup", "kiosk", "--check", "--json"]), ks.fallback_json())
        self.assertNotIn("Nothing was changed", ks.FAILED)

    def test_broken_library(self):
        import shutil

        from .test_bootstrap import BROKEN_LIBS, SECRET_PATH

        for name, source in BROKEN_LIBS.items():
            for json_mode in (True, False):
                with self.subTest(name=name, json_mode=json_mode), tempfile.TemporaryDirectory() as tmp:
                    shutil.copy(BOOTSTRAP, os.path.join(tmp, "sproutwall"))
                    lib = os.path.join(tmp, "sproutwall_lib")
                    os.mkdir(lib)
                    with open(os.path.join(lib, "__init__.py"), "w", encoding="utf-8") as handle:
                        handle.write("")
                    with open(os.path.join(lib, "cli.py"), "w", encoding="utf-8") as handle:
                        handle.write(source)
                    args = ["setup", "kiosk", "--check"] + (["--json"] if json_mode else [])
                    proc = subprocess.run(
                        [sys.executable, os.path.join(tmp, "sproutwall")] + args,
                        env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
                        stdin=subprocess.DEVNULL, capture_output=True, timeout=60, check=False,
                    )
                    out, err = proc.stdout.decode(), proc.stderr.decode()
                    self.assertEqual(proc.returncode, 2)
                    for leak in (SECRET_PATH, "canary", "Traceback", tmp):
                        self.assertNotIn(leak, out + err)
                    if json_mode:
                        self.assertEqual(json.loads(out), dict({"schema": 1}, **{k: "unknown" for k in EXPECTED_KEYS[1:]}))
                        self.assertEqual(err, "")
                    else:
                        self.assertEqual(out, "")
                        self.assertEqual(
                            err,
                            "sproutwall: setup kiosk stopped by an unexpected error. "
                            "Run ./scripts/sproutwall setup kiosk --check to see what is in place.\n",
                        )


if __name__ == "__main__":
    unittest.main()
