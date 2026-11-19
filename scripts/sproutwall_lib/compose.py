"""Reading the digest pinned in docker-compose.preview.yml.

The standard library has no YAML parser, so this reads the one `image:` line.
The file must have exactly one, of the form

    ghcr.io/thebrianlee/sproutwall[:<tag>]@sha256:<64 lowercase hex>

The tag is only for readability; Docker selects by the digest. Until the
first preview image is published, the file carries PLACEHOLDER_TOKEN instead of
the hex digest. Every reader refuses it (and Docker rejects it as an invalid
reference, so nothing can start from it by accident).
"""

import os
import re

PREVIEW_COMPOSE = "docker-compose.preview.yml"
REPOSITORY = "ghcr.io/thebrianlee/sproutwall"
PLACEHOLDER_TOKEN = "<published-index-digest-hex>"

_IMAGE_LINE = re.compile(r"""^\s*image\s*:\s*(?P<value>"[^"]*"|'[^']*'|[^\s#"']+)\s*(?:#.*)?$""")
_TAG = r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}"
_PINNED = re.compile(r"^(?::" + _TAG + r")?@(?P<digest>sha256:[0-9a-f]{64})$")
_TAG_ONLY = re.compile(r"^(?::" + _TAG + r")?$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class ComposeError(Exception):
    """code: missing, unreadable, no_image, placeholder, tag_only, wrong_repo, bad_ref."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def compose_path(root):
    return os.path.join(root, PREVIEW_COMPOSE)


def image_reference(text):
    values = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        match = _IMAGE_LINE.match(line)
        if match:
            values.append(match.group("value").strip("\"'"))
        elif re.match(r"^\s*image\s*:", line):
            raise ComposeError("bad_ref")
    if len(values) != 1:
        raise ComposeError("no_image")
    return values[0]


def pinned_digest(reference):
    """The sha256:<hex> digest a reference is pinned to, or ComposeError."""
    if PLACEHOLDER_TOKEN in reference or "<" in reference or ">" in reference:
        raise ComposeError("placeholder")
    if not reference.startswith(REPOSITORY):
        raise ComposeError("wrong_repo")
    rest = reference[len(REPOSITORY) :]
    match = _PINNED.match(rest)
    if match:
        return match.group("digest")
    if _TAG_ONLY.match(rest):
        raise ComposeError("tag_only")
    if rest[:1] not in (":", "@"):
        raise ComposeError("wrong_repo")
    raise ComposeError("bad_ref")


def read_pinned_digest(system, path):
    try:
        text = system.read_text(path)
    except FileNotFoundError:
        raise ComposeError("missing") from None
    except OSError:
        raise ComposeError("unreadable") from None
    return pinned_digest(image_reference(text))
