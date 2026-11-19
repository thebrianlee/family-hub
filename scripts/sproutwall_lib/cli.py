"""Command line for scripts/sproutwall.

Option values are never echoed. `doctor --json` writes exactly one JSON object
to stdout on every path, usage errors and crashes included.
"""

import os
import sys

from . import schema, text
from .doctor import human_lines, run_doctor
from .system import System
from .verify_image import MESSAGES, verified_lines, verify_image

HELP = ("-h", "--help")


class UsageError(Exception):
    pass


def default_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def parse_options(args, spec):
    """{option: value} for spec {option: "flag" | tuple of choices | None (any value)}."""
    options = {}
    index = 0
    while index < len(args):
        arg = args[index]
        name, has_value, value = arg, False, None
        if arg.startswith("--") and "=" in arg:
            name, _, value = arg.partition("=")
            has_value = True
        if name not in spec or name in options:
            raise UsageError()
        kind = spec[name]
        if kind == "flag":
            if has_value:
                raise UsageError()
            options[name] = True
        else:
            if not has_value:
                index += 1
                if index >= len(args):
                    raise UsageError()
                value = args[index]
            if kind is not None and value not in kind:
                raise UsageError()
            options[name] = value
        index += 1
    return options


def _requested_phase(args):
    for index, arg in enumerate(args):
        value = None
        if arg == "--phase" and index + 1 < len(args):
            value = args[index + 1]
        elif arg.startswith("--phase="):
            value = arg.partition("=")[2]
        if value in schema.PHASES:
            return value
    return schema.PHASES[0]


def _doctor(args, system, root, out, err):
    json_mode = "--json" in args
    try:
        options = parse_options(
            args,
            {
                "--json": "flag",
                "--phase": schema.PHASES,
                "--tier": schema.TIERS,
                "--kiosk": schema.KIOSK_STATES,
            },
        )
        if "--phase" not in options:
            raise UsageError()
    except UsageError:
        err.write(text.DOCTOR_USAGE + "\n")
        if json_mode:
            out.write(schema.serialize(schema.fallback_report(_requested_phase(args))) + "\n")
        return schema.EXIT_UNKNOWN
    report = run_doctor(
        system,
        root,
        options["--phase"],
        tier=options.get("--tier", "A"),
        kiosk=options.get("--kiosk", "on"),
    )
    if json_mode:
        out.write(schema.serialize(report) + "\n")
    else:
        out.write("\n".join(human_lines(report)) + "\n")
    return schema.exit_code(report)


def _verify(args, system, root, out, err):
    from .compose import compose_path

    try:
        options = parse_options(
            args, {"--source-sha": None, "--digest": None, "--bundle": None, "--trusted-root": None}
        )
        if "--source-sha" not in options:
            raise UsageError()
    except UsageError:
        err.write(text.VERIFY_USAGE + "\n")
        return 2
    code, key, digest = verify_image(
        system,
        compose_path(root),
        options["--source-sha"],
        published_digest=options.get("--digest"),
        bundle=options.get("--bundle"),
        trusted_root=options.get("--trusted-root"),
    )
    if digest is not None and code == 0:
        out.write("\n".join(verified_lines(digest, options["--source-sha"])) + "\n")
    else:
        err.write(MESSAGES.get(key, MESSAGES["gh_failed"]) + "\n")
    return code


def _main(argv, system, root, out, err):
    if not argv or argv[0] in HELP:
        (out if argv else err).write(text.USAGE + "\n")
        return 0 if argv else 2
    command, args = argv[0], list(argv[1:])
    if command == "doctor":
        if any(arg in HELP for arg in args):
            out.write(text.DOCTOR_USAGE + "\n")
            return 0
        return _doctor(args, system, root, out, err)
    if command == "verify-image":
        if any(arg in HELP for arg in args):
            out.write(text.VERIFY_USAGE + "\n")
            return 0
        return _verify(args, system, root, out, err)
    err.write(text.USAGE + "\n")
    return 2


def main(argv, system=None, root=None, out=None, err=None):
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
    argv = list(argv)
    json_doctor = bool(argv) and argv[0] == "doctor" and "--json" in argv
    try:
        return _main(argv, system or System(), root or default_root(), out, err)
    except (Exception, KeyboardInterrupt):  # noqa: BLE001 - fixed output only, never the error
        if json_doctor:
            out.write(schema.serialize(schema.fallback_report(_requested_phase(argv[1:]))) + "\n")
        else:
            err.write("sproutwall: stopped by an unexpected error. Nothing was changed.\n")
        return 2
