"""Unit tests for scripts/sproutwall. Run from the repo root:

    python3 -m unittest discover -s scripts/tests -t .
"""

import os
import sys

sys.dont_write_bytecode = True
SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)
