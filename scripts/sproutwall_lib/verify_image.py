"""`sproutwall verify-image`: attestation check of the pinned preview image.

It reads the digest pinned in docker-compose.preview.yml (never a tag), checks
that gh is new enough, gets the attestation bundle anonymously from GHCR (or
from --bundle), and runs the spec 4.2 step 4 command with `--bundle`, the only
gh mode that needs no `gh auth login`. gh runs with a fresh, empty config
folder and no token variables, so the result never depends on a login.

It starts nothing. Any refusal, missing tool, missing bundle or failed check
exits non-zero. gh's own output and anything fetched are never printed; all
messages are fixed text.
"""

import os
import re
import shutil
import tempfile

from . import attestation, compose
from .system import command_env

SOURCE_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
GH_VERSION_RE = re.compile(r"^gh version (\d+)\.(\d+)\.(\d+)\b")
MIN_GH_VERSION = (2, 68, 0)  # first release with --source-digest
OWNER_REPO = "thebrianlee/sproutwall"
SIGNER_WORKFLOW = OWNER_REPO + "/.github/workflows/image.yml"
GH_TIMEOUT_S = 300.0
# Variables that would let gh use an account or another GitHub host.
GH_ACCOUNT_VARS = ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST")
BUNDLE_FILE = "attestation.jsonl"

EXIT_VERIFIED = 0
EXIT_NOT_VERIFIED = 1
EXIT_REFUSED = 2
EXIT_TOOL = 3
EXIT_NO_BUNDLE = 4

MESSAGES = {
    "bad_sha": "Refused: --source-sha must be the full 40-character lowercase commit SHA from the guide.",
    "bad_digest": "Refused: --digest must be sha256: followed by 64 lowercase hex characters.",
    "bad_file": "Refused: the file given with --bundle or --trusted-root was not found.",
    "missing": "Refused: docker-compose.preview.yml was not found next to scripts/.",
    "unreadable": "Refused: docker-compose.preview.yml could not be read.",
    "no_image": "Refused: docker-compose.preview.yml must have exactly one image line.",
    "placeholder": (
        "Refused: docker-compose.preview.yml still has the placeholder digest. No preview image is "
        "pinned in this checkout; use the compose file for the published pair in the guide."
    ),
    "tag_only": (
        "Refused: the image in docker-compose.preview.yml is not pinned by digest (image@sha256:...). "
        "A tag such as :preview is never trusted."
    ),
    "wrong_repo": "Refused: the image in docker-compose.preview.yml is not " + compose.REPOSITORY + ".",
    "bad_ref": "Refused: the image line in docker-compose.preview.yml is not a valid pinned reference.",
    "mismatch": "Refused: the digest in docker-compose.preview.yml is not the published digest given with --digest.",
    "gh_missing": (
        "Not verified: the GitHub CLI (gh) was not found. Install gh %d.%d.%d or newer from GitHub's "
        "package repository, then run this again. Do not start the hub." % MIN_GH_VERSION
    ),
    "gh_old": (
        "Not verified: this gh is older than %d.%d.%d (or its version could not be read). Install a newer "
        "gh from GitHub's package repository, then run this again. Do not start the hub." % MIN_GH_VERSION
    ),
    "no_bundle": (
        "Not verified: the attestation bundle could not be downloaded from the registry (no network, "
        "refused, or no attestation for this digest). Do not start the hub."
    ),
    "bad_bundle": (
        "Not verified: the downloaded attestation did not match its registry digest or size limits. "
        "Do not start the hub."
    ),
    "gh_timeout": "Not verified: the attestation check did not finish in time. Do not start the hub.",
    "gh_failed": (
        "Not verified: the attestation check did not pass (wrong digest, missing or untrusted "
        "attestation, wrong workflow or source commit, or no registry access). Do not start the hub."
    ),
}


def gh_verify_argv(digest, source_sha, bundle_path, trusted_root=None):
    """The exact verifier command (spec 4.2 step 4, account-free form).

    The one place that builds it. digest: "sha256:<64 hex>" from the compose
    pin (the prefix is required). source_sha: the published 40-hex commit.
    The OCI reference names the digest only, so no tag is ever resolved.
    trusted_root: optional Sigstore trusted root for an offline Pi.
    """
    argv = [
        "gh",
        "attestation",
        "verify",
        "oci://" + compose.REPOSITORY + "@" + digest,
        "-R",
        OWNER_REPO,
        "--signer-workflow",
        SIGNER_WORKFLOW,
        "--source-digest",
        source_sha,
        "--bundle",
        bundle_path,
    ]
    if trusted_root is not None:
        argv += ["--custom-trusted-root", trusted_root]
    return argv


def gh_env(base_env, config_dir):
    """base_env without any account variable, with a fresh gh config folder."""
    env = {key: value for key, value in base_env.items() if key not in GH_ACCOUNT_VARS}
    env["GH_CONFIG_DIR"] = config_dir
    return env


def gh_version_ok(version_output):
    match = GH_VERSION_RE.match(version_output.strip())
    return bool(match) and tuple(int(part) for part in match.groups()) >= MIN_GH_VERSION


def _write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


def verify_image(
    system,
    compose_file,
    source_sha,
    published_digest=None,
    bundle=None,
    trusted_root=None,
    opener=None,
    fetch=None,
):
    """(exit code, message key, verified digest or None). Starts nothing."""
    if not isinstance(source_sha, str) or not SOURCE_SHA_RE.match(source_sha):
        return EXIT_REFUSED, "bad_sha", None
    if published_digest is not None and (
        not isinstance(published_digest, str) or not compose.DIGEST_RE.match(published_digest)
    ):
        return EXIT_REFUSED, "bad_digest", None
    try:
        digest = compose.read_pinned_digest(system, compose_file)
    except compose.ComposeError as error:
        return EXIT_REFUSED, error.code, None
    if published_digest is not None and published_digest != digest:
        return EXIT_REFUSED, "mismatch", None
    for path in (bundle, trusted_root):
        if path is not None and not system.is_file(path):
            return EXIT_REFUSED, "bad_file", None

    version = system.run(["gh", "--version"], timeout=30.0)
    if version.missing:
        return EXIT_TOOL, "gh_missing", None
    if version.rc != 0 or not gh_version_ok(version.out):
        return EXIT_TOOL, "gh_old", None

    workdir = tempfile.mkdtemp(prefix="sproutwall-verify-")  # mode 0700
    try:
        if bundle is None:
            try:
                bundles = (fetch or attestation.fetch_bundles)(digest, opener=opener)
            except attestation.BundleError as error:
                key = "bad_bundle" if error.code in ("digest", "size") else "no_bundle"
                return EXIT_NO_BUNDLE, key, None
            bundle_path = os.path.join(workdir, BUNDLE_FILE)
            _write_private(bundle_path, attestation.jsonl(bundles))
        else:
            bundle_path = bundle
        config_dir = os.path.join(workdir, "gh-config")
        os.mkdir(config_dir, 0o700)
        result = system.run(
            gh_verify_argv(digest, source_sha, bundle_path, trusted_root),
            timeout=GH_TIMEOUT_S,
            env=gh_env(command_env(), config_dir),
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    if result.missing:
        return EXIT_TOOL, "gh_missing", None
    if result.timed_out:
        return EXIT_NOT_VERIFIED, "gh_timeout", None
    if result.rc != 0:
        return EXIT_NOT_VERIFIED, "gh_failed", None
    return EXIT_VERIFIED, "verified", digest


def verified_lines(digest, source_sha):
    # Both values were validated as lowercase hex; nothing else is echoed.
    return [
        "Verified: %s@%s" % (compose.REPOSITORY, digest),
        "  signed by %s, built from commit %s." % (SIGNER_WORKFLOW, source_sha),
        "Next: docker compose -f docker-compose.preview.yml up -d --wait",
    ]
