"""The installed kiosk launcher: health gating as pure functions, the real
HTTP check against a local server (redirects refused, bounded timeout), the
Chromium arguments, single instance, and the wait-then-open flow."""

import ast
import fcntl
import json
import os
import socket
import threading
import time
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
            (200, b'{"ok":true,"ok":true}'),
            (200, b'{"ok":true,"x":NaN}'),
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


class LocalServer:
    """A real TCP server on 127.0.0.1 and an ephemeral port (never 3847):
    each connection is handed to handler(conn) in a thread."""

    def __init__(self, test, handler):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.address = self.sock.getsockname()
        assert self.address[1] != kl.HUB_PORT
        self.handler = handler
        self.connections = 0
        self.requests = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()
        test.addCleanup(self.close)

    def serve(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()

    def handle(self, conn):
        try:
            conn.settimeout(5)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            self.requests.append(data)
            self.handler(conn, self.stop)
        except OSError:
            pass
        finally:
            conn.close()

    def close(self):
        self.stop.set()
        self.sock.close()


def answer(status, body, headers=()):
    def handler(conn, _stop):
        head = ["HTTP/1.1 %s" % status, "Content-Type: application/json"] + list(headers)
        if not any(h.lower().startswith("transfer-encoding") for h in headers):
            head.append("Content-Length: %d" % len(body))
        conn.sendall(("\r\n".join(head) + "\r\n\r\n").encode() + body)

    return handler


def chunked(body):
    return b"%x\r\n%s\r\n0\r\n\r\n" % (len(body), body)


class CheckHealthTests(unittest.TestCase):
    """check_health against a real local socket server (an ephemeral port)."""

    def check(self, handler, **kwargs):
        server = LocalServer(self, handler)
        sockets = []
        real = socket.create_connection

        def create_connection(address, timeout=None):
            sock = real(address, timeout=timeout)
            sockets.append(sock)
            return sock

        with mock.patch.object(kl.socket, "create_connection", side_effect=create_connection):
            result = kl.check_health(address=server.address, **kwargs)
        self.assertEqual(server.connections, 1, "exactly one connection, no redirect follow-up")
        self.assertEqual(len(sockets), 1)
        self.assertEqual(sockets[0].fileno(), -1, "the socket was closed")
        for _ in range(50):
            if server.requests:
                break
            time.sleep(0.01)
        self.assertTrue(server.requests[0].startswith(b"GET /api/health HTTP/1.0\r\n"))
        return result

    def test_healthy(self):
        self.assertTrue(self.check(answer("200 OK", b'{"ok":true,"schema":3}')))
        self.assertTrue(self.check(answer("200 OK", chunked(b'{"ok":true}'), ["Transfer-Encoding: chunked"])))

    def test_not_ready_answers(self):
        cases = (
            answer("302 Found", b'{"ok":true}', ["Location: http://127.0.0.1:3847/elsewhere"]),
            answer("503 Service Unavailable", b'{"ok":false,"code":"db_newer"}'),
            answer("200 OK", b'{"ok":true,"ok":false}'),  # a duplicate key
            answer("200 OK", b'{"ok":true,"pad":"' + b"x" * (2 * kl.MAX_BODY) + b'"}'),
            answer("200 OK", b'{"ok":true}', ["Content-Length: 99"]),
            answer("200 OK", b"zz\r\n", ["Transfer-Encoding: chunked"]),
            lambda conn, _stop: conn.sendall(b"garbage\r\n\r\n"),
            lambda conn, _stop: None,  # closes without an answer
        )
        for handler in cases:
            with self.subTest(handler):
                self.assertFalse(self.check(handler))

    def test_a_trickling_server_is_cut_off_by_the_deadline(self):
        def trickle(conn, stop):
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n")
            for byte in b'{"ok":true}':
                if stop.wait(0.15):
                    return
                conn.sendall(bytes([byte]))  # each read gets a byte in time; the whole never does

        started = time.monotonic()
        self.assertFalse(self.check(trickle, deadline=0.6, connect_timeout=3.0))
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.55)
        self.assertLess(elapsed, 1.5)

    def test_a_silent_server_is_cut_off_by_the_deadline(self):
        started = time.monotonic()
        self.assertFalse(self.check(lambda conn, stop: stop.wait(5), deadline=0.4))
        self.assertLess(time.monotonic() - started, 1.2)

    def test_nothing_listening(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        address = probe.getsockname()
        probe.close()  # a free port: connection refused
        self.assertNotEqual(address[1], kl.HUB_PORT)
        self.assertFalse(kl.check_health(address=address, deadline=1.0))

    def test_unexpected_errors_reach_the_caller(self):
        with mock.patch.object(kl.socket, "create_connection", side_effect=RuntimeError("unexpected")):
            with self.assertRaises(RuntimeError):
                kl.check_health(deadline=1.0)

    def test_default_address_is_the_hub_on_loopback(self):
        """Checked with a fake socket, so nothing touches port 3847."""

        class FakeSocket:
            def __init__(self):
                self.sent, self.timeouts, self.closed = b"", [], False
                self.answers = [b'HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"ok":true}', b""]

            def settimeout(self, value):
                self.timeouts.append(value)

            def sendall(self, data):
                self.sent += data

            def recv(self, _size):
                return self.answers.pop(0)

            def close(self):
                self.closed = True

        fake = FakeSocket()
        with mock.patch.object(kl.socket, "create_connection", return_value=fake) as connect:
            self.assertTrue(kl.check_health())
        self.assertEqual(connect.call_args, mock.call(("127.0.0.1", 3847), timeout=kl.HEALTH_TIMEOUT_S))
        self.assertTrue(fake.sent.startswith(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:3847\r\n"))
        self.assertTrue(fake.closed)
        self.assertTrue(all(0 < value <= kl.HEALTH_DEADLINE_S for value in fake.timeouts))

    def test_parse_response(self):
        self.assertEqual(kl.parse_response(b"HTTP/1.0 200 OK\r\n\r\nbody"), (200, b"body"))
        self.assertEqual(kl.parse_response(b"HTTP/1.1 503\r\nContent-Length: 2\r\n\r\nabXX"), (503, b"ab"))
        for bad in (
            b"HTTP/2 200 OK\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nabc",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\n Bad: header\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n",
            b"HTTP/1.1 200 OK",
        ):
            with self.assertRaises(ValueError, msg=bad):
                kl.parse_response(bad)


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
        self.assertEqual((kl.SETUP_LOCK, kl.MANIFEST), (kiosk_files.SETUP_LOCK, kiosk_files.MANIFEST))
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
            {"errno", "fcntl", "json", "os", "re", "signal", "socket", "stat", "subprocess", "sys", "threading", "time", "urllib.parse", "warnings"},
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
        # What setup makes: the record, setup.lock, run/ with the launcher's
        # lock file and waiting page, and browser/.
        self.state = os.path.join(self.home, kl.STATE_DIR)
        for sub in (kl.RUN_DIR, kl.BROWSER_PROFILE):
            os.makedirs(os.path.join(self.state, sub), 0o700)
        for rel, data in (
            (kl.MANIFEST, b"{}"),
            (kl.SETUP_LOCK, b""),
            (os.path.join(kl.RUN_DIR, kl.LOCK_FILE), b""),
            (os.path.join(kl.RUN_DIR, kl.WAIT_PAGE), kl.WAIT_HTML.encode()),
        ):
            kfk.write(self.state, rel, data, mode=0o600)
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

    def hold(self, rel, operation):
        fd = os.open(os.path.join(self.state, rel), os.O_RDWR)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, operation | fcntl.LOCK_NB)
        return fd

    def test_opens_the_hub_only_when_healthy(self):
        before = kfk.tree(self.home)
        code = self.launcher([False, False, False, True]).run()
        self.assertEqual(code, 0)
        self.assertEqual(self.started, [kl.HUB_URL])
        self.assertEqual(self.clock[0], 3 * 2.0 + 2 * 1.0)  # three 2 s polls, then two 1 s waits on the browser
        self.assertEqual(kfk.tree(self.home), before)  # the launcher creates and writes nothing

    def test_shows_the_page_setup_wrote_then_replaces_it(self):
        before = kfk.tree(self.home)
        self.launcher([False] * 60 + [True]).run()
        self.assertEqual(len(self.started), 2)
        page = os.path.join(self.state, kl.RUN_DIR, kl.WAIT_PAGE)
        self.assertEqual(self.started[0], "file://" + page)
        self.assertEqual(self.started[1], kl.HUB_URL)
        self.assertTrue(self.children[0].terminated)  # hint closed before the hub opens
        self.assertEqual(kfk.tree(self.home), before)

    def test_a_missing_or_replaced_page_is_not_shown(self):
        page = os.path.join(self.state, kl.RUN_DIR, kl.WAIT_PAGE)
        os.unlink(page)
        os.symlink(os.path.join(self.home, "elsewhere.html"), page)
        self.launcher([False] * 60 + [True]).run()
        self.assertEqual(self.started, [kl.HUB_URL])

    def test_one_launcher_at_a_time(self):
        self.hold(os.path.join(kl.RUN_DIR, kl.LOCK_FILE), fcntl.LOCK_EX)
        self.assertEqual(self.launcher([True]).run(), 0)
        self.assertEqual(self.started, [])

    def test_waits_for_nobody_while_setup_off_or_undo_runs(self):
        self.hold(kl.SETUP_LOCK, fcntl.LOCK_EX)  # what --off and --undo hold
        self.assertEqual(self.launcher([True]).run(), 0)
        self.assertEqual(self.started, [])

    def test_lets_go_of_setup_lock_once_started(self):
        """While the browser runs, --off and --undo can take setup.lock."""
        launcher = self.launcher([True])
        original_start = launcher.start
        taken = []

        def start(binary, url):
            original_start(binary, url)
            fd = os.open(os.path.join(self.state, kl.SETUP_LOCK), os.O_RDWR)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                taken.append(True)
            finally:
                os.close(fd)

        launcher.start = start
        self.assertEqual(launcher.run(), 0)
        self.assertEqual(taken, [True])

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
        for rel in (kl.MANIFEST, kl.SETUP_LOCK, os.path.join(kl.RUN_DIR, kl.LOCK_FILE)):
            with self.subTest(rel):
                path = os.path.join(self.state, rel)
                os.rename(path, path + ".away")
                with self.assertRaises(kl.NotSetUp):
                    self.launcher([True]).run()
                os.rename(path + ".away", path)
        for sub in (kl.RUN_DIR, kl.BROWSER_PROFILE):
            with self.subTest(sub):
                path = os.path.join(self.state, sub)
                os.rename(path, path + ".away")
                with self.assertRaises(kl.NotSetUp):
                    self.launcher([True]).run()
                os.rename(path + ".away", path)
        self.assertEqual(self.started, [])

    def test_links_are_never_followed(self):
        outside = os.path.join(self.home, "outside")
        os.makedirs(outside)
        cases = (
            kl.RUN_DIR,
            os.path.join(kl.RUN_DIR, kl.LOCK_FILE),
            kl.SETUP_LOCK,
            kl.BROWSER_PROFILE,
            "",  # the state folder itself
        )
        for rel in cases:
            with self.subTest(rel or "state folder"):
                path = os.path.join(self.state, rel) if rel else self.state
                os.rename(path, path + ".away")
                os.symlink(path + ".away", path)
                before = kfk.tree(self.home)
                with self.assertRaises(kl.Unsafe):
                    self.launcher([True]).run()
                self.assertEqual(kfk.tree(self.home), before)
                os.unlink(path)
                os.rename(path + ".away", path)
        self.assertEqual(self.started, [])

    def test_never_as_root(self):
        with mock.patch.object(kl.os, "geteuid", return_value=0):
            self.assertEqual(kl.main(), 1)


if __name__ == "__main__":
    unittest.main()
