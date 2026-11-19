"""Spec 4.4 "Must for T1/T2" item 2: doctor redaction canaries.

Fictional names, an iCal URL with a query token, a PIN, an API key and a
cookie are seeded into command stdout and stderr, file contents, exception
messages and the health JSON, on success and failure paths. None may appear
on stdout or stderr, and --json stdout must stay one closed-schema object.
The canaries are assembled from pieces so secret scanners do not flag them.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

from sproutwall_lib import cli, schema
from sproutwall_lib.system import CommandResult, HttpResponse

from . import fakes
from .fakes import HOME, ROOT, healthy_pi

ICAL_TOKEN = "canary" + "icaltoken" + "7q"
API_KEY = "sk-ant-" + "api03-" + "canaryQuinnKey"
COOKIE = "sw_device=" + "canary" + "cookieRiley"
PIN = "482915"
ICAL = "webcal://calendar.example.test/ical/basic.ics?token=" + ICAL_TOKEN
CANARIES = ("Riley", "Quinn", ICAL, ICAL_TOKEN, "?token=", PIN, API_KEY, "canaryQuinnKey", COOKIE, "cookieRiley")
SEED = "household Riley and Quinn; calendar %s; pin %s; key %s; cookie %s" % (ICAL, PIN, API_KEY, COOKIE)

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sproutwall")


def assert_clean(test, out, err, json_mode):
    text = out + err
    for canary in CANARIES:
        test.assertNotIn(canary, text)
        test.assertNotIn(canary.lower(), text.lower())
    if json_mode:
        lines = out.splitlines()
        test.assertEqual(len(lines), 1)
        schema.validate(json.loads(lines[0]))


class SeededSystem(fakes.FakeSystem):
    """Every command also writes the seed to stderr."""

    def run(self, argv, timeout=15.0, env=None):
        result = super().run(argv, timeout, env)
        return CommandResult(result.rc, result.out, SEED, result.missing, result.timed_out)


def seeded_success():
    base = healthy_pi()
    s = SeededSystem()
    s.__dict__.update({k: v for k, v in base.__dict__.items() if k != "calls"})
    s.calls = []
    s.files["/proc/device-tree/model"] = ("Raspberry Pi 5 Model B " + SEED).encode()
    s.files[fakes.COMPOSE] = "# " + SEED + "\n" + fakes.compose_text()
    s.files["/etc/ssh/sshd_config"] = fakes.SSHD_CONFIG + "# AllowUsers Riley Quinn\nBanner /etc/" + ICAL_TOKEN + "\n"
    s.files[HOME + "/.config/labwc/autostart"] += "# " + SEED + "\n"
    mounts = [
        {"Type": "volume", "Name": "sproutwall_familyhub-data", "Source": "/var/lib/Riley", "Destination": "/data", "RW": True},
        {"Type": "bind", "Source": "/home/Quinn/" + ICAL_TOKEN, "Destination": "/photos", "RW": True},
    ]
    s.set(["docker", "inspect", "--type", "container"], CommandResult(0, fakes.container_json(mounts=mounts, env=[SEED]), SEED))
    s.set(["docker", "image", "inspect"], CommandResult(0, fakes.image_json(labels={"riley": SEED}), SEED))
    s.set(["docker", "version", "--format", "{{.Server.Version}}"], CommandResult(0, "27.3.1 " + SEED, SEED))
    s.set(
        ["ip", "-j", "addr", "show"],
        CommandResult(0, json.dumps([{"ifname": "Riley-wlan", "label": SEED, "addr_info": [{"family": "inet", "local": "192.168.1.50", "label": SEED}]}]), ""),
    )
    health = {"ok": True, "version": "0.1.0-preview.0", "schema": 3, "setup": True, "household": "Riley", "calendar": ICAL, "pin": PIN, "key": API_KEY, "cookie": COOKIE}
    s.http_map[("GET", "/api/health")] = HttpResponse(200, json.dumps(health).encode())
    s.http_map[("GET", "/api/modules")] = HttpResponse(401, SEED.encode())
    return s


class FailingSystem(fakes.FakeSystem):
    """Every command fails with the seed; files, which and HTTP raise it."""

    def run(self, argv, timeout=15.0, env=None):
        self.calls.append((tuple(argv), env))
        if argv[0] == "ip":
            raise RuntimeError(SEED)
        return CommandResult(1, SEED, SEED)

    def _file(self, path):
        raise PermissionError(13, SEED, path + SEED)

    def which(self, name, extra_dirs=()):
        raise RuntimeError(SEED)

    def http(self, method, path, body=None, headers=None, timeout=3.0):
        if path == "/api/modules":
            raise OSError(SEED)
        return HttpResponse(503, json.dumps({"ok": False, "code": SEED, "detail": API_KEY}).encode())


class InProcessCanaryTests(unittest.TestCase):
    def run_all(self, make_system, expect_codes):
        for phase in schema.PHASES:
            for tier in schema.TIERS:
                for json_mode in (True, False):
                    argv = ["doctor", "--phase", phase, "--tier", tier] + (["--json"] if json_mode else [])
                    out, err = io.StringIO(), io.StringIO()
                    code = cli.main(argv, system=make_system(), root=ROOT, out=out, err=err)
                    self.assertIn(code, expect_codes, argv)
                    assert_clean(self, out.getvalue(), err.getvalue(), json_mode)

    def test_success_path(self):
        self.run_all(seeded_success, (0, 2))

    def test_failure_path(self):
        self.run_all(FailingSystem, (1,))

    def test_verify_image_paths(self):
        from sproutwall_lib import verify_image as vi

        for gh_result in (CommandResult(0, SEED, SEED), CommandResult(1, SEED, SEED), CommandResult(None, timed_out=True)):
            s = fakes.FakeSystem()
            s.files[fakes.COMPOSE] = "# " + SEED + "\n" + fakes.compose_text()
            s.set(["gh", "--version"], CommandResult(0, "gh version 2.89.0 (2026-03-26)\n", SEED))
            s.set(["gh", "attestation", "verify"], gh_result)
            out, err = io.StringIO(), io.StringIO()
            original = vi.attestation.fetch_bundles
            vi.attestation.fetch_bundles = lambda digest, opener=None: [{"seed": SEED}]
            try:
                cli.main(["verify-image", "--source-sha", fakes.SOURCE_SHA], system=s, root=ROOT, out=out, err=err)
            finally:
                vi.attestation.fetch_bundles = original
            assert_clean(self, out.getvalue(), err.getvalue(), False)


class EndToEndCanaryTests(unittest.TestCase):
    """The real script, real subprocesses: fake docker, ip, systemctl, dpkg
    and gh on PATH print the seed and fail; HOME holds seeded files; the
    environment holds seeded variables."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        bin_dir = os.path.join(root, "bin")
        home = os.path.join(root, "home")
        os.makedirs(bin_dir)
        os.makedirs(os.path.join(home, ".config", "labwc"))
        os.makedirs(os.path.join(home, ".codex"))
        with open(os.path.join(home, ".config", "labwc", "autostart"), "w", encoding="utf-8") as handle:
            handle.write("# " + SEED + "\n")
        tool = "#!%s\nimport sys\nsys.stdout.write(%r)\nsys.stderr.write(%r)\nsys.exit(1)\n" % (sys.executable, SEED, SEED)
        for name in ("docker", "ip", "systemctl", "dpkg", "gh"):
            path = os.path.join(bin_dir, name)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(tool)
            os.chmod(path, 0o755)
        self.env = dict(os.environ)
        self.env.update(
            {
                "PATH": bin_dir + os.pathsep + os.environ.get("PATH", ""),
                "HOME": home,
                "GH_TOKEN": API_KEY,
                "SPROUTWALL_DB": "/data/Riley.db",
                "ICAL_URL": ICAL,
                "PYTHONDONTWRITEBYTECODE": "1",
            }
        )

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args):
        proc = subprocess.run(
            [sys.executable, SCRIPT] + list(args),
            env=self.env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
        return proc.returncode, proc.stdout.decode(), proc.stderr.decode()

    def test_doctor_json_and_human(self):
        for phase in schema.PHASES:
            code, out, err = self.run_script("doctor", "--json", "--phase", phase, "--tier", "B")
            self.assertIn(code, (1, 2))
            assert_clean(self, out, err, True)
            self.assertEqual(err, "")
            code, out, err = self.run_script("doctor", "--phase", phase)
            assert_clean(self, out, err, False)

    def test_bad_arguments(self):
        code, out, err = self.run_script("doctor", "--json", "--phase", "Riley", "--pin", PIN)
        self.assertEqual(code, 2)
        assert_clean(self, out, err, True)
        code, out, err = self.run_script("verify-image", "--source-sha", ICAL_TOKEN, "--bundle", "/tmp/Quinn")
        self.assertEqual(code, 2)
        assert_clean(self, out, err, False)

    def test_verify_image_refuses_the_committed_placeholder(self):
        code, out, err = self.run_script("verify-image", "--source-sha", fakes.SOURCE_SHA)
        self.assertEqual(code, 2)
        self.assertIn("placeholder", err)
        assert_clean(self, out, err, False)


if __name__ == "__main__":
    unittest.main()
