"""The installed kiosk launcher: health gating as pure functions, the real
HTTP check against a local server (redirects refused, bounded timeout), the
Chromium arguments, single instance, and the wait-then-open flow."""

import ast
import fcntl
import json
import os
import unittest
from unittest import mock

from sproutwall_lib import kiosk, kiosk_detect, kiosk_files, kiosk_launcher as kl

from . import kiosk_fakes as kfk


class HealthVerdictTests(unittest.TestCase):
    def test_only_200_with_ok_true(self):
        good = json.dumps({"ok": True, "version": "0.1.0-preview.0", "schema": 3, "setup": True}).encode()
        self.assertTrue(kl.health_verdict(200, good))
        for status, body in (
            (503, json.dumps({"ok": False, "code": "db_newer"}).encode()),
            (200, json.dumps({"ok": False}).encode()),
            (200, json.dumps({"ok": "true"}).encode()),
            (200, json.dumps({"ok": 1}).encode()),
            (200, json.dumps([{"ok": True}]).encode()),
            (200, b"<html>ok</html>"),
            (200, b"\xff\xfe"),
            (200, b""),
            (301, good),
            (302, good),
            (204, good),
            (None, good),
            (200, b'{"ok":true,"pad":"' + b"x" * kl.MAX_BODY + b'"}'),
            (200, "not bytes"),
        ):
            self.assertFalse(kl.health_verdict(status, body), (status, body[:40]))

    def test_bounded_polling(self):
        delays = [kl.next_delay(t) for t in range(0, 3600, 5)]
        self.assertGreaterEqual(min(delays), 2.0)
        self.assertLessEqual(max(delays), 10.0)
        self.assertEqual(kl.next_delay(0), 2.0)
        self.assertEqual(kl.next_delay(61), 10.0)
        self.assertLessEqual(kl.HEALTH_TIMEOUT_S, 5.0)

    def test_decide(self):
        self.assertEqual(kl.decide(0, True, False), "open_hub")
        self.assertEqual(kl.decide(500, True, True), "open_hub")
        self.assertEqual(kl.decide(10, False, False), "wait")
        self.assertEqual(kl.decide(kl.HINT_AFTER_S, False, False), "show_hint")
        self.assertEqual(kl.decide(kl.HINT_AFTER_S + 300, False, True), "wait")


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self.body = body
        self.reads = []

    def read(self, amount=None):
        self.reads.append(amount)
        return self.body if amount is None else self.body[:amount]


class FakeConnection:
    """Stands in for http.client.HTTPConnection: records every connection and
    request, answers from a script. Nothing here opens a socket."""

    made = []

    def __init__(self, answer):
        self.answer = answer
        self.requests = []
        self.closed = False

    @classmethod
    def factory(cls, answer):
        def connect(host, port, timeout=None):
            conn = cls(answer)
            conn.target = (host, port, timeout)
            cls.made.append(conn)
            return conn

        return connect

    def request(self, method, path, headers=None):
        self.requests.append((method, path, dict(headers or {})))
        if isinstance(self.answer, BaseException):
            raise self.answer

    def getresponse(self):
        return self.answer

    def close(self):
        self.closed = True


class CheckHealthTests(unittest.TestCase):
    def setUp(self):
        FakeConnection.made = []

    def check(self, answer):
        result = kl.check_health(connect=FakeConnection.factory(answer), timeout=0.5)
        self.assertEqual(len(FakeConnection.made), 1, "exactly one connection, no redirect follow-up")
        conn = FakeConnection.made[0]
        self.assertEqual(conn.target, ("127.0.0.1", 3847, 0.5))
        self.assertEqual(conn.requests, [("GET", "/api/health", {"Accept": "application/json"})])
        self.assertTrue(conn.closed)
        return result

    def test_healthy(self):
        self.assertTrue(self.check(FakeResponse(200, b'{"ok":true,"schema":3}')))

    def test_redirect_is_not_followed(self):
        self.assertFalse(self.check(FakeResponse(302, b'{"ok":true}')))

    def test_blocked_database(self):
        self.assertFalse(self.check(FakeResponse(503, b'{"ok":false,"code":"db_newer"}')))

    def test_body_is_bounded(self):
        response = FakeResponse(200, b'{"ok":true,"pad":"' + b"x" * (2 * kl.MAX_BODY) + b'"}')
        self.assertFalse(self.check(response))
        self.assertEqual(response.reads, [kl.MAX_BODY + 1])

    def test_connection_failures(self):
        for error in (ConnectionRefusedError(111, "refused"), TimeoutError("timed out"), OSError(113, "no route"), ValueError("bad")):
            FakeConnection.made = []
            self.assertFalse(self.check(error), error)

    def test_a_trickling_server_is_cut_off_by_the_deadline(self):
        import time

        class Slow(FakeResponse):
            def read(self, amount=None):
                time.sleep(2.0)  # one byte now and then, never done in time
                return b'{"ok":true}'

        started = time.monotonic()
        result = kl.check_health(connect=FakeConnection.factory(Slow(200, b"")), timeout=3.0, deadline=0.3)
        self.assertFalse(result)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertTrue(FakeConnection.made[0].closed)

    def test_unexpected_errors_reach_the_caller(self):
        with self.assertRaises(RuntimeError):
            kl.check_health(connect=FakeConnection.factory(RuntimeError("unexpected")), deadline=1.0)

    def test_default_uses_http_client_on_loopback(self):
        import http.client

        with mock.patch.object(http.client, "HTTPConnection", FakeConnection.factory(FakeResponse(200, b'{"ok":true}'))):
            self.assertTrue(kl.check_health())
        self.assertEqual(FakeConnection.made[0].target, ("127.0.0.1", 3847, kl.HEALTH_TIMEOUT_S))


class ChromiumArgvTests(unittest.TestCase):
    def test_flags(self):
        argv = kl.chromium_argv("/usr/bin/chromium", "/state/browser", kl.HUB_URL)
        self.assertEqual(argv[0], "/usr/bin/chromium")
        self.assertIn("--kiosk", argv)
        self.assertIn("--user-data-dir=/state/browser", argv)
        self.assertEqual(argv[-1], "http://127.0.0.1:3847/")
        joined = " ".join(argv)
        for banned in ("--incognito", "--no-sandbox", "--disable-setuid-sandbox", "--remote-debugging", "--guest", "--temp-profile"):
            self.assertNotIn(banned, joined)

    def test_matches_the_setup_tool(self):
        self.assertEqual(kl.STATE_DIR, kiosk.KIOSK_STATE_DIR)
        self.assertEqual(kl.BROWSER_PROFILE, kiosk_files.BROWSER_PROFILE)
        self.assertEqual(kl.RUN_DIR, kiosk_files.RUN_DIR)
        self.assertEqual((kl.LOCK_FILE, kl.WAIT_PAGE), kiosk_files.LAUNCHER_RUN_FILES)
        self.assertEqual(kl.CHROMIUM_CANDIDATES, kiosk_detect.CHROMIUM_CANDIDATES)
        self.assertEqual((kl.HUB_HOST, kl.HUB_PORT, kl.HEALTH_PATH), ("127.0.0.1", 3847, "/api/health"))
        self.assertIn(os.path.join("$HOME", kiosk.KIOSK_LAUNCHER), kiosk.LAUNCH_LINE)

    def test_installed_copy_is_standalone(self):
        data = kiosk_files.launcher_bytes()
        self.assertTrue(data.startswith(b"#!/usr/bin/python3 -I\n"))
        imported = set()
        for node in ast.walk(ast.parse(data)):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add("." * node.level + (node.module or ""))
        self.assertEqual(
            imported,
            {"fcntl", "http.client", "json", "os", "signal", "stat", "subprocess", "sys", "threading", "time", "urllib.parse", "warnings"},
        )


class FakeChild:
    def __init__(self, exits_after=0):
        self.polls = 0
        self.exits_after = exits_after
        self.terminated = False

    def poll(self):
        self.polls += 1
        return 0 if self.terminated or self.polls > self.exits_after else None

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.terminated = True


class LauncherFlowTests(unittest.TestCase):
    def setUp(self):
        self.home = kfk.temp_home(self)
        for sub in (kl.RUN_DIR, kl.BROWSER_PROFILE):  # setup makes these
            os.makedirs(os.path.join(self.home, kl.STATE_DIR, sub), 0o700)
        self.started = []
        self.children = []
        self.clock = [0.0]

    def launcher(self, health):
        launcher = kl.Launcher(self.home)

        def start(binary, url):
            self.started.append(url)
            launcher.child = FakeChild(exits_after=2)
            self.children.append(launcher.child)

        def sleep(seconds):
            self.clock[0] += seconds

        launcher.start = start
        launcher.sleep = sleep
        patches = [
            mock.patch.object(kl, "check_health", side_effect=health),
            mock.patch.object(kl, "find_chromium", return_value="/usr/bin/chromium"),
            mock.patch.object(kl, "browser_running", return_value=False),
            mock.patch.object(kl.time, "monotonic", side_effect=lambda: self.clock[0]),
            mock.patch.object(kl.signal, "signal"),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        return launcher

    def test_opens_the_hub_only_when_healthy(self):
        code = self.launcher([False, False, False, True]).run()
        self.assertEqual(code, 0)
        self.assertEqual(self.started, [kl.HUB_URL])
        self.assertEqual(self.clock[0], 3 * 2.0 + 2 * 1.0)  # three 2 s polls, then two 1 s waits on the browser

    def test_shows_a_local_hint_then_replaces_it(self):
        health = [False] * 60 + [True]
        self.launcher(health).run()
        self.assertEqual(len(self.started), 2)
        self.assertTrue(self.started[0].startswith("file://"))
        self.assertEqual(self.started[1], kl.HUB_URL)
        self.assertTrue(self.children[0].terminated)  # hint closed before the hub opens
        page = os.path.join(self.home, kiosk.KIOSK_STATE_DIR, kl.RUN_DIR, kl.WAIT_PAGE)
        with open(page, encoding="utf-8") as handle:
            self.assertIn("Sproutwall is starting", handle.read())
        self.assertEqual(os.stat(page).st_mode & 0o777, 0o600)

    def test_one_launcher_at_a_time(self):
        run_dir = os.path.join(self.home, kiosk.KIOSK_STATE_DIR, kl.RUN_DIR)
        fd = os.open(os.path.join(run_dir, kl.LOCK_FILE), os.O_WRONLY | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        launcher = self.launcher([True])
        self.assertEqual(launcher.run(), 0)
        self.assertEqual(self.started, [])

    def test_no_second_browser(self):
        launcher = self.launcher([True])
        with mock.patch.object(kl, "browser_running", return_value=True):
            self.assertEqual(launcher.run(), 0)
        self.assertEqual(self.started, [])

    def test_stop_signal_closes_the_browser(self):
        launcher = self.launcher([True])
        original_start = launcher.start

        def start_then_stop(binary, url):
            original_start(binary, url)
            launcher.child.exits_after = 10**6
            launcher.on_signal(15, None)

        launcher.start = start_then_stop
        self.assertEqual(launcher.run(), 0)
        self.assertTrue(self.children[0].terminated)

    def test_not_set_up(self):
        for sub in (kl.RUN_DIR, kl.BROWSER_PROFILE):
            os.rmdir(os.path.join(self.home, kl.STATE_DIR, sub))
            launcher = self.launcher([True])
            with self.assertRaises(kl.NotSetUp):
                launcher.run()
            os.makedirs(os.path.join(self.home, kl.STATE_DIR, sub), 0o700)
        self.assertEqual(self.started, [])

    def test_never_as_root(self):
        with mock.patch.object(kl.os, "geteuid", return_value=0):
            self.assertEqual(kl.main(), 1)


if __name__ == "__main__":
    unittest.main()
