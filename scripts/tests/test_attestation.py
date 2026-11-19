"""Anonymous GHCR bundle fetch, driven by a fake urllib opener (no network)."""

import hashlib
import json
import unittest
import urllib.error
import urllib.request

from sproutwall_lib import attestation
from sproutwall_lib.attestation import BundleError, fetch_bundles

from .fakes import DIGEST

TOKEN = "canary" + "pulltoken" + "0riley"
V2 = attestation.V2
BUNDLE = {"mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json", "verificationMaterial": {}, "dsseEnvelope": {}}


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self.body = body
        self.headers = {"Content-Length": str(len(body))}

    def read(self, size=-1):
        return self.body if size < 0 else self.body[:size]

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpener:
    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append((request.full_url, dict(request.header_items()), timeout))
        route = self.routes.get(request.full_url)
        if route is None:
            raise urllib.error.HTTPError(request.full_url, 404, "not found", {}, None)
        if isinstance(route, BaseException):
            raise route
        status, body = route
        if status in (301, 302, 303, 307, 308):
            raise urllib.error.HTTPError(request.full_url, status, "redirect", {"Location": body}, None)
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "error " + TOKEN, {}, None)
        return FakeResponse(status, body)


def registry(bundle_bytes=None, blob_digest=None, extra_referrers=(), referrers_status=200):
    """Routes for a registry with one Sigstore bundle referrer."""
    blob = bundle_bytes if bundle_bytes is not None else json.dumps(BUNDLE, indent=2).encode()
    blob_digest = blob_digest or sha(blob)
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "artifactType": "application/vnd.dev.sigstore.bundle.v0.3+json",
            "config": {"mediaType": "application/vnd.oci.empty.v1+json", "digest": sha(b"{}"), "size": 2},
            "layers": [{"mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json", "digest": blob_digest, "size": len(blob)}],
        }
    ).encode()
    index = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": sha(manifest), "size": len(manifest),
                 "artifactType": "application/vnd.dev.sigstore.bundle.v0.3+json"},
                {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": "sha256:" + "e" * 64, "size": 10,
                 "artifactType": "application/spdx+json"},
            ]
            + list(extra_referrers),
        }
    ).encode()
    routes = {
        attestation.TOKEN_URL: (200, json.dumps({"token": TOKEN}).encode()),
        V2 + "/manifests/" + sha(manifest): (200, manifest),
        V2 + "/blobs/" + blob_digest: (200, blob),
    }
    if referrers_status == 200:
        routes[V2 + "/referrers/" + DIGEST] = (200, index)
    elif referrers_status == 404:
        routes[V2 + "/manifests/" + DIGEST.replace(":", "-")] = (200, index)
    else:
        routes[V2 + "/referrers/" + DIGEST] = (referrers_status, b"")
    return routes


class FetchBundleTests(unittest.TestCase):
    def test_success(self):
        opener = FakeOpener(registry())
        self.assertEqual(fetch_bundles(DIGEST, opener=opener), [BUNDLE])
        urls = [url for url, _, _ in opener.requests]
        self.assertEqual(urls[0], attestation.TOKEN_URL)
        self.assertEqual(urls[1], V2 + "/referrers/" + DIGEST)
        self.assertTrue(all(url.startswith("https://ghcr.io/") for url in urls))
        self.assertNotIn("Authorization", opener.requests[0][1])
        for _, headers, timeout in opener.requests[1:]:
            self.assertEqual(headers["Authorization"], "Bearer " + TOKEN)
            self.assertEqual(timeout, attestation.TIMEOUT_S)
        self.assertEqual(opener.requests[1][1]["Accept"], attestation.INDEX_TYPE)
        self.assertNotIn("sha256:" + "e" * 64, " ".join(urls))  # non-bundle referrer skipped

    def test_tag_schema_fallback_when_referrers_api_is_missing(self):
        self.assertEqual(fetch_bundles(DIGEST, opener=FakeOpener(registry(referrers_status=404))), [BUNDLE])

    def test_no_referrers(self):
        routes = registry()
        routes[V2 + "/referrers/" + DIGEST] = (200, json.dumps({"schemaVersion": 2, "manifests": []}).encode())
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(routes))
        self.assertEqual(caught.exception.code, "none")
        routes = registry()
        del routes[V2 + "/referrers/" + DIGEST]
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(routes))
        self.assertEqual(caught.exception.code, "none")

    def test_wrong_blob_digest(self):
        blob = json.dumps(BUNDLE).encode()
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(registry(bundle_bytes=blob, blob_digest="sha256:" + "d" * 64)))
        self.assertEqual(caught.exception.code, "digest")

    def test_tampered_manifest(self):
        routes = registry()
        for url in list(routes):
            if "/manifests/sha256:" in url:
                routes[url] = (200, routes[url][1].replace(b"schemaVersion", b"schemaversion"))
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(routes))
        self.assertEqual(caught.exception.code, "digest")

    def test_oversized_blob(self):
        big = b'{"pad":"' + b"x" * attestation.MAX_BUNDLE_BYTES + b'"}'
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(registry(bundle_bytes=big)))
        self.assertEqual(caught.exception.code, "size")

    def test_oversized_body_with_small_declared_size(self):
        routes = registry()
        blob_url = [url for url in routes if "/blobs/" in url][0]

        class Lying(FakeOpener):
            def open(self, request, timeout=None):
                response = super().open(request, timeout)
                if request.full_url == blob_url:
                    response.body = b"x" * (attestation.MAX_BUNDLE_BYTES + 10)
                    response.headers = {}
                return response

        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=Lying(routes))
        self.assertEqual(caught.exception.code, "size")

    def test_http_errors(self):
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(registry(referrers_status=500)))
        self.assertEqual(caught.exception.code, "http")
        routes = registry()
        routes[attestation.TOKEN_URL] = (401, b"")
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(routes))
        self.assertEqual(caught.exception.code, "token")
        routes = registry()
        routes[V2 + "/referrers/" + DIGEST] = urllib.error.URLError("no route to " + TOKEN)
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(routes))
        self.assertEqual(caught.exception.code, "http")
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_rejects_bad_digest_and_token(self):
        with self.assertRaises(BundleError):
            fetch_bundles("preview", opener=FakeOpener(registry()))
        routes = registry()
        routes[attestation.TOKEN_URL] = (200, b'{"token":"has space\\r\\nX-Injected: 1"}')
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(routes))
        self.assertEqual(caught.exception.code, "token")

    def blob_redirect_routes(self, target):
        routes = registry()
        blob_url = [url for url in routes if "/blobs/" in url][0]
        blob = routes[blob_url][1]
        routes[blob_url] = (307, target)
        return routes, blob

    def test_blob_redirect_to_the_cdn_is_followed_without_auth(self):
        cdn = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:abc?se=2026&sig=" + TOKEN
        routes, blob = self.blob_redirect_routes(cdn)
        routes[cdn] = (200, blob)
        opener = FakeOpener(routes)
        self.assertEqual(fetch_bundles(DIGEST, opener=opener), [BUNDLE])
        url, headers, timeout = opener.requests[-1]
        self.assertEqual(url, cdn)
        self.assertNotIn("Authorization", headers)
        self.assertEqual(timeout, attestation.TIMEOUT_S)

    def test_cdn_bytes_are_still_digest_checked(self):
        cdn = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/x"
        routes, blob = self.blob_redirect_routes(cdn)
        routes[cdn] = (200, blob + b" ")
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(routes))
        self.assertEqual(caught.exception.code, "digest")

    def test_blob_redirect_to_any_other_host_is_refused(self):
        for target in (
            "https://elsewhere.example/blob",
            "http://pkg-containers.githubusercontent.com/ghcr1/blobs/x",
            "https://pkg-containers.githubusercontent.com:8443/ghcr1/blobs/x",
            "https://user@pkg-containers.githubusercontent.com/ghcr1/blobs/x",
            "https://pkg-containers.githubusercontent.com.evil.example/x",
            "https://ghcr.io/v2/thebrianlee/sproutwall/blobs/other",
            "/relative/path",
        ):
            routes, blob = self.blob_redirect_routes(target)
            routes[target] = (200, blob)
            opener = FakeOpener(routes)
            with self.assertRaises(BundleError) as caught:
                fetch_bundles(DIGEST, opener=opener)
            self.assertEqual(caught.exception.code, "http", target)
            self.assertNotIn(target, [url for url, _, _ in opener.requests])

    def test_a_second_redirect_is_refused(self):
        cdn = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/x"
        again = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/y"
        routes, blob = self.blob_redirect_routes(cdn)
        routes[cdn] = (302, again)
        routes[again] = (200, blob)
        opener = FakeOpener(routes)
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=opener)
        self.assertEqual(caught.exception.code, "http")
        self.assertNotIn(again, [url for url, _, _ in opener.requests])

    def test_redirects_outside_blob_downloads_are_refused(self):
        cdn = "https://pkg-containers.githubusercontent.com/x"
        routes = registry()
        routes[V2 + "/referrers/" + DIGEST] = (307, cdn)
        routes[cdn] = (200, b"{}")
        with self.assertRaises(BundleError) as caught:
            fetch_bundles(DIGEST, opener=FakeOpener(routes))
        self.assertEqual(caught.exception.code, "http")

    def test_the_real_opener_never_follows_redirects(self):
        handler = attestation._NoRedirects()
        request = urllib.request.Request(V2 + "/blobs/" + DIGEST, headers={"Authorization": "Bearer x"})
        self.assertIsNone(handler.redirect_request(request, None, 307, "redirect", {}, "https://ghcr.io/v2/other"))
        opener = attestation.default_opener()
        self.assertTrue(any(isinstance(h, attestation._NoRedirects) for h in opener.handlers))
        self.assertFalse(any(type(h) is urllib.request.HTTPRedirectHandler for h in opener.handlers))

    def test_jsonl_is_one_compact_bundle_per_line(self):
        text = attestation.jsonl([BUNDLE, {"b": 2}])
        lines = text.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0]), BUNDLE)
        self.assertTrue(text.endswith("\n"))


if __name__ == "__main__":
    unittest.main()
