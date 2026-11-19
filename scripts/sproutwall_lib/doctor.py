"""`sproutwall doctor`: run the checks for a phase and build the closed report."""

from . import schema, text
from .checks import CHECKS, Context


def run_doctor(system, root, phase, tier="A", kiosk="on"):
    ctx = Context(system, root, phase, tier, kiosk)
    for check_id in schema.CHECK_IDS:
        if not schema.is_required(check_id, phase):
            outcome = schema.NOT_APPLICABLE
        else:
            try:
                outcome = CHECKS[check_id](ctx)
            except Exception:  # noqa: BLE001 - any surprise is an incomplete check, never output
                outcome = schema.INCOMPLETE
        ctx.outcomes[check_id] = outcome
    return schema.build_report(phase, ctx.outcomes)


def human_lines(report):
    """Fixed text for a person at the terminal: ids, statuses and keyed remedies."""
    lines = ["Sproutwall doctor, phase %s" % report["phase"]]
    for check in report["checks"]:
        lines.append("%-17s %-15s %s" % (check["id"], check["status"], text.CHECK_TITLES[check["id"]]))
        if check["action"] != "none":
            lines.append("    %s: %s" % (check["action"], text.REMEDIES[check["action"]]))
    lines.append("Result: %s (exit %d)" % (report["result"], schema.exit_code(report)))
    if schema.residual_is_trusted_lan_only(report):
        lines.append(text.TRUSTED_LAN_RESIDUAL)
    return lines
