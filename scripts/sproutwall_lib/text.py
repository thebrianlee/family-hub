"""Fixed human-readable text. Keyed by allowlisted ids and actions only.

Nothing in this file is built from anything doctor read on the host.
"""

CHECK_TITLES = {
    "platform": "64-bit Linux (arm64 or amd64)",
    "docker": "Docker daemon and Compose",
    "image_identity": "Running image is the pinned preview",
    "storage": "Data volume, photos and database",
    "health": "Hub health (/api/health)",
    "app_bind": "Hub port 3847 exposure",
    "bridge_bind": "Ask bridge stays on loopback",
    "ssh_policy": "SSH policy for this tier",
    "setup": "First-run setup finished",
    "read_guard": "Locked screens refuse anonymous reads",
    "kiosk": "Kiosk launcher in the selected state",
    "temporary_access": "Installation-only access removed",
}

REMEDIES = {
    "none": "",
    "use_supported_os": (
        "Use a 64-bit Linux system (arm64 or amd64), for example a Raspberry Pi 4 or 5 with "
        "64-bit Raspberry Pi OS, and Docker Engine with Compose from the approved packages."
    ),
    "verify_release": (
        "Run only the verified preview: check it with ./scripts/sproutwall verify-image, "
        "then start it with docker compose -f docker-compose.preview.yml up -d --wait."
    ),
    "restore_storage": (
        "The data volume or database is not as expected. Do not start a new volume. "
        "Use the backup and restore steps in the README."
    ),
    "restrict_ports": (
        "A port is reachable beyond the home network. Bind port 3847 to the Pi's LAN address "
        "or 127.0.0.1 (README: Limit who can connect), and never publish the bridge port 8787."
    ),
    "confirm_trusted_lan": (
        "The hub is published on the local network. Local checks cannot prove that the router "
        "forwards nothing, that no tunnel exists, or that everyone on the network is trusted. "
        "Confirm the trusted-network prerequisite yourself."
    ),
    "review_ssh": (
        "Review SSH. Keep it off, unless this is temporary key-only access on the home network; "
        "turn it off from the Pi's own desktop when the install is done."
    ),
    "open_hub": "Open the hub on the Pi and finish first-run setup with the parent PIN.",
    "repair_kiosk": "The kiosk launcher is not in the state you chose. Run the guide's kiosk step again.",
    "remove_agent": (
        "Installation-time access is still present. Remove the installation-only assistant, its "
        "credentials and autostart entries, and close temporary SSH sessions, as the guide shows."
    ),
    "retry_local": (
        "Run this again in the Pi's own terminal, as the user who runs the hub, after a minute. "
        "If the result repeats, stop and get help; do not work around it."
    ),
}

TRUSTED_LAN_RESIDUAL = (
    "Exit 2 comes only from app_bind / confirm_trusted_lan: local inspection found no public "
    "exposure. A trial may continue only if the trusted-network prerequisite was affirmed under "
    "decision 3. Record this residual unknown; it is not a clean pass."
)

DOCTOR_USAGE = (
    "usage: sproutwall doctor [--json] --phase running|configured|final "
    "[--tier A|B|C] [--kiosk on|off]"
)
VERIFY_USAGE = (
    "usage: sproutwall verify-image --source-sha <40-hex commit> [--digest sha256:<64-hex>] "
    "[--bundle FILE] [--trusted-root FILE]"
)
USAGE = (
    "usage: sproutwall <command>\n"
    "  doctor        read-only checks of this Pi and the running hub\n"
    "  verify-image  check the preview image's attestation before starting it\n"
    "See docs/install-cli.md."
)
