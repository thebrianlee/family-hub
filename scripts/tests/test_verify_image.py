"""verify-image: refusals, the gh version gate, the exact argument list, the
isolated gh environment and temp-file cleanup. No network: the bundle fetch
is replaced by a fake."""

import io
import json
import os
import stat
import unittest
from unittest import mock

from sproutwall_lib import attestation, cli, compose, verify_image as vi
from sproutwall_lib.system import CommandResult

from .fakes import COMPOSE, DIGEST, ROOT, SOURCE_SHA, FakeSystem, compose_config_json, compose_text, ok

TOKEN = "canary" + "ghtoken" + "0quinn"
BUNDLES = [{"mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json", "n": 1}, {"n": 2}]


def gh_system(verify=None, version="gh version 2.89.0 (2026-03-26)\nhttps://github.com/cli/cli/releases/tag/v2.89.0\n"):
    s = FakeSystem()
    s.files[COMPOSE] = compose_text()
    s.set(compose.config_argv(COMPOSE), ok(compose_config_json()))
    if version is not None:
        s.set(["gh", "--version"], ok(version))
    s.set(["gh", "attestation", "verify"], verify if verify is not None else ok("", ""))
    return s


def fake_fetch(digest, opener=None):
    assert digest == DIGEST
    return BUNDLES


class RefusalTests(unittest.TestCase):
    def assert_refused(self, system, sha=SOURCE_SHA, key=None, **kwargs):
        code, got_key, digest = vi.verify_image(system, COMPOSE, sha, fetch=fake_fetch, **kwargs)
        self.assertEqual(code, vi.EXIT_REFUSED)
        self.assertIsNone(digest)
        if key:
            self.assertEqual(got_key, key)
        self.assertFalse([c for c in system.calls if c[0][0] == "gh"], "gh never runs after a refusal")

    def test_placeholder(self):
        s = gh_system()
        s.files[COMPOSE] = compose_text('"ghcr.io/thebrianlee/sproutwall:preview@sha256:<published-index-digest-hex>"')
        self.assert_refused(s, key="placeholder")

    def test_the_committed_preview_compose_is_refused(self):
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from sproutwall_lib.system import System

        code, key, _ = vi.verify_image(System(), os.path.join(repo_root, "docker-compose.preview.yml"), SOURCE_SHA)
        self.assertEqual((code, key), (vi.EXIT_REFUSED, "placeholder"))

    def test_tag_only_and_preview_resolved_references(self):
        for reference in ("ghcr.io/thebrianlee/sproutwall:preview", "ghcr.io/thebrianlee/sproutwall", "ghcr.io/thebrianlee/sproutwall:latest"):
            s = gh_system()
            s.files[COMPOSE] = compose_text(reference)
            self.assert_refused(s, key="tag_only")

    def test_other_repository_or_bad_reference(self):
        for reference, key in (
            ("ghcr.io/someone/sproutwall@" + DIGEST, "wrong_repo"),
            ("ghcr.io/thebrianlee/sproutwall-fork@" + DIGEST, "wrong_repo"),
            ("ghcr.io/thebrianlee/sproutwall@sha256:" + "A" * 64, "bad_ref"),
        ):
            s = gh_system()
            s.files[COMPOSE] = compose_text(reference)
            self.assert_refused(s, key=key)

    def test_source_sha_must_be_40_lowercase_hex(self):
        for sha in ("", "5972e3e", SOURCE_SHA.upper(), SOURCE_SHA + "0", SOURCE_SHA[:-1] + "g", "main", None,
                    SOURCE_SHA + "\n", " " + SOURCE_SHA, SOURCE_SHA[:-1] + "\u0661"):
            self.assert_refused(gh_system(), sha=sha, key="bad_sha")

    def test_published_digest_must_match(self):
        self.assert_refused(gh_system(), key="mismatch", published_digest="sha256:" + "f" * 64)
        for bad in ("preview", DIGEST + "\n", DIGEST.upper()):
            self.assert_refused(gh_system(), key="bad_digest", published_digest=bad)

    def test_digest_with_trailing_newline_in_effective_config(self):
        s = gh_system()
        s.set(compose.config_argv(COMPOSE), ok(compose_config_json(image="ghcr.io/thebrianlee/sproutwall@" + DIGEST + "\n")))
        self.assert_refused(s, key="bad_ref")


class EffectiveComposeTests(RefusalTests):
    """The verified digest must be the image Compose would start."""

    def test_interpolated_image(self):
        s = gh_system()
        s.files[COMPOSE] = compose_text('"${SPROUTWALL_IMAGE:-ghcr.io/thebrianlee/sproutwall@' + DIGEST + '}"')
        self.assert_refused(s, key="interpolated")

    def test_extra_service_including_profiled_ones(self):
        s = gh_system()
        s.set(compose.config_argv(COMPOSE), ok(compose_config_json(extra_services={"sidecar": {"image": "busybox", "profiles": ["x"]}})))
        self.assert_refused(s, key="services")
        s = gh_system()
        s.set(compose.config_argv(COMPOSE), ok('{"services":{"hub":{"image":"ghcr.io/thebrianlee/sproutwall@' + DIGEST + '"}}}'))
        self.assert_refused(s, key="services")

    def test_build_key(self):
        s = gh_system()
        s.set(compose.config_argv(COMPOSE), ok(compose_config_json(build={"context": "."})))
        self.assert_refused(s, key="build")

    def test_digest_mismatch_between_file_and_effective_config(self):
        s = gh_system()
        s.set(compose.config_argv(COMPOSE), ok(compose_config_json(image="ghcr.io/thebrianlee/sproutwall@sha256:" + "f" * 64)))
        self.assert_refused(s, key="mismatch_effective")
        s = gh_system()
        s.set(compose.config_argv(COMPOSE), ok(compose_config_json(image="ghcr.io/thebrianlee/sproutwall:preview")))
        self.assert_refused(s, key="tag_only")

    def test_missing_docker_or_failing_compose(self):
        s = gh_system()
        s.set(compose.config_argv(COMPOSE), CommandResult(None, missing=True))
        self.assert_refused(s, key="docker_missing")
        s = gh_system()
        s.set(compose.config_argv(COMPOSE), ok("", "yaml: line 3", rc=15))
        self.assert_refused(s, key="compose_failed")
        s = gh_system()
        s.set(compose.config_argv(COMPOSE), ok("not json"))
        self.assert_refused(s, key="compose_failed")

    def test_compose_reads_only_this_file_with_all_profiles(self):
        s = gh_system()
        env = {"PATH": "/usr/bin", "COMPOSE_FILE": "/tmp/other.yml", "COMPOSE_PROFILES": "extra", "COMPOSE_PROJECT_NAME": "sproutwall"}
        with mock.patch.dict(os.environ, env, clear=True):
            vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=fake_fetch)
        argv, call_env = [c for c in s.calls if c[0][:2] == ("docker", "compose")][0]
        self.assertEqual(list(argv), ["docker", "compose", "-f", COMPOSE, "--profile", "*", "config", "--format", "json"])
        self.assertNotIn("COMPOSE_FILE", call_env)
        self.assertNotIn("COMPOSE_PROFILES", call_env)
        self.assertEqual(call_env["COMPOSE_PROJECT_NAME"], "sproutwall")

    def test_missing_bundle_or_root_file(self):
        self.assert_refused(gh_system(), key="bad_file", bundle="/tmp/no-such-bundle.jsonl")
        self.assert_refused(gh_system(), key="bad_file", trusted_root="/tmp/no-such-root.jsonl")


class GhVersionGateTests(unittest.TestCase):
    def test_missing_gh(self):
        s = gh_system(version=None)
        code, key, _ = vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=fake_fetch)
        self.assertEqual((code, key), (vi.EXIT_TOOL, "gh_missing"))

    def test_old_or_unreadable_gh(self):
        for version in ("gh version 2.46.0 (2024-03-01)\n", "gh version 2.67.9 (2025-02-01)\n", "gh 2.89\n", ""):
            s = gh_system(version=version)
            code, key, _ = vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=fake_fetch)
            self.assertEqual((code, key), (vi.EXIT_TOOL, "gh_old"), version)
            self.assertEqual([c[0][:3] for c in s.calls if c[0][0] == "gh"], [("gh", "--version")])

    def test_minimum_version_passes_the_gate(self):
        s = gh_system(version="gh version 2.68.0 (2025-03-05)\n")
        code, _, _ = vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=fake_fetch)
        self.assertEqual(code, vi.EXIT_VERIFIED)


class VerifyRunTests(unittest.TestCase):
    def setUp(self):
        self.seen = {}

    def recording_gh(self, rc=0):
        def verify(argv, env):
            bundle_path = argv[argv.index("--bundle") + 1]
            self.seen["argv"] = list(argv)
            self.seen["env"] = env
            self.seen["bundle_path"] = bundle_path
            self.seen["config_dir"] = env["GH_CONFIG_DIR"]
            self.seen["config_exists"] = os.path.isdir(env["GH_CONFIG_DIR"])
            if os.path.exists(bundle_path):
                self.seen["mode"] = stat.S_IMODE(os.stat(bundle_path).st_mode)
                with open(bundle_path, encoding="utf-8") as handle:
                    self.seen["lines"] = [json.loads(line) for line in handle.read().splitlines()]
            return CommandResult(rc, TOKEN + " stdout", "error near " + TOKEN)

        return verify

    def test_exact_argument_list_and_isolated_environment(self):
        s = gh_system(verify=self.recording_gh())
        env = {"PATH": "/usr/bin", "GH_TOKEN": TOKEN, "GITHUB_TOKEN": TOKEN, "GH_ENTERPRISE_TOKEN": TOKEN,
               "GITHUB_ENTERPRISE_TOKEN": TOKEN, "GH_HOST": "example.ghe.test", "GH_CONFIG_DIR": "/home/pi/.config/gh"}
        with mock.patch.dict(os.environ, env, clear=True):
            code, key, digest = vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=fake_fetch)
        self.assertEqual((code, key, digest), (vi.EXIT_VERIFIED, "verified", DIGEST))
        self.assertEqual(
            self.seen["argv"],
            [
                "gh", "attestation", "verify",
                "oci://ghcr.io/thebrianlee/sproutwall@sha256:" + "0123456789abcdef" * 4,
                "-R", "thebrianlee/sproutwall",
                "--signer-workflow", "thebrianlee/sproutwall/.github/workflows/image.yml",
                "--source-digest", SOURCE_SHA,
                "--bundle", self.seen["bundle_path"],
            ],
        )
        for name in vi.GH_ACCOUNT_VARS:
            self.assertNotIn(name, self.seen["env"])
        self.assertNotEqual(self.seen["config_dir"], "/home/pi/.config/gh")
        self.assertTrue(self.seen["config_exists"])
        self.assertEqual(self.seen["env"]["PATH"], "/usr/bin")
        self.assertEqual(self.seen["mode"], 0o600)
        self.assertEqual(self.seen["lines"], BUNDLES)
        self.assertFalse(os.path.exists(self.seen["bundle_path"]))
        self.assertFalse(os.path.exists(self.seen["config_dir"]))

    def test_pure_argument_builder(self):
        self.assertEqual(
            vi.gh_verify_argv(DIGEST, SOURCE_SHA, "/tmp/b.jsonl", trusted_root="/media/usb/trusted_root.jsonl")[-4:],
            ["--bundle", "/tmp/b.jsonl", "--custom-trusted-root", "/media/usb/trusted_root.jsonl"],
        )
        self.assertTrue(vi.gh_verify_argv(DIGEST, SOURCE_SHA, "b")[3].endswith("@sha256:" + DIGEST[7:]))

    def test_cleanup_failure_is_its_own_exit_even_after_success(self):
        for rc in (0, 1):
            s = gh_system(verify=self.recording_gh(rc=rc))
            with mock.patch.object(vi.shutil, "rmtree", lambda *a, **k: None):
                code, key, digest = vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=fake_fetch)
            leftover = os.path.dirname(self.seen["bundle_path"])
            try:
                self.assertEqual((code, key, digest), (vi.EXIT_CLEANUP, "cleanup", None))
                self.assertTrue(os.path.exists(leftover))
            finally:
                import shutil

                shutil.rmtree(leftover, ignore_errors=True)
        self.assertEqual(vi.EXIT_CLEANUP, 5)

    def test_temp_files_removed_on_failure(self):
        s = gh_system(verify=self.recording_gh(rc=1))
        code, key, digest = vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=fake_fetch)
        self.assertEqual((code, key, digest), (vi.EXIT_NOT_VERIFIED, "gh_failed", None))
        self.assertTrue(self.seen["lines"])
        self.assertFalse(os.path.exists(self.seen["bundle_path"]))
        self.assertFalse(os.path.exists(os.path.dirname(self.seen["bundle_path"])))

    def test_timeout_and_vanished_gh(self):
        s = gh_system(verify=CommandResult(None, timed_out=True))
        self.assertEqual(vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=fake_fetch)[:2], (vi.EXIT_NOT_VERIFIED, "gh_timeout"))
        s = gh_system(verify=CommandResult(None, missing=True))
        self.assertEqual(vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=fake_fetch)[:2], (vi.EXIT_TOOL, "gh_missing"))

    def test_bundle_fetch_failure_starts_nothing(self):
        for error_code, key in (("none", "no_bundle"), ("http", "no_bundle"), ("token", "no_bundle"), ("digest", "bad_bundle"), ("size", "bad_bundle")):
            def failing(digest, opener=None, code=error_code):
                raise attestation.BundleError(code)

            s = gh_system()
            code, got_key, _ = vi.verify_image(s, COMPOSE, SOURCE_SHA, fetch=failing)
            self.assertEqual((code, got_key), (vi.EXIT_NO_BUNDLE, key))
            self.assertEqual([c[0][:3] for c in s.calls if c[0][0] == "gh"], [("gh", "--version")], "gh verify never runs")

    def test_given_bundle_and_trusted_root_skip_the_fetch(self):
        def no_fetch(digest, opener=None):
            raise AssertionError("must not fetch")

        s = gh_system(verify=self.recording_gh())
        s.files["/media/usb/sproutwall.attestation.jsonl"] = "{}\n"
        s.files["/media/usb/trusted_root.jsonl"] = "{}\n"
        code, _, _ = vi.verify_image(
            s, COMPOSE, SOURCE_SHA, bundle="/media/usb/sproutwall.attestation.jsonl",
            trusted_root="/media/usb/trusted_root.jsonl", fetch=no_fetch,
        )
        self.assertEqual(code, vi.EXIT_VERIFIED)
        self.assertEqual(self.seen["argv"][-4:], ["--bundle", "/media/usb/sproutwall.attestation.jsonl",
                                                  "--custom-trusted-root", "/media/usb/trusted_root.jsonl"])


class CliOutputTests(unittest.TestCase):
    def run_cli(self, argv, system, fetch=fake_fetch):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(attestation, "fetch_bundles", fetch):
            code = cli.main(argv, system=system, root=ROOT, out=out, err=err)
        return code, out.getvalue(), err.getvalue()

    def test_success_prints_only_the_validated_pair(self):
        code, out, err = self.run_cli(["verify-image", "--source-sha", SOURCE_SHA], gh_system(verify=ok(TOKEN, TOKEN)))
        self.assertEqual(code, 0)
        self.assertIn(DIGEST, out)
        self.assertIn(SOURCE_SHA, out)
        self.assertNotIn(TOKEN, out + err)

    def test_start_command_uses_exactly_the_verified_file(self):
        code, out, _ = self.run_cli(["verify-image", "--source-sha", SOURCE_SHA], gh_system())
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines()[-1], "Next: docker compose -f docker-compose.preview.yml up -d --wait")
        self.assertEqual(os.path.basename(COMPOSE), "docker-compose.preview.yml")
        self.assertEqual(compose.compose_path(ROOT), COMPOSE)

    def test_cleanup_failure_message_is_fixed(self):
        import tempfile as real_tempfile

        with real_tempfile.TemporaryDirectory() as own:
            original = real_tempfile.mkdtemp
            make = lambda prefix: original(prefix=prefix, dir=own)  # noqa: E731
            with mock.patch.object(vi.shutil, "rmtree", lambda *a, **k: None), mock.patch.object(vi.tempfile, "mkdtemp", make):
                code, out, err = self.run_cli(["verify-image", "--source-sha", SOURCE_SHA], gh_system())
            self.assertTrue(os.listdir(own), "the work folder was left behind")
        self.assertEqual(code, vi.EXIT_CLEANUP)
        self.assertEqual(out, "")
        self.assertNotIn(own, err)
        self.assertIn("sproutwall-verify-*", err)

    def test_failure_prints_fixed_text_without_tokens_or_urls(self):
        def leaky_fetch(digest, opener=None):
            raise attestation.BundleError("http")

        for system, fetch in ((gh_system(verify=ok(TOKEN, "bad " + TOKEN, rc=1)), fake_fetch), (gh_system(), leaky_fetch)):
            code, out, err = self.run_cli(["verify-image", "--source-sha", SOURCE_SHA], system, fetch)
            self.assertNotEqual(code, 0)
            self.assertEqual(out, "")
            for leak in (TOKEN, "?", "scope=", "https://ghcr.io/token"):
                self.assertNotIn(leak, err)

    def test_bad_input_is_not_echoed(self):
        code, out, err = self.run_cli(["verify-image", "--source-sha", "Riley-" + TOKEN], gh_system())
        self.assertEqual(code, vi.EXIT_REFUSED)
        self.assertNotIn(TOKEN, out + err)
        code, out, err = self.run_cli(["verify-image", "--source-sha", SOURCE_SHA, "--bundle", "/tmp/Quinn/" + TOKEN], gh_system())
        self.assertEqual(code, vi.EXIT_REFUSED)
        self.assertNotIn("Quinn", out + err)
        code, out, err = self.run_cli(["verify-image", "--pin", "482915"], gh_system())
        self.assertEqual(code, 2)
        self.assertNotIn("482915", out + err)


if __name__ == "__main__":
    unittest.main()
