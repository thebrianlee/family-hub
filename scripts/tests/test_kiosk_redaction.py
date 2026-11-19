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

from sproutwall_lib import cli, kiosk, kiosk_files as kf
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
# The allowed values of each --check --json field, written out here on
# purpose instead of imported from kiosk_setup, so a change there cannot
# also change what this test expects.
EXPECTED_VALUES = {
    "result": {"ok", "attention", "not_installed", "unsupported", "unknown"},
    "reason": {"none", "root", "unsupported_os", "no_desktop", "other_desktop", "session", "config_path", "no_chromium", "cannot_tell", "unknown"},
    "installed": {"yes", "no", "damaged", "unknown"},
    "launch": {"on", "off", "duplicate", "none", "unknown"},
    "files": {"as_set_up", "partial", "changed", "none", "unknown"},
    "running": {"yes", "no", "unknown"},
    "output": {"one", "none", "several", "unsupported_connector", "unknown"},
    "orientation": {"portrait", "portrait-flipped", "landscape", "landscape-flipped", "none", "unknown"},
    "rotation": {"applied", "not_applied", "none", "unknown"},
    "touch": {"mapped", "not_mapped", "none", "unknown"},
    "blanking": {"off", "on", "system", "unknown"},
    "autologin": {"on", "off", "other_user", "unknown"},
}
LAUNCHER_FAILED = "sproutwall-kiosk: stopped by an unexpected error.\n"
LAUNCHER_NOT_SET_UP = "sproutwall-kiosk: the kiosk is not set up here. Run ./scripts/sproutwall setup kiosk.\n"
LAUNCHER_UNSAFE = (
    "sproutwall-kiosk: the kiosk's state folder holds a link or a file setup did not make; not starting. "
    "Run ./scripts/sproutwall setup kiosk --check.\n"
)
SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(SCRIPTS)
BOOTSTRAP = os.path.join(SCRIPTS, "sproutwall")
ACTIONS = ([], ["--check"], ["--check", "--json"], ["--off"], ["--check"], [], ["--undo"], ["--undo"], ["--check", "--json"])


class SeededPi(kfk.KioskPi):
    """The fake desktop, with the seed in every input it hands out. stages
    records the steps a run reached that reads and calls do not show."""

    def __init__(self, home):
        super().__init__(home, touch=kfk.usb_touch(TOUCH))
        self.stages = []
        self.user = USER
        self.files["/etc/lightdm/lightdm.conf"] = kfk.lightdm(USER) + "# " + SEED + "\n"
        self.files["/etc/xdg/labwc/rc.xml"] = kfk.SYSTEM_RC.replace("</openbox_config>", "<!-- %s -->\n</openbox_config>" % SEED)
        self.env = {"HOME": home, "USER": USER, "SEED": SEED}
        self.environs[kfk.KANSHI_PID]["SEED"] = SEED
        self.procs.append((990, kfk.UID, "seed", ["/usr/bin/" + USER, SEED, home]))

    def run(self, argv, timeout=15.0, env=None):
        result = super().run(argv, timeout, env)
        return CommandResult(result.rc, result.out, SEED + " " + self.home_dir, result.missing, result.timed_out)

    def euid(self):
        self.stages.append("euid")
        return super().euid()

    def log(self):
        """What the run reached, as plain data (also written by the subprocess harness)."""
        return {"reads": list(self.reads), "calls": [list(argv) for argv, _ in self.calls], "stages": list(self.stages)}


def _crash(system):
    def processes():
        system.stages.append("processes")
        raise RuntimeError(SEED + system.home_dir)

    system.processes = processes


RANDR = ["wlr-randr", "--json"]
INPUT = "/proc/bus/input/devices"
# The seeded fault matrix: (change, what a setup run must have reached, what
# a --check run must have reached). --check never reads the input devices.
SCENARIOS = {
    "two touch inputs": (
        lambda s: s.files.__setitem__(INPUT, kfk.usb_touch(TOUCH) + "\n" + kfk.usb_touch("Quinn B")),
        lambda log: INPUT in log["reads"],
        lambda log: "/etc/lightdm/lightdm.conf" in log["reads"],
    ),
    "no screen": (lambda s: setattr(s, "outputs", []), lambda log: RANDR in log["calls"], lambda log: RANDR in log["calls"]),
    "two screens": (
        lambda s: setattr(s, "outputs", [kfk.output_json("HDMI-A-1"), kfk.output_json("DSI-1")]),
        lambda log: RANDR in log["calls"],
        lambda log: RANDR in log["calls"],
    ),
    "root": (
        lambda s: setattr(s, "euid_value", 0),
        lambda log: log["stages"] == ["euid"] and log["calls"] == [],
        lambda log: log["stages"] == ["euid"] and log["calls"] == [],
    ),
    "unreadable touch": (
        lambda s: s.files.__setitem__(INPUT, PermissionError(13, SEED, s.home_dir)),
        lambda log: INPUT in log["reads"],
        lambda log: "/etc/lightdm/lightdm.conf" in log["reads"],
    ),
    "garbled screens": (
        lambda s: (s.set(RANDR, CommandResult(0, SEED, SEED)), s.set(["wlr-randr"], CommandResult(0, SEED, SEED))),
        lambda log: RANDR in log["calls"],
        lambda log: RANDR in log["calls"],
    ),
    "crash": (_crash, lambda log: "processes" in log["stages"], lambda log: "processes" in log["stages"]),
}
MATRIX_ARGS = ([], ["--check"], ["--check", "--json"])


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
        self.assertEqual(data["schema"], 1)
        for key in EXPECTED_KEYS[1:]:
            self.assertIn(data[key], EXPECTED_VALUES[key], key)


class InProcessTests(Assertions, unittest.TestCase):
    def setUp(self):
        kfk.portable(self)

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
        for name, (change, reached_setup, reached_check) in SCENARIOS.items():
            for args in MATRIX_ARGS:
                with self.subTest(name=name, args=args):
                    home = seeded_home(self)
                    system = SeededPi(home)
                    change(system)
                    before = kfk.tree(home)
                    code, out, err, stray = run_in_process(["setup", "kiosk"] + args, system)
                    self.assertNotEqual(code, 0)
                    self.assert_clean(home, out, err, stray)
                    self.assertEqual(stray, "")
                    self.assertEqual(kfk.tree(home), before)
                    if "--json" in args:
                        self.assert_check_json(out)
                    reached = reached_check if "--check" in args else reached_setup
                    self.assertTrue(reached(system.log()), ("stage not reached", name, args, system.log()))


HARNESS = r'''
import atexit, json, os, sys, logging, warnings
repo, scripts, home, touch, user, seed, boot, scenario, log_file = sys.argv[1:10]
sys.path.insert(0, scripts)
sys.path.insert(0, repo)
logging.basicConfig(level=logging.DEBUG, stream=sys.stderr)
warnings.simplefilter("always")
from scripts.tests import kiosk_fakes as kfk
from scripts.tests.test_kiosk_redaction import SCENARIOS, SeededPi
from sproutwall_lib import kiosk_files as kf
import sproutwall_lib.cli as cli

if kf._renameat2_function() is None:  # as kfk.portable: macOS has no renameat2
    kf.renameat2 = kfk.fake_renameat2
if not hasattr(os, "listxattr"):
    kf._xattrs = lambda fd: ()
made = []


def system():
    pi = SeededPi(home)
    if scenario != "none":
        SCENARIOS[scenario][0](pi)
    made.append(pi)
    return pi


def dump():
    with open(log_file, "w", encoding="utf-8") as handle:
        json.dump([pi.log() for pi in made], handle)


atexit.register(dump)
cli.System = system
sys.argv = [boot] + sys.argv[10:]
import runpy
runpy.run_path(boot, run_name="__main__")
'''


class EndToEndTests(Assertions, unittest.TestCase):
    """The real bootstrap and cli in a subprocess, with the fake desktop as
    its host: the process's real stdout and stderr, a DEBUG root logger on
    stderr and warnings switched on. The files are real, under HOME."""

    def harness(self, home):
        harness = os.path.join(os.path.dirname(os.path.dirname(home)), "harness.py")
        with open(harness, "w", encoding="utf-8") as handle:
            handle.write(HARNESS)
        return harness

    def run_script(self, home, harness, *args, scenario="none"):
        env = dict(os.environ, HOME=home, USER=USER, PYTHONDONTWRITEBYTECODE="1", SEED=SEED)
        self.log_file = os.path.join(os.path.dirname(os.path.dirname(home)), "stages.json")
        if os.path.exists(self.log_file):
            os.unlink(self.log_file)
        proc = subprocess.run(
            [sys.executable, harness, REPO, SCRIPTS, home, TOUCH, USER, SEED, BOOTSTRAP, scenario, self.log_file, "setup", "kiosk"] + list(args),
            env=env,
            cwd=REPO,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
        return proc.returncode, proc.stdout.decode(), proc.stderr.decode()

    def stages(self):
        with open(self.log_file, encoding="utf-8") as handle:
            logs = json.load(handle)
        self.assertEqual(len(logs), 1, "one System per run")
        return logs[0]

    def test_every_action_through_the_bootstrap(self):
        home = seeded_home(self)
        harness = self.harness(home)
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
        log = self.stages()
        self.assertIn(INPUT, log["reads"])
        self.assertIn(RANDR, log["calls"])

    def test_the_fault_matrix_through_the_bootstrap(self):
        """The same seeded faults as InProcessTests, through the real
        bootstrap and cli in a subprocess; each run must reach the step
        whose input it seeds, write nothing and leak nothing."""
        for name, (_change, reached_setup, reached_check) in SCENARIOS.items():
            for args in MATRIX_ARGS:
                with self.subTest(name=name, args=args):
                    home = seeded_home(self)
                    harness = self.harness(home)
                    before = kfk.tree(home)
                    code, out, err = self.run_script(home, harness, *args, scenario=name)
                    self.assertNotEqual(code, 0, (name, args))
                    self.assertNotIn("Traceback", err)
                    self.assert_clean(home, out, err)
                    self.assertEqual(kfk.tree(home), before)
                    if "--json" in args:
                        self.assert_check_json(out)
                    reached = reached_check if "--check" in args else reached_setup
                    log = self.stages()
                    self.assertTrue(reached(log), ("stage not reached", name, args, log))

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


LAUNCHER_HARNESS = r'''
import os, sys, socket, subprocess, time, runpy
launcher, pid_file, mode = sys.argv[1:4]
home = os.environ["HOME"]
os.geteuid = lambda: 1000  # the sandbox may run as root; the launcher refuses root
calls = [0]


def create_connection(address, timeout=None):
    """Never the real port 3847: the hub is not ready, and in crash mode
    the third check fails unexpectedly."""
    calls[0] += 1
    if mode == "crash" and calls[0] >= 3:
        raise RuntimeError("unexpected in " + home)
    raise ConnectionRefusedError(111, "refused at " + home)


socket.create_connection = create_connection
clock = [0.0]


def monotonic():
    clock[0] += 50.0
    return clock[0]


time.monotonic = monotonic
time.sleep = lambda seconds: None
real_isfile, real_access, real_open = os.path.isfile, os.access, os.open
os.path.isfile = lambda p: p.startswith("/usr/bin/chromium") or real_isfile(p)
os.access = lambda p, m: p.startswith("/usr/bin/chromium") or real_access(p, m)
if mode == "unreadable":
    def denied(path, *args, **kwargs):
        if path == "run":
            raise PermissionError(13, "Permission denied", str(path))
        return real_open(path, *args, **kwargs)
    os.open = denied
real_popen = subprocess.Popen


def popen(argv, **kwargs):
    child = real_popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
    with open(pid_file, "a", encoding="utf-8") as handle:
        handle.write("%d\n" % child.pid)
    return child


subprocess.Popen = popen
sys.argv = [launcher]
runpy.run_path(launcher, run_name="__main__")
'''


class LauncherGuardTests(Assertions, unittest.TestCase):
    """The installed launcher, run as its own process with a seeded home
    folder: forced failures give one fixed line, never a traceback, path or
    seeded value, and any Chromium it started is stopped."""

    def setUp(self):
        self.home = seeded_home(self)
        self.launcher = os.path.join(self.home, kiosk.KIOSK_LAUNCHER)
        kfk.write(self.home, kiosk.KIOSK_LAUNCHER, kf.launcher_bytes(), mode=0o755)
        self.state = os.path.join(self.home, kiosk.KIOSK_STATE_DIR)
        for sub in ("run", "browser"):
            os.makedirs(os.path.join(self.state, sub), 0o700)
        for rel, data in (
            ("manifest.json", b"{}"),
            ("setup.lock", b""),
            (os.path.join("run", "launcher.lock"), b""),
            (os.path.join("run", "starting.html"), kf.wait_page_bytes()),
        ):
            kfk.write(self.state, rel, data, mode=0o600)
        self.harness = os.path.join(os.path.dirname(os.path.dirname(self.home)), "launcher_harness.py")
        with open(self.harness, "w", encoding="utf-8") as handle:
            handle.write(LAUNCHER_HARNESS)
        self.pids = os.path.join(os.path.dirname(os.path.dirname(self.home)), "children.txt")

    def run_launcher(self, mode, harness=True):
        argv = [sys.executable, self.harness, self.launcher, self.pids, mode] if harness else [sys.executable, self.launcher]
        proc = subprocess.run(
            argv,
            env=dict(os.environ, HOME=self.home, USER=USER, PYTHONDONTWRITEBYTECODE="1"),
            cwd=self.home,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=120,
            check=False,
        )
        out, err = proc.stdout.decode(), proc.stderr.decode()
        self.assertEqual(out, "")
        self.assertNotIn("Traceback", err)
        self.assert_clean(self.home, out, err)
        return proc.returncode, err

    def children(self):
        if not os.path.exists(self.pids):
            return []
        with open(self.pids, encoding="utf-8") as handle:
            return [int(line) for line in handle if line.strip()]

    def test_state_folder_problems(self):
        import shutil

        shutil.rmtree(os.path.join(self.state, "run"))
        self.assertEqual(self.run_launcher("plain"), (1, LAUNCHER_NOT_SET_UP))
        kfk.write(self.home, os.path.join(kiosk.KIOSK_STATE_DIR, "run"), b"a file, not a folder")
        self.assertEqual(self.run_launcher("plain"), (1, LAUNCHER_UNSAFE))
        os.unlink(os.path.join(self.state, "run"))
        os.symlink(self.home, os.path.join(self.state, "run"))
        self.assertEqual(self.run_launcher("plain"), (1, LAUNCHER_UNSAFE))

    def test_unreadable_run_folder(self):
        self.assertEqual(self.run_launcher("unreadable"), (1, LAUNCHER_FAILED))

    def test_lock_file_error(self):
        os.unlink(os.path.join(self.state, "run", "launcher.lock"))
        os.mkdir(os.path.join(self.state, "run", "launcher.lock"))
        self.assertEqual(self.run_launcher("plain"), (1, LAUNCHER_UNSAFE))
        self.assertEqual(self.children(), [])

    @unittest.skipUnless(kfk.LINUX, "the launcher reads /proc before it starts a browser; " + kfk.LINUX_ONLY)
    def test_a_waiting_page_that_is_not_a_file_is_not_shown(self):
        before = kfk.tree(self.home)
        os.unlink(os.path.join(self.state, "run", "starting.html"))
        os.mkdir(os.path.join(self.state, "run", "starting.html"))
        self.assertEqual(self.run_launcher("crash"), (1, LAUNCHER_FAILED))
        self.assertEqual(self.children(), [])  # no browser for a page setup did not make
        os.rmdir(os.path.join(self.state, "run", "starting.html"))
        kfk.write(self.state, os.path.join("run", "starting.html"), kf.wait_page_bytes(), mode=0o600)
        self.assertEqual(sorted(kfk.tree(self.home)), sorted(before))

    @unittest.skipUnless(kfk.LINUX, "the launcher reads /proc before it starts a browser; " + kfk.LINUX_ONLY)
    def test_a_crash_stops_the_browser_it_started(self):
        before = kfk.tree(self.home)
        self.assertEqual(self.run_launcher("crash"), (1, LAUNCHER_FAILED))
        self.assertEqual(kfk.tree(self.home), before)  # the launcher wrote nothing
        pids = self.children()
        self.assertEqual(len(pids), 1)  # the waiting page's browser was started
        with self.assertRaises(ProcessLookupError):
            os.kill(pids[0], 0)  # and stopped (and reaped) by the guard

    def test_the_real_file_on_this_host(self):
        """No harness: as root it refuses silently; otherwise, with no desktop
        state around it, it says the kiosk is not set up."""
        import shutil

        shutil.rmtree(os.path.join(self.state, "run"))
        code, err = self.run_launcher("plain", harness=False)
        self.assertEqual(code, 1)
        self.assertIn(err, ("", LAUNCHER_NOT_SET_UP))


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
