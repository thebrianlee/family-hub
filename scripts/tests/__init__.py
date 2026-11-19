"""Unit tests for scripts/sproutwall. Run from the repo root:

    python3 -m unittest discover -s scripts/tests -t .
"""

import os
import sys

sys.dont_write_bytecode = True
SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

# No unit test may reach the network or a real hub: a test that tried would
# get a refused connection here instead of real traffic.
import http.client as _http_client  # noqa: E402
import urllib.request as _urllib_request  # noqa: E402


def _network_disabled(*_args, **_kwargs):
    raise ConnectionRefusedError("network disabled in unit tests")


_http_client.HTTPConnection.connect = _network_disabled
_urllib_request.OpenerDirector.open = _network_disabled
