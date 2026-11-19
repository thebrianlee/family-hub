"""scripts/sproutwall is a bootstrap that redacts before anything can fail.

A broken import, a crash, a text exit code, a warning or a thread failure
must never reach the terminal as a traceback, path or message. With --json,
stdout is exactly one closed-schema object (exit 2)."""

import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from sproutwall_lib import schema, text

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOTSTRAP = os.path.join(SCRIPTS, "sproutwall")
SECRET_PATH = "/home/Riley/.config/" + "canary" + "token"


def load_bootstrap():
    loader = importlib.machinery.SourceFileLoader("sproutwall_bootstrap", BOOTSTRAP)
    spec = importlib.util.spec_from_loader("sproutwall_bootstrap", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


BROKEN_LIBS = {
    "import error": "raise ImportError('cannot import name x from %s')\n" % SECRET_PATH,
    "syntax error": "def main(argv:\n    pass  # %s\n" % SECRET_PATH,
    "crash in main": "def main(argv):\n    raise RuntimeError('%s')\n" % SECRET_PATH,
    "text exit code": "import sys\ndef main(argv):\n    sys.exit('%s')\n" % SECRET_PATH,
    "thread crash": (
        "import threading\n"
        "def main(argv):\n"
        "    t = threading.Thread(target=lambda: 1 / 0, name='%s')\n"
        "    t.start()\n"
        "    t.join()\n"
        "    return 0\n" % SECRET_PATH
    ),
}


class BootstrapTests(unittest.TestCase):
    def test_fallback_matches_the_library(self):
        boot = load_bootstrap()
        self.assertEqual(boot._CHECK_IDS, schema.CHECK_IDS)
        self.assertEqual(boot._PHASES, schema.PHASES)
        self.assertEqual(boot._FAILED, text.FAILED + "\n")
        for argv in ([], ["doctor", "--json", "--phase", "final"], ["--phase=configured"], ["--phase", "Riley"]):
            from sproutwall_lib.cli import fallback_json

            self.assertEqual(boot._fallback_json(argv), fallback_json(argv), argv)

    def run_with_lib(self, cli_source, args, extra_files=None):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(BOOTSTRAP, os.path.join(tmp, "sproutwall"))
            lib = os.path.join(tmp, "sproutwall_lib")
            os.mkdir(lib)
            with open(os.path.join(lib, "__init__.py"), "w", encoding="utf-8") as handle:
                handle.write("")
            with open(os.path.join(lib, "cli.py"), "w", encoding="utf-8") as handle:
                handle.write(cli_source)
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
            proc = subprocess.run(
                [sys.executable, os.path.join(tmp, "sproutwall")] + args,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
                check=False,
            )
            return proc.returncode, proc.stdout.decode(), proc.stderr.decode(), tmp

    def assert_clean_stderr(self, err, tmp):
        for leak in ("Traceback", "Error", SECRET_PATH, "canary", tmp, SCRIPTS, 'File "'):
            self.assertNotIn(leak, err)

    def test_broken_library_with_json(self):
        for name, source in BROKEN_LIBS.items():
            code, out, err, tmp = self.run_with_lib(source, ["doctor", "--json", "--phase", "configured"])
            self.assertEqual(code, 2, name)
            lines = out.splitlines()
            self.assertEqual(len(lines), 1, name)
            report = json.loads(lines[0])
            schema.validate(report)
            self.assertEqual(report, schema.fallback_report("configured"), name)
            self.assertEqual(err, "", name)
            self.assertNotIn("canary", out)

    def test_broken_library_without_json(self):
        for name, source in BROKEN_LIBS.items():
            code, out, err, tmp = self.run_with_lib(source, ["doctor", "--phase", "running"])
            self.assertEqual(code, 2, name)
            self.assertEqual(out, "", name)
            self.assertEqual(err, text.FAILED + "\n", name)
            self.assert_clean_stderr(err, tmp)

    def test_missing_library(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(BOOTSTRAP, os.path.join(tmp, "sproutwall"))
            proc = subprocess.run(
                [sys.executable, os.path.join(tmp, "sproutwall"), "doctor", "--json", "--phase", "Quinn"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False,
            )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout.decode()), schema.fallback_report("running"))
        self.assertEqual(proc.stderr, b"")

    def test_warnings_are_silenced_and_integer_exit_codes_kept(self):
        source = (
            "import sys, warnings\n"
            "warnings.warn('%s')\n"
            "def main(argv):\n"
            "    warnings.warn('again %s')\n"
            "    sys.stdout.write('ok\\n')\n"
            "    raise SystemExit(3)\n" % (SECRET_PATH, SECRET_PATH)
        )
        code, out, err, tmp = self.run_with_lib(source, ["doctor", "--phase", "running"])
        self.assertEqual((code, out, err), (3, "ok\n", ""))


if __name__ == "__main__":
    unittest.main()
