#!/usr/bin/env python3
"""Network-free service graph gate for product execution outside a campaign.

The campaign deadman remains the safety owner for the campaign-specific
handshake and controlled-swarm recovery path.  It is not the lifecycle parent
of the general Paperclip control plane, Hermes execution sidecar, or any
registered GitHub/platform broker.  This parser intentionally inspects source
unit files and the expiry actuator only; it never contacts systemd, Docker, or
the network.
"""

from __future__ import annotations

import argparse
import pathlib
import sys


GENERAL_UNITS = (
    "paperclip-gloops.service",
    "paperclip-hermes-execution.service",
    "paperclip-github-push-broker.service",
    "paperclip-github-read-broker.service",
    "paperclip-platform-ops-broker.service",
)
CAMPAIGN_UNIT = "paperclip-campaign-deadman.service"
FORBIDDEN_UNIT_KEYS = ("Requires", "Requisite", "BindsTo", "PartOf", "After")
GENERAL_STOP_TARGETS = (
    "paperclip-gloops.service",
    "paperclip-hermes-execution.service",
    "paperclip-github-push-broker.service",
    "paperclip-github-read-broker.service",
    "paperclip-platform-ops-broker.service",
)


def unit_value(unit: str, key: str) -> str:
    for line in unit.splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return ""


def validate(repo_root: pathlib.Path) -> list[str]:
    hermes = repo_root / "gloops-distribution" / "deploy" / "hermes"
    failures: list[str] = []
    for name in GENERAL_UNITS:
        unit = (hermes / name).read_text(encoding="utf-8")
        for key in FORBIDDEN_UNIT_KEYS:
            if CAMPAIGN_UNIT in unit_value(unit, key).split():
                failures.append(f"{name} still has {key}={CAMPAIGN_UNIT}")
        if "/run/paperclip-campaign" in unit:
            failures.append(f"{name} still mounts or references campaign runtime state")

    execution = (hermes / "paperclip-hermes-execution.service").read_text(encoding="utf-8")
    required_execution_peers = {
        "paperclip-github-push-broker.service",
        "paperclip-github-read-broker.service",
        "paperclip-platform-ops-broker.service",
    }
    if not required_execution_peers.issubset(set(unit_value(execution, "Requires").split())):
        failures.append("Hermes execution no longer requires all registered brokers")

    preflight = (hermes / "preflight.sh").read_text(encoding="utf-8")
    if 'MODE="${1:---general}"' not in preflight:
        failures.append("preflight has no explicit general default mode")
    if '--campaign-bound' not in preflight:
        failures.append("preflight has no campaign-bound mode for handshake execution")

    actuator = (hermes / "campaign-deadman-stop.sh").read_text(encoding="utf-8")
    for target in GENERAL_STOP_TARGETS:
        if target in actuator:
            failures.append(f"campaign expiry actuator still stops {target}")
    for marker in ("ACTIVATION_APPROVED", "HERMES_EXECUTION_APPROVED"):
        if marker in actuator:
            failures.append(f"campaign expiry actuator still clears {marker}")
    if "HERMES_HANDSHAKE_APPROVED" not in actuator:
        failures.append("campaign expiry actuator no longer clears the handshake-only marker")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[3])
    parser.add_argument(
        "--expect-pre-fix-failure",
        action="store_true",
        help="prove that this gate rejects an unfixed service graph",
    )
    args = parser.parse_args()
    failures = validate(args.repo_root.resolve())
    if args.expect_pre_fix_failure:
        if not failures:
            print("FAIL expected the unfixed service graph to be rejected", file=sys.stderr)
            return 1
        print("PASS pre-fix service graph rejected:")
        for failure in failures:
            print(f"- {failure}")
        return 0
    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    print("PASS general execution and registered brokers are campaign-lifecycle independent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
