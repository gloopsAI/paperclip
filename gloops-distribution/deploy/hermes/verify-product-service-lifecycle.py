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
CAMPAIGN_EXECUTION_UNIT = "paperclip-controlled-swarm.service"
FORBIDDEN_UNIT_KEYS = ("Requires", "Requisite", "BindsTo", "PartOf", "After")
GENERAL_STOP_TARGETS = (
    "paperclip-gloops.service",
    "paperclip-hermes-execution.service",
    "paperclip-github-push-broker.service",
    "paperclip-github-read-broker.service",
    "paperclip-platform-ops-broker.service",
)
CAMPAIGN_ENV_NAMES = (
    "PAPERCLIP_CAMPAIGN_ID",
    "PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET",
    "PAPERCLIP_CAMPAIGN_DURATION_SECONDS",
    "PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS",
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

    handshake = (hermes / "paperclip-gloops-handshake.service").read_text(encoding="utf-8")
    if "--env-file /etc/paperclip-gloops/campaign-runtime.env" not in handshake:
        failures.append("campaign handshake container does not receive the campaign runtime envelope")

    campaign_execution_path = hermes / CAMPAIGN_EXECUTION_UNIT
    if not campaign_execution_path.is_file():
        failures.append("campaign execution unit is missing")
    else:
        campaign_execution = campaign_execution_path.read_text(encoding="utf-8")
        for key in ("Requires", "BindsTo", "After"):
            if CAMPAIGN_UNIT not in unit_value(campaign_execution, key).split():
                failures.append(f"campaign execution has no {key}={CAMPAIGN_UNIT}")
        for required in (
            "EnvironmentFile=/etc/paperclip-gloops/campaign-runtime.env",
            "--env-file /etc/paperclip-gloops/campaign-runtime.env",
            "preflight.sh --campaign-bound",
            "/run/paperclip-campaign",
            "ConditionPathExists=/etc/paperclip-gloops/CONTROLLED_SWARM_RUNTIME_APPROVED",
            "Conflicts=paperclip-gloops.service",
        ):
            if required not in campaign_execution:
                failures.append(f"campaign execution unit is missing {required}")

    activation = (hermes / "activate-controlled-swarm.sh").read_text(encoding="utf-8")
    if "readonly PAPERCLIP='paperclip-controlled-swarm.service'" not in activation:
        failures.append("controlled-swarm activation still targets the general Paperclip service")
    activation_helper_path = hermes / "activate-controlled-swarm-runtime.sh"
    if not activation_helper_path.is_file():
        failures.append("network-free controlled-swarm activation helper is missing")
    else:
        activation_helper = activation_helper_path.read_text(encoding="utf-8")
        if 'readonly CAMPAIGN_PAPERCLIP=\'paperclip-controlled-swarm.service\'' not in activation_helper:
            failures.append("controlled-swarm activation helper does not name the campaign service")
        if '"${SYSTEMCTL}" start "${CAMPAIGN_PAPERCLIP}"' not in activation_helper:
            failures.append("controlled-swarm activation helper does not start the campaign service")
        if '"${SYSTEMCTL}" start paperclip-gloops.service' in activation_helper:
            failures.append("controlled-swarm activation helper starts the general Paperclip service")

    actuator = (hermes / "campaign-deadman-stop.sh").read_text(encoding="utf-8")
    for target in GENERAL_STOP_TARGETS:
        if target in actuator:
            failures.append(f"campaign expiry actuator still stops {target}")
    for marker in ("ACTIVATION_APPROVED", "HERMES_EXECUTION_APPROVED"):
        if marker in actuator:
            failures.append(f"campaign expiry actuator still clears {marker}")
    if "HERMES_HANDSHAKE_APPROVED" not in actuator:
        failures.append("campaign expiry actuator no longer clears the handshake-only marker")
    if CAMPAIGN_EXECUTION_UNIT not in actuator:
        failures.append("campaign expiry actuator does not stop campaign execution")
    if "CONTROLLED_SWARM_RUNTIME_APPROVED" not in actuator:
        failures.append("campaign expiry actuator does not clear campaign execution authority")

    runtime = (hermes / "runtime.env").read_text(encoding="utf-8").splitlines()
    if "PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE=general" not in runtime:
        failures.append("general runtime has no explicit general campaign scope")
    for name in CAMPAIGN_ENV_NAMES:
        if any(line.startswith(f"{name}=") for line in runtime):
            failures.append(f"general runtime still inherits {name}")
    campaign_runtime_path = hermes / "campaign-runtime.env"
    if not campaign_runtime_path.is_file():
        failures.append("campaign runtime envelope is missing")
    else:
        campaign_runtime = campaign_runtime_path.read_text(encoding="utf-8").splitlines()
        if "PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE=campaign-bound" not in campaign_runtime:
            failures.append("campaign runtime has no explicit campaign-bound scope")
        for name in CAMPAIGN_ENV_NAMES:
            if not any(line.startswith(f"{name}=") and line.split("=", 1)[1] for line in campaign_runtime):
                failures.append(f"campaign runtime is missing {name}")
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
        expected = {
            "paperclip-gloops.service still has Requires=paperclip-campaign-deadman.service",
            "paperclip-gloops.service still has BindsTo=paperclip-campaign-deadman.service",
            "paperclip-gloops.service still has After=paperclip-campaign-deadman.service",
            "paperclip-gloops.service still mounts or references campaign runtime state",
            "paperclip-hermes-execution.service still has Requires=paperclip-campaign-deadman.service",
            "paperclip-hermes-execution.service still has BindsTo=paperclip-campaign-deadman.service",
            "paperclip-hermes-execution.service still has After=paperclip-campaign-deadman.service",
            "paperclip-github-push-broker.service still has Requires=paperclip-campaign-deadman.service",
            "paperclip-github-push-broker.service still has BindsTo=paperclip-campaign-deadman.service",
            "paperclip-github-push-broker.service still has After=paperclip-campaign-deadman.service",
            "preflight has no explicit general default mode",
            "preflight has no campaign-bound mode for handshake execution",
            "campaign handshake container does not receive the campaign runtime envelope",
            "campaign execution unit is missing",
            "controlled-swarm activation still targets the general Paperclip service",
            "network-free controlled-swarm activation helper is missing",
            "campaign expiry actuator still stops paperclip-gloops.service",
            "campaign expiry actuator still stops paperclip-hermes-execution.service",
            "campaign expiry actuator still clears ACTIVATION_APPROVED",
            "campaign expiry actuator still clears HERMES_EXECUTION_APPROVED",
            "campaign expiry actuator does not stop campaign execution",
            "campaign expiry actuator does not clear campaign execution authority",
            "general runtime has no explicit general campaign scope",
            "general runtime still inherits PAPERCLIP_CAMPAIGN_ID",
            "general runtime still inherits PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET",
            "general runtime still inherits PAPERCLIP_CAMPAIGN_DURATION_SECONDS",
            "general runtime still inherits PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS",
            "campaign runtime envelope is missing",
        }
        if set(failures) != expected:
            missing = sorted(expected - set(failures))
            unexpected = sorted(set(failures) - expected)
            print(f"FAIL pre-fix failure set drifted; missing={missing}; unexpected={unexpected}", file=sys.stderr)
            return 1
        print("PASS exact pre-fix service graph rejected:")
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
