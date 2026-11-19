"""The managed kiosk launcher marker and paths, shared by doctor and `setup kiosk`.

`setup kiosk` adds exactly one launcher line to the kiosk user's labwc
autostart file, ~/.config/labwc/autostart. That line, and only that line,
ends with the marker comment below. A line whose first non-blank character
is "#" is not run by the desktop, so a commented-out marker line counts as
off. Doctor counts active marker lines:

  kiosk on:  exactly one active marker line -> pass
  kiosk off: no active marker line          -> pass
  otherwise                                 -> fail / repair_kiosk

The marker text must never change: an installed launcher is found by it.
`setup kiosk --off` turns the line into a comment ("# " + line);
`setup kiosk` turns it back on. Paths below are relative to the home folder.
"""

import os

KIOSK_AUTOSTART = os.path.join(".config", "labwc", "autostart")
KIOSK_MARKER = "# sproutwall:kiosk-launcher"

# The other files `setup kiosk` manages (relative to the home folder).
KIOSK_RC_XML = os.path.join(".config", "labwc", "rc.xml")
KIOSK_KANSHI = os.path.join(".config", "kanshi", "config")
KIOSK_LAUNCHER = os.path.join(".local", "bin", "sproutwall-kiosk")
# Private (0700) state: the pre-install snapshot, hashes of what setup wrote,
# the launcher's lock and the kiosk browser's persistent profile.
KIOSK_STATE_DIR = os.path.join(".local", "state", "sproutwall", "kiosk")

# The one managed autostart line. $HOME is expanded by the shell labwc runs
# autostart with, so the file holds no user name.
LAUNCH_LINE = '"$HOME/.local/bin/sproutwall-kiosk" & ' + KIOSK_MARKER
LAUNCH_LINE_OFF = "# " + LAUNCH_LINE


def active_marker_lines(text):
    count = 0
    for line in text.splitlines():
        stripped = line.strip()
        if KIOSK_MARKER in stripped and not stripped.startswith("#"):
            count += 1
    return count


def inactive_marker_lines(text):
    """Commented-out marker lines (the --off form)."""
    count = 0
    for line in text.splitlines():
        stripped = line.strip()
        if KIOSK_MARKER in stripped and stripped.startswith("#"):
            count += 1
    return count
