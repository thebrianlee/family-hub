"""Command line for scripts/sproutwall.

Option values are never echoed. With --json anywhere on the command line,
stdout gets exactly one closed-schema JSON object on every path: a doctor
report, or the fixed fallback (result unknown, exit 2) for help, usage
errors and crashes. scripts/sproutwall prints the same fallback if even this
module cannot be imported.
"""

import os
import sys

from . import compose, schema, text
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


def requested_phase(argv):
    """The --phase value if it is a valid phase, else the first phase. Never echoed."""
    for index, arg in enumerate(argv):
        value = None
        if arg == "--phase" and index + 1 < len(argv):
            value = argv[index + 1]
        elif arg.startswith("--phase="):
            value = arg.partition("=")[2]
        if value in schema.PHASES:
            return value
    return schema.PHASES[0]


def fallback_json(argv):
    return schema.serialize(schema.fallback_report(requested_phase(argv)))


def _doctor(args, system, root, out, err, json_mode):
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
        if json_mode:
            out.write(fallback_json(args) + "\n")
        else:
            err.write(text.DOCTOR_USAGE + "\n")
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
        compose.compose_path(root),
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
    json_mode = "--json" in argv
    command = argv[0] if argv else None
    if command == "doctor" and not any(arg in HELP for arg in argv[1:]):
        return _doctor(argv[1:], system, root, out, err, json_mode)
    if json_mode:
        # Help, usage errors and verify-image (which has no JSON output): the
        # fixed object, so a --json caller always gets one closed-schema object.
        out.write(fallback_json(argv) + "\n")
        return schema.EXIT_UNKNOWN
    if command == "doctor":
        out.write(text.DOCTOR_USAGE + "\n")
        return 0
    if command == "verify-image":
        if any(arg in HELP for arg in argv[1:]):
            out.write(text.VERIFY_USAGE + "\n")
            return 0
        return _verify(argv[1:], system, root, out, err)
    if command in HELP:
        out.write(text.USAGE + "\n")
        return 0
    err.write(text.USAGE + "\n")
    return 2


def main(argv, system=None, root=None, out=None, err=None):
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
    argv = list(argv)
    try:
        return _main(argv, system or System(), root or default_root(), out, err)
    except (Exception, KeyboardInterrupt):  # noqa: BLE001 - fixed output only, never the error
        if "--json" in argv:
            out.write(fallback_json(argv) + "\n")
        else:
            err.write(text.FAILED + "\n")
        return 2
