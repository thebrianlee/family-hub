"""The managed kiosk launcher marker, shared by doctor and (later) `setup kiosk`.

`setup kiosk` adds exactly one launcher line to the kiosk user's labwc
autostart file, ~/.config/labwc/autostart. That line, and only that line,
ends with the marker comment below. A line whose first non-blank character
is "#" is not run by the desktop, so a commented-out marker line counts as
off. Doctor counts active marker lines:

  kiosk on:  exactly one active marker line -> pass
  kiosk off: no active marker line          -> pass
  otherwise                                 -> fail / repair_kiosk

The marker text must never change: an installed launcher is found by it.
"""

import os

KIOSK_AUTOSTART = os.path.join(".config", "labwc", "autostart")
KIOSK_MARKER = "# sproutwall:kiosk-launcher"


def active_marker_lines(text):
    count = 0
    for line in text.splitlines():
        stripped = line.strip()
        if KIOSK_MARKER in stripped and not stripped.startswith("#"):
            count += 1
    return count
