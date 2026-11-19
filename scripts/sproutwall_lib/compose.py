"""The image docker-compose.preview.yml would start, and its pinned digest.

Two sources must agree:

1. The file's one literal `image:` line (the standard library has no YAML
   parser), of the form ghcr.io/thebrianlee/sproutwall[:<tag>]@sha256:<hex>.
   An interpolated line (`$`) is refused: the image would then depend on the
   environment of whoever runs `docker compose up`.
2. The effective configuration from `docker compose -f <file> --profile "*"
   config --format json`, which applies interpolation, includes and
   extends. It must have exactly one service, family-hub, with no build, and
   the same pinned digest. All profiles are enabled so that a profiled extra
   service also counts. COMPOSE_FILE and COMPOSE_PROFILES are removed from
   Docker's environment, so only this file is read (the start command passes
   the same `-f`, which takes precedence over COMPOSE_FILE).

The tag is only for readability; Docker selects by the digest. As committed,
the file always carries PLACEHOLDER_TOKEN instead of the hex digest (a commit
cannot contain the digest of the image built from it); every reader refuses
it, and Docker rejects it as a reference. The install guide writes the real
digest into the checkout on the device.
"""

import json
import os
import re

from .system import command_env

PREVIEW_COMPOSE = "docker-compose.preview.yml"
SERVICE = "family-hub"
REPOSITORY = "ghcr.io/thebrianlee/sproutwall"
PLACEHOLDER_TOKEN = "<published-index-digest-hex>"
COMPOSE_ENV_REMOVED = ("COMPOSE_FILE", "COMPOSE_PROFILES")
START_COMMAND = "docker compose -f " + PREVIEW_COMPOSE + " up -d --wait"

_IMAGE_LINE = re.compile(r"""\s*image\s*:\s*(?P<value>"[^"]*"|'[^']*'|[^\s#"']+)\s*(?:#.*)?""", re.ASCII)
_IMAGE_KEY = re.compile(r"\s*image\s*:", re.ASCII)
_TAG = r"(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?"
_PINNED = re.compile(_TAG + r"@(?P<digest>sha256:[0-9a-f]{64})", re.ASCII)
_TAG_ONLY = re.compile(_TAG, re.ASCII)
DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}", re.ASCII)


class ComposeError(Exception):
    """code: missing, unreadable, no_image, interpolated, placeholder, tag_only,
    wrong_repo, bad_ref, docker_missing, compose_failed, services, build, mismatch_effective."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# Codes that mean "could not look", not "looked and it is wrong".
UNAVAILABLE = ("unreadable", "docker_missing", "compose_failed")


def compose_path(root):
    return os.path.join(root, PREVIEW_COMPOSE)


def compose_env(base_env):
    return {key: value for key, value in base_env.items() if key not in COMPOSE_ENV_REMOVED}


def config_argv(path):
    return ["docker", "compose", "-f", path, "--profile", "*", "config", "--format", "json"]


def is_digest(value):
    return isinstance(value, str) and DIGEST_RE.fullmatch(value) is not None


def image_reference(text):
    values = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        match = _IMAGE_LINE.fullmatch(line)
        if match:
            values.append(match.group("value").strip("\"'"))
        elif _IMAGE_KEY.match(line):
            raise ComposeError("bad_ref")
    if len(values) != 1:
        raise ComposeError("no_image")
    return values[0]


def pinned_digest(reference):
    """The sha256:<hex> digest a reference is pinned to, or ComposeError."""
    if not isinstance(reference, str):
        raise ComposeError("no_image")
    if "$" in reference:
        raise ComposeError("interpolated")
    if PLACEHOLDER_TOKEN in reference or "<" in reference or ">" in reference:
        raise ComposeError("placeholder")
    if not reference.startswith(REPOSITORY):
        raise ComposeError("wrong_repo")
    rest = reference[len(REPOSITORY) :]
    match = _PINNED.fullmatch(rest)
    if match:
        return match.group("digest")
    if _TAG_ONLY.fullmatch(rest):
        raise ComposeError("tag_only")
    if rest[:1] not in (":", "@"):
        raise ComposeError("wrong_repo")
    raise ComposeError("bad_ref")


def read_pinned_digest(system, path):
    """Source 1: the literal image line."""
    try:
        text = system.read_text(path)
    except FileNotFoundError:
        raise ComposeError("missing") from None
    except OSError:
        raise ComposeError("unreadable") from None
    return pinned_digest(image_reference(text))


def effective_pinned_digest(system, path):
    """The digest Compose would start from path: both sources, which must agree."""
    literal = read_pinned_digest(system, path)
    result = system.run(config_argv(path), timeout=60.0, env=compose_env(command_env()))
    if result.missing:
        raise ComposeError("docker_missing")
    if result.rc != 0:
        raise ComposeError("compose_failed")
    try:
        config = json.loads(result.out)
    except ValueError:
        raise ComposeError("compose_failed") from None
    services = config.get("services") if isinstance(config, dict) else None
    if not isinstance(services, dict) or list(services) != [SERVICE]:
        raise ComposeError("services")
    service = services[SERVICE]
    if not isinstance(service, dict) or "build" in service:
        raise ComposeError("build")
    if pinned_digest(service.get("image")) != literal:
        raise ComposeError("mismatch_effective")
    return literal
