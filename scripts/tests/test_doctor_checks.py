"""Each doctor check's pass, fail and unknown branches, from fake host output."""

import unittest

from sproutwall_lib import checks
from sproutwall_lib.checks import Context
from sproutwall_lib.system import CommandResult, HttpResponse

from . import fakes
from .fakes import COMPOSE, HOME, ROOT, exec_key, healthy_pi, ok, proc_table, ssh_on

PASS = ("pass", "none")


def run(check, system, phase="running", tier="A", kiosk="on", outcomes=None):
    ctx = Context(system, ROOT, phase, tier, kiosk)
    ctx.outcomes.update(outcomes or {})
    return getattr(checks, "check_" + check)(ctx)


class PlatformTests(unittest.TestCase):
    def test_pass_on_arm64_pi(self):
        self.assertEqual(run("platform", healthy_pi()), PASS)

    def test_pass_on_arm64_board_that_is_not_a_pi(self):
        s = healthy_pi()
        del s.files["/proc/device-tree/model"]
        self.assertEqual(run("platform", s), PASS)

    def test_pass_on_amd64(self):
        s = healthy_pi()
        s.arch = "x86_64"
        s.set(["dpkg", "--print-architecture"], ok("amd64\n"))
        self.assertEqual(run("platform", s), PASS)

    def test_pass_on_64_bit_linux_without_dpkg(self):
        s = healthy_pi()
        s.set(["dpkg", "--print-architecture"], CommandResult(None, missing=True))
        self.assertEqual(run("platform", s), PASS)

    def test_fail_on_32_bit_cpu_or_kernel(self):
        for machine in ("armv7l", "armv6l", "i686"):
            s = healthy_pi()
            s.arch = machine
            self.assertEqual(run("platform", s), ("fail", "use_supported_os"), machine)

    def test_fail_on_64_bit_kernel_with_32_bit_userland(self):
        s = healthy_pi()
        s.set(["dpkg", "--print-architecture"], ok("armhf\n"))
        self.assertEqual(run("platform", s), ("fail", "use_supported_os"))
        s = healthy_pi()
        s.arch = "x86_64"
        s.set(["dpkg", "--print-architecture"], ok("i386\n"))
        self.assertEqual(run("platform", s), ("fail", "use_supported_os"))
        s = healthy_pi()
        s.set(["dpkg", "--print-architecture"], CommandResult(None, missing=True))
        s.bits = "32bit"
        self.assertEqual(run("platform", s), ("fail", "use_supported_os"))

    def test_fail_when_not_linux(self):
        s = healthy_pi()
        s.os_name = "Darwin"
        s.arch = "arm64"
        self.assertEqual(run("platform", s), ("fail", "use_supported_os"))

    def test_unknown_when_architecture_unreadable(self):
        s = healthy_pi()
        s.arch = ""
        self.assertEqual(run("platform", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.set(["dpkg", "--print-architecture"], ok(rc=2))
        self.assertEqual(run("platform", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.set(["dpkg", "--print-architecture"], CommandResult(None, timed_out=True))
        self.assertEqual(run("platform", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.set(["dpkg", "--print-architecture"], CommandResult(None, missing=True))
        s.bits = ""
        self.assertEqual(run("platform", s), ("unknown", "retry_local"))


class DockerTests(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(run("docker", healthy_pi()), PASS)

    def test_fail_without_docker_or_compose(self):
        s = healthy_pi()
        s.set(["docker", "compose", "version", "--short"], CommandResult(None, missing=True))
        self.assertEqual(run("docker", s), ("fail", "use_supported_os"))
        s = healthy_pi()
        s.set(["docker", "compose", "version", "--short"], ok("", "not a docker command", rc=1))
        self.assertEqual(run("docker", s), ("fail", "use_supported_os"))

    def test_unknown_when_daemon_unreachable(self):
        s = healthy_pi()
        s.set(["docker", "version", "--format", "{{.Server.Version}}"], ok("", "permission denied", rc=1))
        self.assertEqual(run("docker", s), ("unknown", "retry_local"))


class ImageIdentityTests(unittest.TestCase):
    def test_pass_by_repo_digest(self):
        self.assertEqual(run("image_identity", healthy_pi()), PASS)

    def test_pass_with_containerd_store_image_id(self):
        s = healthy_pi()
        s.set(["docker", "inspect", "--type", "container"], ok(fakes.container_json(image=fakes.DIGEST)))
        s.set(["docker", "image", "inspect"], ok(fakes.image_json(id=fakes.DIGEST, repo_digests=[])))
        self.assertEqual(run("image_identity", s), PASS)

    def test_fail_on_placeholder_tag_or_other_repo(self):
        for reference in (
            '"ghcr.io/thebrianlee/sproutwall:preview@sha256:<published-index-digest-hex>"',
            "ghcr.io/thebrianlee/sproutwall:preview",
            "ghcr.io/someone/sproutwall@" + fakes.DIGEST,
        ):
            s = healthy_pi()
            s.files[COMPOSE] = fakes.compose_text(reference)
            self.assertEqual(run("image_identity", s), ("fail", "verify_release"), reference)

    def test_fail_when_running_image_is_not_the_pinned_index(self):
        s = healthy_pi()
        s.set(["docker", "image", "inspect"], ok(fakes.image_json(repo_digests=["sproutwall-family-hub@sha256:" + "c" * 64])))
        self.assertEqual(run("image_identity", s), ("fail", "verify_release"))

    def test_fail_on_wrong_platform_manifest(self):
        s = healthy_pi()
        s.set(["docker", "image", "inspect"], ok(fakes.image_json(arch="amd64")))
        self.assertEqual(run("image_identity", s), ("fail", "verify_release"))

    def test_fail_without_a_container(self):
        s = healthy_pi()
        s.set(["docker", "compose", "-f", COMPOSE, "ps", "--all", "--quiet"], ok(""))
        self.assertEqual(run("image_identity", s), ("fail", "verify_release"))

    def test_unknown_when_docker_or_files_cannot_be_read(self):
        s = healthy_pi()
        s.set(["docker", "compose", "-f", COMPOSE, "ps", "--all", "--quiet"], ok("", "denied", rc=1))
        self.assertEqual(run("image_identity", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.files[COMPOSE] = PermissionError(13, "denied")
        self.assertEqual(run("image_identity", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.set(["docker", "image", "inspect"], ok("", "boom", rc=1))
        self.assertEqual(run("image_identity", s), ("unknown", "retry_local"))


class StorageTests(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(run("storage", healthy_pi()), PASS)

    def test_pass_with_pre_rename_database(self):
        s = healthy_pi()
        s.set(exec_key("test", "-f", "/data/sproutwall.db"), ok(rc=1))
        s.set(exec_key("test", "-f", "/data/family-hub.db"), ok())
        s.set(exec_key("test", "-w", "/data/family-hub.db"), ok())
        self.assertEqual(run("storage", s), PASS)

    def test_fail_on_unexpected_mounts(self):
        anonymous = [{"Type": "volume", "Name": "f" * 64, "Destination": "/data", "RW": True},
                     {"Type": "bind", "Destination": "/photos", "RW": True}]
        no_photos = [{"Type": "volume", "Name": "sproutwall_familyhub-data", "Destination": "/data", "RW": True}]
        for mounts in (anonymous, no_photos, []):
            s = healthy_pi()
            s.set(["docker", "inspect", "--type", "container"], ok(fakes.container_json(mounts=mounts)))
            self.assertEqual(run("storage", s), ("fail", "restore_storage"))

    def test_fail_when_not_writable_or_no_database(self):
        s = healthy_pi()
        s.set(exec_key("test", "-w", "/data"), ok(rc=1))
        self.assertEqual(run("storage", s), ("fail", "restore_storage"))
        s = healthy_pi()
        s.set(exec_key("test", "-f", "/data/sproutwall.db"), ok(rc=1))
        self.assertEqual(run("storage", s), ("fail", "restore_storage"))
        s = healthy_pi()
        s.set(exec_key("test", "-w", "/data/sproutwall.db"), ok(rc=1))
        self.assertEqual(run("storage", s), ("fail", "restore_storage"))

    def test_unknown_when_exec_or_container_unavailable(self):
        s = healthy_pi()
        s.set(exec_key("true"), ok("", "container is not running", rc=1))
        self.assertEqual(run("storage", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.set(["docker", "inspect", "--type", "container"], ok(fakes.container_json(running=False)))
        self.assertEqual(run("storage", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.set(exec_key("test", "-w", "/data"), ok(rc=126))
        self.assertEqual(run("storage", s), ("unknown", "retry_local"))


class HealthTests(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(run("health", healthy_pi()), PASS)

    def test_fail_on_blocked_database(self):
        s = healthy_pi()
        s.http_map[("GET", "/api/health")] = HttpResponse(503, b'{"ok":false,"code":"db_newer"}')
        self.assertEqual(run("health", s), ("fail", "restore_storage"))

    def test_fail_on_generic_or_wrong_answers(self):
        for status, body in ((503, b'{"ok":false}'), (200, b'{"ok":"true"}'), (200, b"ok"), (302, b""), (401, b"{}")):
            s = healthy_pi()
            s.http_map[("GET", "/api/health")] = HttpResponse(status, body)
            self.assertEqual(run("health", s), ("fail", "retry_local"), (status, body))

    def test_fail_when_nothing_listens(self):
        s = healthy_pi()
        s.http_map[("GET", "/api/health")] = HttpResponse(None, error="refused")
        self.assertEqual(run("health", s), ("fail", "verify_release"))

    def test_unknown_on_timeout(self):
        s = healthy_pi()
        s.http_map[("GET", "/api/health")] = HttpResponse(None, error="timeout")
        self.assertEqual(run("health", s), ("unknown", "retry_local"))


class AppBindTests(unittest.TestCase):
    def test_lan_publication_is_unknown_confirm_trusted_lan(self):
        self.assertEqual(run("app_bind", healthy_pi()), ("unknown", "confirm_trusted_lan"))

    def test_pass_when_loopback_only(self):
        s = healthy_pi()
        loop = {"3847/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3847"}]}
        s.set(["docker", "inspect", "--type", "container"], ok(fakes.container_json(ports=loop, port_bindings=loop)))
        s.files["/proc/net/tcp"] = proc_table([("127.0.0.1", 3847, "0A")])
        s.files["/proc/net/tcp6"] = proc_table([], v6=True)
        self.assertEqual(run("app_bind", s), PASS)

    DUAL_STACK = {"lo": ["127.0.0.1", "::1"], "wlan0": ["192.168.1.50", "2001:db8::50", "fe80::1"]}

    def test_dual_stack_host_with_ipv4_only_publication_is_confirm_trusted_lan(self):
        # The preview compose publishes 0.0.0.0:3847 only, so a global IPv6
        # address on the Pi does not expose the hub.
        s = healthy_pi()
        s.set(["ip", "-j", "addr", "show"], ok(fakes.ip_addr_json(self.DUAL_STACK)))
        self.assertEqual(run("app_bind", s), ("unknown", "confirm_trusted_lan"))

    def test_fail_on_ipv6_wildcard_across_global_ipv6(self):
        # docker-compose.yml's plain "3847:3847" also publishes on [::].
        s = healthy_pi()
        both = {"3847/tcp": [{"HostIp": "0.0.0.0", "HostPort": "3847"}, {"HostIp": "::", "HostPort": "3847"}]}
        s.set(["docker", "inspect", "--type", "container"], ok(fakes.container_json(ports=both, port_bindings={"3847/tcp": [{"HostIp": "", "HostPort": "3847"}]})))
        s.files["/proc/net/tcp6"] = proc_table([("::", 3847, "0A")], v6=True)
        s.set(["ip", "-j", "addr", "show"], ok(fakes.ip_addr_json(self.DUAL_STACK)))
        self.assertEqual(run("app_bind", s), ("fail", "restrict_ports"))

    def test_fail_on_wildcard_across_public_ipv4(self):
        s = healthy_pi()
        s.set(["ip", "-j", "addr", "show"], ok(fakes.ip_addr_json({"eth0": ["203.0.113.7"]})))
        self.assertEqual(run("app_bind", s), ("fail", "restrict_ports"))

    def test_fail_on_public_bind_even_if_inspection_incomplete(self):
        s = healthy_pi()
        s.set(["docker", "compose", "-f", COMPOSE, "ps", "--all", "--quiet"], ok(rc=1))
        s.files["/proc/net/tcp"] = proc_table([("198.51.100.9", 3847, "0A")])
        self.assertEqual(run("app_bind", s), ("fail", "restrict_ports"))

    def test_lan_address_bind_is_still_not_verified_safe(self):
        s = healthy_pi()
        lan = {"3847/tcp": [{"HostIp": "192.168.1.50", "HostPort": "3847"}]}
        s.set(["docker", "inspect", "--type", "container"], ok(fakes.container_json(ports=lan, port_bindings=lan)))
        s.files["/proc/net/tcp"] = proc_table([("192.168.1.50", 3847, "0A")])
        s.files["/proc/net/tcp6"] = proc_table([], v6=True)
        self.assertEqual(run("app_bind", s), ("unknown", "confirm_trusted_lan"))

    def test_incomplete_inspection_is_retry_local(self):
        s = healthy_pi()
        s.set(["ip", "-j", "addr", "show"], CommandResult(None, missing=True))
        self.assertEqual(run("app_bind", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.files["/proc/net/tcp6"] = PermissionError(13, "denied")
        self.assertEqual(run("app_bind", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.set(["docker", "compose", "-f", COMPOSE, "ps", "--all", "--quiet"], ok(rc=1))
        self.assertEqual(run("app_bind", s), ("unknown", "retry_local"))


class BridgeBindTests(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(run("bridge_bind", healthy_pi()), PASS)

    def test_fail_when_8787_is_published(self):
        s = healthy_pi()
        ports = {"3847/tcp": [{"HostIp": "0.0.0.0", "HostPort": "3847"}], "8787/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8787"}]}
        s.set(["docker", "inspect", "--type", "container"], ok(fakes.container_json(ports=ports)))
        self.assertEqual(run("bridge_bind", s), ("fail", "restrict_ports"))

    def test_fail_when_bridge_listens_beyond_loopback(self):
        s = healthy_pi()
        s.set(exec_key("cat", "/proc/net/tcp", "/proc/net/tcp6"), ok(proc_table([("0.0.0.0", 8787, "0A")])))
        self.assertEqual(run("bridge_bind", s), ("fail", "restrict_ports"))

    def test_fail_with_host_networking_and_open_bridge(self):
        s = healthy_pi()
        s.set(["docker", "inspect", "--type", "container"], ok(fakes.container_json(network_mode="host", ports={}, port_bindings={})))
        s.files["/proc/net/tcp6"] = proc_table([("::", 8787, "0A")], v6=True)
        self.assertEqual(run("bridge_bind", s), ("fail", "restrict_ports"))

    def test_unknown_when_container_cannot_be_inspected(self):
        s = healthy_pi()
        s.set(exec_key("cat", "/proc/net/tcp", "/proc/net/tcp6"), ok("", "OCI runtime exec failed", rc=126))
        self.assertEqual(run("bridge_bind", s), ("unknown", "retry_local"))
        s = healthy_pi()
        s.set(["docker", "compose", "-f", COMPOSE, "ps", "--all", "--quiet"], ok(rc=1))
        self.assertEqual(run("bridge_bind", s), ("unknown", "retry_local"))


class SshPolicyTests(unittest.TestCase):
    def test_pass_when_off_for_a_and_c(self):
        for tier in ("A", "C"):
            self.assertEqual(run("ssh_policy", healthy_pi(), tier=tier), PASS)

    def test_fail_when_on_for_a_or_c(self):
        s = healthy_pi()
        ssh_on(s)
        self.assertEqual(run("ssh_policy", s, tier="C"), ("fail", "review_ssh"))
        s = healthy_pi()
        s.files["/proc/net/tcp"] = proc_table([("0.0.0.0", 22, "0A")])  # sshd started by hand
        self.assertEqual(run("ssh_policy", s, tier="A"), ("fail", "review_ssh"))

    def test_b_temporary_key_only_on_lan_passes_until_final(self):
        s = healthy_pi()
        ssh_on(s)
        self.assertEqual(run("ssh_policy", s, tier="B", phase="running"), PASS)
        self.assertEqual(run("ssh_policy", s, tier="B", phase="final"), ("fail", "review_ssh"))

    def test_b_fails_on_password_or_root_login(self):
        s = healthy_pi()
        ssh_on(s, password=True)
        self.assertEqual(run("ssh_policy", s, tier="B"), ("fail", "review_ssh"))
        s = healthy_pi()
        ssh_on(s)
        s.files["/etc/ssh/sshd_config"] = "PermitRootLogin yes\n" + fakes.SSHD_CONFIG
        self.assertEqual(run("ssh_policy", s, tier="B"), ("fail", "review_ssh"))
        s = healthy_pi()
        ssh_on(s)
        s.files["/etc/ssh/sshd_config"] = fakes.SSHD_CONFIG + "Match Address 192.168.1.0/24\n  PasswordAuthentication yes\n"
        self.assertEqual(run("ssh_policy", s, tier="B"), ("fail", "review_ssh"))
        s = healthy_pi()
        ssh_on(s)
        s.files["/etc/ssh/sshd_config"] = "Include /etc/ssh/sshd_config.d/*.conf\n"  # keyboard-interactive default yes
        self.assertEqual(run("ssh_policy", s, tier="B"), ("fail", "review_ssh"))

    def test_b_fails_on_public_listener(self):
        s = healthy_pi()
        ssh_on(s)
        s.set(["ip", "-j", "addr", "show"], ok(fakes.ip_addr_json({"wlan0": ["192.168.1.50", "2001:db8::50"]})))
        s.files["/proc/net/tcp6"] = proc_table([("::", 22, "0A")], v6=True)
        self.assertEqual(run("ssh_policy", s, tier="B"), ("fail", "review_ssh"))

    def test_unknown_when_state_or_config_unreadable(self):
        s = healthy_pi()
        s.set(["systemctl", "is-enabled", "ssh.service"], CommandResult(None, missing=True))
        self.assertEqual(run("ssh_policy", s), ("unknown", "review_ssh"))
        s = healthy_pi()
        s.set(["systemctl", "is-active", "ssh.socket"], ok("", "Failed to connect to bus", rc=1))
        s.files["/lib/systemd/system/ssh.socket"] = "[Socket]\n"
        self.assertEqual(run("ssh_policy", s), ("unknown", "review_ssh"))
        s = healthy_pi()
        ssh_on(s)
        s.files["/etc/ssh/sshd_config.d/50-temp.conf"] = PermissionError(13, "denied")
        self.assertEqual(run("ssh_policy", s, tier="B"), ("unknown", "review_ssh"))
        s = healthy_pi()
        ssh_on(s)
        s.set(["ip", "-j", "addr", "show"], ok("not json"))
        self.assertEqual(run("ssh_policy", s, tier="B"), ("unknown", "retry_local"))

    def test_off_when_openssh_is_not_installed(self):
        s = healthy_pi()
        for unit in ("ssh.service", "ssh.socket"):
            s.set(["systemctl", "is-enabled", unit], ok("not-found\n", rc=4))
            s.set(["systemctl", "is-active", unit], ok("", "Failed to connect to bus", rc=1))
        self.assertEqual(run("ssh_policy", s), PASS)


class SetupAndReadGuardTests(unittest.TestCase):
    def test_setup_pass_fail_unknown(self):
        self.assertEqual(run("setup", healthy_pi(), phase="configured"), PASS)
        self.assertEqual(run("setup", healthy_pi(phase_ready=False), phase="configured"), ("fail", "open_hub"))
        for response in (
            HttpResponse(200, b'{"ok":true,"version":"0.1.0","schema":3}'),  # image from before the field
            fakes.health_response(setup="yes"),
            HttpResponse(503, b'{"ok":false,"code":"db_newer_than_app"}'),
            HttpResponse(None, error="refused"),
            HttpResponse(None, error="timeout"),
        ):
            s = healthy_pi()
            s.http_map[("GET", "/api/health")] = response
            self.assertEqual(run("setup", s, phase="configured"), ("unknown", "retry_local"), response)

    def test_doctor_only_reads_from_the_hub(self):
        from sproutwall_lib.doctor import run_doctor

        for phase in ("running", "configured", "final"):
            s = healthy_pi()
            run_doctor(s, ROOT, phase)
            self.assertTrue(s.http_calls)
            self.assertEqual({method for method, _, body, _ in s.http_calls}, {"GET"})
            self.assertTrue(all(body is None for _, _, body, _ in s.http_calls))
            paths = [path for _, path, _, _ in s.http_calls]
            self.assertEqual(paths.count("/api/health"), 1, "health is asked once and shared with setup")
            self.assertNotIn("/api/setup", paths)

    def test_read_guard_pass_fail_unknown(self):
        self.assertEqual(run("read_guard", healthy_pi(), phase="configured"), PASS)
        s = healthy_pi()
        s.http_map[("GET", "/api/modules")] = HttpResponse(200, b'{"rev":1}')
        self.assertEqual(run("read_guard", s, phase="configured", outcomes={"setup": PASS}), ("fail", "verify_release"))
        self.assertEqual(run("read_guard", s, phase="configured", outcomes={"setup": ("fail", "open_hub")}), ("fail", "open_hub"))
        s = healthy_pi()
        s.http_map[("GET", "/api/modules")] = HttpResponse(503, b"{}")
        self.assertEqual(run("read_guard", s, phase="configured"), ("unknown", "retry_local"))
        self.assertEqual(s.http_calls[-1][3], {"Accept": "application/json"})  # no cookie


class KioskTests(unittest.TestCase):
    AUTOSTART = HOME + "/.config/labwc/autostart"
    LINE = '"$HOME/.local/share/sproutwall/kiosk-launch" & # sproutwall:kiosk-launcher\n'

    def test_on(self):
        self.assertEqual(run("kiosk", healthy_pi(), phase="final"), PASS)
        s = healthy_pi()
        del s.files[self.AUTOSTART]
        self.assertEqual(run("kiosk", s, phase="final"), ("fail", "repair_kiosk"))
        s = healthy_pi()
        s.files[self.AUTOSTART] = self.LINE * 2
        self.assertEqual(run("kiosk", s, phase="final"), ("fail", "repair_kiosk"))
        s = healthy_pi()
        s.files[self.AUTOSTART] = "# " + self.LINE
        self.assertEqual(run("kiosk", s, phase="final"), ("fail", "repair_kiosk"))

    def test_off(self):
        s = healthy_pi()
        self.assertEqual(run("kiosk", s, phase="final", kiosk="off"), ("fail", "repair_kiosk"))
        s.files[self.AUTOSTART] = "# " + self.LINE
        self.assertEqual(run("kiosk", s, phase="final", kiosk="off"), PASS)
        del s.files[self.AUTOSTART]
        self.assertEqual(run("kiosk", s, phase="final", kiosk="off"), PASS)

    def test_unknown_when_unreadable(self):
        s = healthy_pi()
        s.files[self.AUTOSTART] = PermissionError(13, "denied")
        self.assertEqual(run("kiosk", s, phase="final"), ("unknown", "retry_local"))


class TemporaryAccessTests(unittest.TestCase):
    def test_pass(self):
        for tier in ("A", "B", "C"):
            self.assertEqual(run("temporary_access", healthy_pi(), phase="final", tier=tier), PASS)

    def test_fail_when_an_agent_remains(self):
        s = healthy_pi()
        s.which_map["claude"] = HOME + "/.local/bin/claude"
        self.assertEqual(run("temporary_access", s, phase="final"), ("fail", "remove_agent"))
        s = healthy_pi()
        s.dirs.add(HOME + "/.codex")
        self.assertEqual(run("temporary_access", s, phase="final", tier="C"), ("fail", "remove_agent"))
        s = healthy_pi()
        s.files[HOME + "/.config/autostart/helper.desktop"] = "[Desktop Entry]\nExec=/usr/local/bin/gemini --resume\n"
        self.assertEqual(run("temporary_access", s, phase="final"), ("fail", "remove_agent"))

    def test_fail_when_an_ssh_session_is_open(self):
        s = healthy_pi()
        s.files["/proc/net/tcp"] = proc_table([("192.168.1.50", 22, "01")])
        self.assertEqual(run("temporary_access", s, phase="final", tier="B"), ("fail", "remove_agent"))

    def test_unknown_when_unreadable(self):
        s = healthy_pi()
        s.files["/proc/net/tcp"] = PermissionError(13, "denied")
        self.assertEqual(run("temporary_access", s, phase="final"), ("unknown", "retry_local"))
        s = healthy_pi()
        s.files[HOME + "/.config/autostart/x.desktop"] = PermissionError(13, "denied")
        self.assertEqual(run("temporary_access", s, phase="final"), ("unknown", "retry_local"))


class ParserTests(unittest.TestCase):
    def test_proc_net_tcp_round_trip(self):
        from sproutwall_lib import net

        text = proc_table([("127.0.0.1", 8787, "0A")]) + proc_table([("::1", 3847, "0A")], v6=True)
        parsed = [(str(a), p, st) for a, p, st in net.parse_proc_net_tcp(text)]
        self.assertEqual(parsed, [("127.0.0.1", 8787, "0A"), ("::1", 3847, "0A")])
        with self.assertRaises(ValueError):
            net.parse_proc_net_tcp("garbage")

    def test_classify(self):
        import ipaddress

        from sproutwall_lib import net

        cases = {
            "127.0.0.1": "loopback", "::1": "loopback", "192.168.1.50": "lan", "10.1.2.3": "lan",
            "172.20.0.1": "lan", "fe80::1": "lan", "fd00::1": "lan", "::ffff:192.168.1.5": "lan",
            "2001:db8::1": "public", "203.0.113.7": "public", "100.64.0.1": "public",
        }
        for address, expected in cases.items():
            self.assertEqual(net.classify(ipaddress.ip_address(address)), expected, address)

    def test_container_format_requests_no_environment(self):
        self.assertNotIn("Env", checks.CONTAINER_FORMAT)
        self.assertNotIn(".Config", checks.CONTAINER_FORMAT)


if __name__ == "__main__":
    unittest.main()
