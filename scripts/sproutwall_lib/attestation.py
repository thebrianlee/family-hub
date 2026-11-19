"""Anonymous download of the image's Sigstore attestation bundle from GHCR.

The image workflow (actions/attest-build-provenance, push-to-registry) stores
the bundle in GHCR as an OCI referrer of the image index digest. This module
fetches it with no account, so `gh attestation verify --bundle FILE` can run
without `gh auth login`:

  1. anonymous pull token:  GET https://ghcr.io/token?scope=...&service=ghcr.io
  2. referrers of digest:   GET /v2/<repo>/referrers/<digest>
                            (404 -> the OCI tag fallback sha256-<hex>, as gh's
                            own registry client does)
  3. for each referrer whose artifactType is a Sigstore bundle:
       GET /v2/<repo>/manifests/<referrer digest>, checked against its digest
       GET /v2/<repo>/blobs/<bundle layer digest>, checked against its digest

HTTPS only, with timeouts and size caps on every response. Redirects are
never followed automatically. A blob download alone may take one hop to
BLOB_REDIRECT_HOST (GHCR serves blobs from signed URLs there); that request
carries no Authorization header and may not redirect again. The sha256 check
on the bytes is what makes the host choice safe. A bundle proves nothing by
itself; gh verifies its signature, signer workflow and source commit. Errors
carry a fixed code only, never a URL, token or response text.
"""

import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request

REGISTRY = "ghcr.io"
REPOSITORY_PATH = "thebrianlee/sproutwall"
TOKEN_URL = "https://ghcr.io/token?scope=repository:thebrianlee/sproutwall:pull&service=ghcr.io"
V2 = "https://ghcr.io/v2/" + REPOSITORY_PATH
# The one host a blob download may be redirected to, matched exactly.
BLOB_REDIRECT_HOST = "pkg-containers.githubusercontent.com"
_REDIRECT_CODES = (301, 302, 303, 307, 308)

INDEX_TYPE = "application/vnd.oci.image.index.v1+json"
MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json"
BUNDLE_TYPE_PREFIX = "application/vnd.dev.sigstore.bundle"

TIMEOUT_S = 20.0
MAX_TOKEN_BYTES = 64 * 1024
MAX_INDEX_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 256 * 1024
MAX_BUNDLE_BYTES = 1024 * 1024
MAX_REFERRERS = 16

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_TOKEN = re.compile(r"^[A-Za-z0-9._~+/=-]{1,8192}$")


class BundleError(Exception):
    """code: token, http, format, digest, size, none."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class _Redirect(Exception):
    def __init__(self, location):
        super().__init__("redirect")
        self.location = location


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect; urllib then raises HTTPError and _get decides."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def default_opener():
    return urllib.request.build_opener(_NoRedirects())


def _get(opener, url, cap, headers=None, host=REGISTRY, allow_redirect=False):
    """The body of one GET. A redirect raises _Redirect if allow_redirect, else fails."""
    if not url.startswith("https://" + host + "/"):
        raise BundleError("http")
    request = urllib.request.Request(url, headers=dict(headers or {}), method="GET")
    try:
        with opener.open(request, timeout=TIMEOUT_S) as response:
            status = getattr(response, "status", None) or response.getcode()
            if status != 200:
                raise BundleError("http")
            length = response.headers.get("Content-Length") if response.headers is not None else None
            if length is not None and length.isdigit() and int(length) > cap:
                raise BundleError("size")
            data = response.read(cap + 1)
    except urllib.error.HTTPError as error:
        if error.code in _REDIRECT_CODES and allow_redirect:
            location = error.headers.get("Location") if error.headers is not None else None
            raise _Redirect(location) from None
        raise BundleError("not_found" if error.code == 404 else "http") from None
    except BundleError:
        raise
    except Exception:  # noqa: BLE001 - network errors become a fixed code
        raise BundleError("http") from None
    if len(data) > cap:
        raise BundleError("size")
    return data


def _json(data):
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise BundleError("format") from None
    if not isinstance(value, dict):
        raise BundleError("format")
    return value


def _check_digest(data, digest):
    if "sha256:" + hashlib.sha256(data).hexdigest() != digest:
        raise BundleError("digest")


def _descriptor(entry, cap):
    if not isinstance(entry, dict):
        raise BundleError("format")
    digest, size = entry.get("digest"), entry.get("size")
    if not isinstance(digest, str) or not _DIGEST.match(digest):
        raise BundleError("format")
    if type(size) is not int or size < 0:
        raise BundleError("format")
    if size > cap:
        raise BundleError("size")
    return digest


def _blob_redirect_target(location):
    """The redirect target if it is https://BLOB_REDIRECT_HOST/..., else BundleError."""
    if not isinstance(location, str):
        raise BundleError("http")
    try:
        parts = urllib.parse.urlsplit(location)
    except ValueError:
        raise BundleError("http") from None
    if parts.scheme != "https" or parts.netloc != BLOB_REDIRECT_HOST:
        raise BundleError("http")
    return location


def _get_blob(opener, digest, auth):
    url = V2 + "/blobs/" + digest
    try:
        return _get(opener, url, MAX_BUNDLE_BYTES, {"Authorization": auth}, allow_redirect=True)
    except _Redirect as hop:
        target = _blob_redirect_target(hop.location)
    # One hop, no Authorization header, and no further redirect.
    return _get(opener, target, MAX_BUNDLE_BYTES, None, host=BLOB_REDIRECT_HOST)


def _token(opener):
    data = _json(_get(opener, TOKEN_URL, MAX_TOKEN_BYTES))
    token = data.get("token") or data.get("access_token")
    if not isinstance(token, str) or not _TOKEN.match(token):
        raise BundleError("token")
    return token


def _referrers(opener, digest, auth):
    headers = {"Accept": INDEX_TYPE, "Authorization": auth}
    try:
        data = _get(opener, V2 + "/referrers/" + digest, MAX_INDEX_BYTES, headers)
    except BundleError as error:
        if error.code != "not_found":
            raise
        try:
            data = _get(opener, V2 + "/manifests/" + digest.replace(":", "-"), MAX_INDEX_BYTES, headers)
        except BundleError as fallback_error:
            raise BundleError("none" if fallback_error.code == "not_found" else fallback_error.code) from None
    manifests = _json(data).get("manifests")
    if not isinstance(manifests, list):
        raise BundleError("format")
    return [
        entry
        for entry in manifests
        if isinstance(entry, dict) and str(entry.get("artifactType", "")).startswith(BUNDLE_TYPE_PREFIX)
    ]


def fetch_bundles(digest, opener=None):
    """[bundle dict] attached to the image digest, or BundleError. Never empty."""
    if not isinstance(digest, str) or not _DIGEST.match(digest):
        raise BundleError("format")
    opener = opener or default_opener()
    try:
        auth = "Bearer " + _token(opener)
    except BundleError as error:
        raise BundleError("token" if error.code in ("http", "not_found", "format") else error.code) from None
    bundles = []
    for entry in _referrers(opener, digest, auth)[:MAX_REFERRERS]:
        manifest_digest = _descriptor(entry, MAX_MANIFEST_BYTES)
        raw = _get(opener, V2 + "/manifests/" + manifest_digest, MAX_MANIFEST_BYTES, {"Accept": MANIFEST_TYPE, "Authorization": auth})
        _check_digest(raw, manifest_digest)
        layers = _json(raw).get("layers")
        if not isinstance(layers, list):
            raise BundleError("format")
        for layer in layers:
            if not isinstance(layer, dict) or not str(layer.get("mediaType", "")).startswith(BUNDLE_TYPE_PREFIX):
                continue
            blob_digest = _descriptor(layer, MAX_BUNDLE_BYTES)
            blob = _get_blob(opener, blob_digest, auth)
            _check_digest(blob, blob_digest)
            bundles.append(_json(blob))
    if not bundles:
        raise BundleError("none")
    return bundles


def jsonl(bundles):
    """One compact JSON bundle per line, as `gh attestation verify --bundle` reads it."""
    return "".join(json.dumps(bundle, separators=(",", ":"), ensure_ascii=True) + "\n" for bundle in bundles)
