"""verify-image: refusals, the gh version gate, the exact argument list, the
isolated gh environment and temp-file cleanup. No network: the bundle fetch
is replaced by a fake."""

import io
import json
import os
import stat
import unittest
from unittest import mock

from sproutwall_lib import attestation, cli, verify_image as vi
from sproutwall_lib.system import CommandResult

from .fakes import COMPOSE, DIGEST, ROOT, SOURCE_SHA, FakeSystem, compose_text, ok

TOKEN = "canary" + "ghtoken" + "0quinn"
BUNDLES = [{"mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json", "n": 1}, {"n": 2}]


def gh_system(verify=None, version="gh version 2.89.0 (2026-03-26)\nhttps://github.com/cli/cli/releases/tag/v2.89.0\n"):
    s = FakeSystem()
    s.files[COMPOSE] = compose_text()
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
        self.assertEqual(system.calls, [], "nothing runs after a refusal")

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
        for sha in ("", "5972e3e", SOURCE_SHA.upper(), SOURCE_SHA + "0", SOURCE_SHA[:-1] + "g", "main", None):
            self.assert_refused(gh_system(), sha=sha, key="bad_sha")

    def test_published_digest_must_match(self):
        self.assert_refused(gh_system(), key="mismatch", published_digest="sha256:" + "f" * 64)
        self.assert_refused(gh_system(), key="bad_digest", published_digest="preview")

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
            self.assertEqual([c[0][:3] for c in s.calls], [("gh", "--version")])

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
            self.assertEqual([c[0][:3] for c in s.calls], [("gh", "--version")], "gh verify never runs")

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
