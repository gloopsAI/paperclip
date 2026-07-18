#!/usr/bin/env python3
"""Crash-rehearse the exact commissioner and recovery unit without live mutation."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from typing import Any
import uuid


UTC = dt.timezone.utc
INSTALLED_ROOT = Path("/usr/local/lib/paperclip-gloops")
INSTALLED_UNIT = Path(
    "/usr/local/lib/systemd/system/"
    "paperclip-controlled-swarm-commissioning-recovery.service",
)
DEFAULT_RECEIPT_DIR = Path("/var/lib/paperclip-gloops/rehearsals")


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def run(
    *args: str,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=check,
        capture_output=True,
        text=True,
    )


def load_commissioner(source: Path) -> Any:
    spec = importlib.util.spec_from_file_location(
        "controlled_swarm_commissioner_rehearsal",
        source,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load the exact controlled-swarm commissioner")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def exact_roster(module: Any) -> list[dict[str, object]]:
    agents: list[dict[str, object]] = []
    for index, (name, agent_id) in enumerate(module.ADMITTED.items(), start=1):
        agents.append(
            {
                "name": name,
                "id": agent_id,
                "status": "paused",
                "adapterType": "hermes_gateway",
                "adapterConfig": {
                    **module.EXECUTION_ROUTE,
                    "apiKey": {
                        "type": "secret_ref",
                        "secretId": f"00000000-0000-4000-8000-{index:012d}",
                        "version": "latest",
                    },
                    "instructions": module.compact_instructions(name),
                },
                "runtimeConfig": {
                    "heartbeat": {
                        "enabled": False,
                        "intervalSec": 3600,
                        "wakeOnDemand": True,
                        "maxConcurrentRuns": 1,
                    },
                },
            },
        )
    for name, (agent_id, status, adapter_type) in module.EXCLUDED.items():
        agents.append(
            {
                "name": name,
                "id": agent_id,
                "status": status,
                "adapterType": adapter_type,
                "adapterConfig": {},
                "runtimeConfig": {},
            },
        )
    return agents


def legacy_roster(module: Any) -> list[dict[str, object]]:
    agents = exact_roster(module)
    for agent in agents:
        if agent["name"] in module.ADMITTED:
            config = agent["adapterConfig"]
            assert isinstance(config, dict)
            agent["adapterConfig"] = {
                "apiBaseUrl": "http://127.0.0.1:8642",
                "apiKey": copy.deepcopy(config["apiKey"]),
                "payloadTemplate": {"input": "legacy payload override"},
                "provider": "unused-legacy-provider",
                "timeoutSec": 600,
                "instructions": "legacy autonomous-agent context\n" * 400,
            }
    return agents


class PersistentPlatform:
    """File-backed stand-in preserving external mutations across SIGKILL."""

    def __init__(
        self,
        module: Any,
        state_path: Path,
        runtime_env: Path,
    ) -> None:
        self.module = module
        self.state_path = state_path
        self.runtime_env = runtime_env

    def _read(self) -> dict[str, Any]:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def _write(self, value: dict[str, Any]) -> None:
        temporary = self.state_path.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as output:
            output.write(
                json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n",
            )
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.state_path)
        descriptor = os.open(self.state_path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def is_active(self, unit: str) -> bool:
        if unit == "paperclip-gloops.service":
            return bool(self._read()["paperclipActive"])
        return True

    def restart_paperclip(self) -> None:
        state = self._read()
        state["restartCount"] += 1
        state["paperclipActive"] = True
        state["effectiveBarrier"] = state["persistedBarrier"]
        self._write(state)

    def stop_paperclip(self) -> None:
        state = self._read()
        state["paperclipActive"] = False
        state["effectiveBarrier"] = False
        self._write(state)

    def health(self) -> None:
        return

    def fetch_agents(self, token: str) -> object:
        return copy.deepcopy(self._read()["roster"])

    def set_agent_adapter_config(
        self,
        token: str,
        agent_id: str,
        adapter_config: dict[str, object],
        *,
        replace: bool,
    ) -> None:
        state = self._read()
        if (
            state.get("failRestore") is True
            and "legacy autonomous-agent context"
            in str(adapter_config.get("instructions", ""))
        ):
            raise RuntimeError("rehearsed rollback failure")
        for agent in state["roster"]:
            if agent["id"] == agent_id:
                if replace:
                    agent["adapterConfig"] = copy.deepcopy(adapter_config)
                else:
                    agent["adapterConfig"].update(copy.deepcopy(adapter_config))
                self._write(state)
                return
        raise RuntimeError(f"unknown rehearsed agent: {agent_id}")

    def inspect_commissioned(self) -> bool:
        return bool(self._read()["effectiveBarrier"])

    def set_barrier(self, commissioned: bool) -> None:
        state = self._read()
        state["persistedBarrier"] = commissioned
        self._write(state)
        self.runtime_env.write_text(
            "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED="
            + ("true" if commissioned else "false")
            + "\n",
            encoding="utf-8",
        )


def prepare_sandbox(module: Any, source_root: Path, root: Path) -> tuple[Any, Path]:
    config_dir = root / "etc"
    state_dir = root / "state"
    config_dir.mkdir(mode=0o700)
    paths = module.CommissioningPaths(
        config_dir=config_dir,
        state_dir=state_dir,
        epoch=root / "epoch.json",
        lock=root / "commission.lock",
        helper=root / "helper",
        sidecar_config=root / "hermes-execution-config.yaml",
        sidecar_policy=root / "hermes-execution-policy.json",
    )
    paths.runtime_env.write_text(
        "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n",
        encoding="utf-8",
    )
    paths.image.write_text(
        "ghcr.io/gloopsai/paperclip-gloops@sha256:rehearsal\n",
        encoding="utf-8",
    )
    paths.token.write_text("rehearsal-board-token\n", encoding="utf-8")
    paths.token.chmod(0o600)
    paths.sidecar_config.write_bytes(
        (source_root / "hermes-execution-config.yaml").read_bytes(),
    )
    paths.sidecar_config.chmod(0o600)
    paths.sidecar_policy.write_bytes(
        (source_root / "hermes-execution-policy.json").read_bytes(),
    )
    paths.sidecar_policy.chmod(0o600)
    now = dt.datetime.now(UTC)
    approval = {
        "schemaVersion": "gloops.controlled-swarm-commissioning-approval.v1",
        "authorization": module.AUTHORIZATION,
        "campaignId": module.CAMPAIGN_ID,
        "approvedImage": (
            "ghcr.io/gloopsai/paperclip-gloops@sha256:rehearsal"
        ),
        "governanceMerge": module.GOVERNANCE_MERGE,
        "authorizedAt": (now - dt.timedelta(minutes=1)).isoformat(),
        "expiresAt": (now + dt.timedelta(hours=1)).isoformat(),
    }
    paths.approval.write_text(json.dumps(approval), encoding="utf-8")
    paths.approval.chmod(0o600)
    platform_state = root / "platform.json"
    platform_state.write_text(
        json.dumps(
            {
                "roster": legacy_roster(module),
                "persistedBarrier": False,
                "effectiveBarrier": False,
                "paperclipActive": True,
                "restartCount": 0,
                "failRestore": False,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    return paths, platform_state


def assert_legacy_restored(module: Any, platform: PersistentPlatform) -> None:
    roster = platform.fetch_agents("rehearsal-board-token")
    assert isinstance(roster, list)
    for agent in roster:
        if agent["name"] in module.ADMITTED:
            if "legacy autonomous-agent context" not in str(
                agent["adapterConfig"].get("instructions", ""),
            ):
                raise RuntimeError(
                    f"recovery did not restore {agent['name']} exactly",
                )


def rehearse_phase(
    module: Any,
    source_root: Path,
    phase: str,
) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix=f"paperclip-{phase}-") as temporary:
        root = Path(temporary)
        paths, state_path = prepare_sandbox(module, source_root, root)
        child = os.fork()
        if child == 0:
            platform = PersistentPlatform(module, state_path, paths.runtime_env)
            module.Commissioner(
                paths,
                platform,
                enforce_root_ownership=False,
                crash_after_phase=phase,
            ).run()
            os._exit(97)
        _, status = os.waitpid(child, 0)
        if not os.WIFSIGNALED(status) or os.WTERMSIG(status) != 9:
            raise RuntimeError(
                f"commissioner did not SIGKILL at durable phase {phase}: {status}",
            )

        platform = PersistentPlatform(module, state_path, paths.runtime_env)
        pre_recovery = platform._read()
        commissioner = module.Commissioner(
            paths,
            platform,
            enforce_root_ownership=False,
        )
        if not commissioner.recover():
            raise RuntimeError(f"phase {phase} did not leave an orphan journal")
        if commissioner.recover():
            raise RuntimeError(f"phase {phase} recovery was not idempotent")
        if paths.rollback_journal.exists() or paths.receipt.exists():
            raise RuntimeError(f"phase {phase} left replayable state")
        if platform.inspect_commissioned():
            raise RuntimeError(f"phase {phase} recovery left execution enabled")
        state = platform._read()
        if state["persistedBarrier"] or state["effectiveBarrier"]:
            raise RuntimeError(f"phase {phase} did not leave both barriers false")
        assert_legacy_restored(module, platform)
        return {
            "phase": phase,
            "crashSignal": "SIGKILL",
            "recovered": True,
            "repeatedRecoveryNoOp": True,
            "preRecoveryPersistedBarrier": (
                "true" if pre_recovery["persistedBarrier"] else "false"
            ),
            "preRecoveryEffectiveBarrier": (
                "true" if pre_recovery["effectiveBarrier"] else "false"
            ),
            "persistedBarrier": "false",
            "effectiveBarrier": "false",
            "priorConfigsRestored": True,
        }


def rehearse_corrupt_journal(module: Any, source_root: Path) -> bool:
    with tempfile.TemporaryDirectory(prefix="paperclip-corrupt-") as temporary:
        root = Path(temporary)
        paths, state_path = prepare_sandbox(module, source_root, root)
        platform = PersistentPlatform(module, state_path, paths.runtime_env)
        paths.state_dir.mkdir(mode=0o700)
        paths.rollback_journal.write_text("{not-json\n", encoding="utf-8")
        paths.rollback_journal.chmod(0o600)
        state = platform._read()
        state["persistedBarrier"] = True
        state["effectiveBarrier"] = True
        platform._write(state)
        paths.runtime_env.write_text(
            "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true\n",
            encoding="utf-8",
        )
        try:
            module.Commissioner(
                paths,
                platform,
                enforce_root_ownership=False,
            ).recover()
        except module.CommissioningError:
            return (
                paths.rollback_journal.exists()
                and not platform.inspect_commissioned()
                and platform._read()["persistedBarrier"] is False
            )
        return False


def rehearse_rollback_failure(module: Any, source_root: Path) -> bool:
    with tempfile.TemporaryDirectory(prefix="paperclip-rollback-") as temporary:
        root = Path(temporary)
        paths, state_path = prepare_sandbox(module, source_root, root)
        platform = PersistentPlatform(module, state_path, paths.runtime_env)
        roster = platform.fetch_agents("rehearsal-board-token")
        assert isinstance(roster, list)
        prior_configs = {
            agent["name"]: copy.deepcopy(agent["adapterConfig"])
            for agent in roster
            if agent["name"] in module.ADMITTED
        }
        commissioner = module.Commissioner(
            paths,
            platform,
            enforce_root_ownership=False,
        )
        commissioner._write_rollback_journal(paths.approval, prior_configs)
        state = platform._read()
        state["failRestore"] = True
        state["persistedBarrier"] = True
        state["effectiveBarrier"] = True
        state["paperclipActive"] = True
        platform._write(state)
        paths.runtime_env.write_text(
            "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true\n",
            encoding="utf-8",
        )
        try:
            commissioner.recover()
        except RuntimeError:
            return (
                paths.rollback_journal.exists()
                and not platform.inspect_commissioned()
                and platform._read()["persistedBarrier"] is False
            )
        return False


def rehearse_installed_recovery_unit(module: Any) -> dict[str, object]:
    paths = module.CommissioningPaths()
    platform = module.HostPlatform(paths)
    unit = "paperclip-controlled-swarm-commissioning-recovery.service"
    for required in (
        "paperclip-campaign-deadman.service",
        "paperclip-hermes-execution.service",
        "paperclip-gloops.service",
    ):
        if not platform.is_active(required):
            raise RuntimeError(
                f"installed-unit rehearsal requires active inert topology: {required}",
            )
    enabled = run("systemctl", "is-enabled", unit, check=False).stdout.strip()
    if enabled == "masked":
        raise RuntimeError("installed commissioning recovery unit is masked")
    runtime_lines = paths.runtime_env.read_text(encoding="utf-8").splitlines()
    if runtime_lines.count(
        "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
    ) != 1:
        raise RuntimeError(
            "installed-unit rehearsal requires the exact persisted false barrier",
        )
    if platform.inspect_commissioned():
        raise RuntimeError(
            "installed-unit rehearsal requires an effectively inert Paperclip",
        )
    if (
        paths.rollback_journal.exists()
        or paths.receipt.exists()
        or paths.approval.exists()
        or paths.epoch.exists()
        or any(
            paths.config_dir.glob(
                ".CONTROLLED_SWARM_COMMISSIONING_APPROVED.*",
            ),
        )
    ):
        raise RuntimeError(
            "installed-unit rehearsal refuses existing commissioning or epoch state",
        )

    commissioner = module.Commissioner(paths, platform)
    commissioner._require_protected_file(paths.token, "operator board token")
    token = paths.token.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("installed-unit rehearsal board token is empty")
    prior_configs = commissioner._capture_adapter_configs(
        platform.fetch_agents(token),
    )
    prior_digest = "sha256:" + hashlib.sha256(
        json.dumps(
            prior_configs,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8"),
    ).hexdigest()
    approved_image = paths.image.read_text(encoding="utf-8").strip()
    created_approvals: list[Path] = []
    phase_rows: list[dict[str, object]] = []
    try:
        for phase_index, phase in enumerate(module.ROLLBACK_JOURNAL_PHASES):
            if (
                paths.rollback_journal.exists()
                or paths.receipt.exists()
                or paths.approval.exists()
                or paths.epoch.exists()
            ):
                raise RuntimeError(
                    f"installed-unit phase {phase} began with replayable state",
                )
            current = commissioner._capture_adapter_configs(
                platform.fetch_agents(token),
            )
            current_digest = "sha256:" + hashlib.sha256(
                json.dumps(
                    current,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8"),
            ).hexdigest()
            if current_digest != prior_digest:
                raise RuntimeError(
                    f"installed-unit phase {phase} began with config drift",
                )

            approval = paths.config_dir / (
                ".CONTROLLED_SWARM_COMMISSIONING_APPROVED."
                f"rehearsal-{phase}-{uuid.uuid4().hex}"
            )
            created_approvals.append(approval)
            now = dt.datetime.now(UTC)
            approval_value = {
                "schemaVersion": (
                    "gloops.controlled-swarm-commissioning-approval.v1"
                ),
                "authorization": module.AUTHORIZATION,
                "campaignId": module.CAMPAIGN_ID,
                "approvedImage": approved_image,
                "governanceMerge": module.GOVERNANCE_MERGE,
                "authorizedAt": (now - dt.timedelta(minutes=1)).isoformat(),
                "expiresAt": (now + dt.timedelta(minutes=30)).isoformat(),
            }
            commissioner._write_protected_json(approval, approval_value)
            commissioner._write_rollback_journal(approval, prior_configs)
            instruction_receipt = commissioner._instruction_receipt(
                prior_configs,
            )

            for durable_phase in module.ROLLBACK_JOURNAL_PHASES[1 : phase_index + 1]:
                if durable_phase == "configs_applied":
                    commissioner._apply_compact_configs(token, prior_configs)
                elif durable_phase == "configs_verified":
                    module.validate_roster(
                        platform.fetch_agents(token),
                        require_compact_instructions=True,
                    )
                elif durable_phase == "receipt_written":
                    commissioner._write_receipt(
                        approval_value,
                        approved_image,
                        approval,
                        instruction_receipt,
                    )
                elif durable_phase == "barrier_enabled":
                    platform.set_barrier(True)
                elif durable_phase == "control_plane_restarted":
                    platform.restart_paperclip()
                elif durable_phase == "live_verified":
                    platform.health()
                    if not platform.inspect_commissioned():
                        raise RuntimeError(
                            "live-verified phase did not load the true barrier",
                        )
                    module.validate_roster(
                        platform.fetch_agents(token),
                        require_compact_instructions=True,
                    )
                commissioner._advance_rollback_journal(durable_phase)

            before_lines = paths.runtime_env.read_text(
                encoding="utf-8",
            ).splitlines()
            before_persisted = before_lines.count(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true",
            ) == 1
            before_effective = platform.inspect_commissioned()
            expected_before = (
                (True, True)
                if phase in ("control_plane_restarted", "live_verified")
                else (
                    (True, False)
                    if phase == "barrier_enabled"
                    else (False, False)
                )
            )
            if (before_persisted, before_effective) != expected_before:
                raise RuntimeError(
                    f"installed-unit phase {phase} did not reproduce its exact "
                    "pre-recovery barrier state",
                )

            run("systemctl", "reset-failed", unit, check=False)
            run("systemctl", "start", "--wait", unit)
            if paths.rollback_journal.exists():
                raise RuntimeError(
                    f"installed recovery unit left phase {phase} unresolved",
                )
            if paths.receipt.exists():
                raise RuntimeError(
                    f"installed recovery unit retained phase {phase} authority",
                )
            runtime_lines = paths.runtime_env.read_text(
                encoding="utf-8",
            ).splitlines()
            if runtime_lines.count(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
            ) != 1 or platform.inspect_commissioned():
                raise RuntimeError(
                    f"installed recovery unit left phase {phase} commissioned",
                )
            if not platform.is_active("paperclip-gloops.service"):
                raise RuntimeError(
                    f"installed recovery unit did not restore phase {phase} inert",
                )
            restored = commissioner._capture_adapter_configs(
                platform.fetch_agents(token),
            )
            restored_digest = "sha256:" + hashlib.sha256(
                json.dumps(
                    restored,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8"),
            ).hexdigest()
            if restored_digest != prior_digest:
                raise RuntimeError(
                    f"installed recovery unit did not restore phase {phase} configs",
                )
            condition = run(
                "systemctl",
                "show",
                "--property=ConditionResult",
                "--value",
                unit,
            ).stdout.strip()
            result = run(
                "systemctl",
                "show",
                "--property=Result",
                "--value",
                unit,
            ).stdout.strip()
            if condition != "yes" or result != "success":
                raise RuntimeError(
                    f"installed recovery unit failed phase {phase} "
                    f"(condition={condition}, result={result})",
                )

            run("systemctl", "reset-failed", unit, check=False)
            run("systemctl", "start", "--wait", unit)
            repeated_condition = run(
                "systemctl",
                "show",
                "--property=ConditionResult",
                "--value",
                unit,
            ).stdout.strip()
            if repeated_condition != "no":
                raise RuntimeError(
                    f"installed recovery unit replayed phase {phase}",
                )
            phase_rows.append(
                {
                    "phase": phase,
                    "preRecoveryPersistedBarrier": (
                        "true" if before_persisted else "false"
                    ),
                    "preRecoveryEffectiveBarrier": (
                        "true" if before_effective else "false"
                    ),
                    "conditionResult": condition,
                    "result": result,
                    "repeatedConditionResult": repeated_condition,
                    "priorConfigsSha256": prior_digest,
                    "restoredConfigsSha256": restored_digest,
                    "persistedBarrier": "false",
                    "effectiveBarrier": "false",
                },
            )

        sandbox = {
            field: run(
                "systemctl",
                "show",
                f"--property={field}",
                "--value",
                unit,
            ).stdout.strip()
            for field in (
                "User",
                "Group",
                "NoNewPrivileges",
                "PrivateDevices",
                "PrivateTmp",
                "ProtectHome",
                "ProtectSystem",
            )
        }
        expected = {
            "User": "root",
            "Group": "root",
            "NoNewPrivileges": "yes",
            "PrivateDevices": "yes",
            "PrivateTmp": "yes",
            "ProtectHome": "yes",
            "ProtectSystem": "strict",
        }
        if sandbox != expected:
            raise RuntimeError(
                f"installed recovery unit sandbox drifted: {sandbox}",
            )
        return {
            "systemdUnitExecuted": True,
            "phaseMatrix": phase_rows,
            "sandbox": sandbox,
            "priorConfigsSha256": prior_digest,
            "persistedBarrier": "false",
            "effectiveBarrier": "false",
            "realHostCommissionerSigkilled": False,
            "gate2ExactTopologyClaimed": False,
            "providersInvoked": False,
        }
    except BaseException:
        journal_remains = paths.rollback_journal.exists()
        try:
            platform.set_barrier(False)
            platform.stop_paperclip()
        except BaseException as fence_error:
            journal_status = (
                "the rollback journal remains for operator reconciliation"
                if journal_remains
                else "the recovery unit had already consumed the rollback journal"
            )
            raise RuntimeError(
                "installed-unit rehearsal failed and its emergency runtime "
                f"fence also failed; {journal_status}",
            ) from fence_error
        raise
    finally:
        for approval in created_approvals:
            approval.unlink(missing_ok=True)
        directory = os.open(paths.config_dir, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def write_receipt(receipt_dir: Path, receipt: dict[str, object]) -> Path:
    payload = (
        json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    receipt_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    receipt_dir.chmod(0o700)
    path = receipt_dir / (
        f"controlled-swarm-commissioning-recovery-{digest}.json"
    )
    temporary = receipt_dir / f".{path.name}.{os.getpid()}"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, "wb") as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    path.chmod(0o600)
    if os.geteuid() == 0:
        os.chown(receipt_dir, 0, 0)
        os.chown(path, 0, 0)
    directory = os.open(receipt_dir, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--allow-source-root",
        type=Path,
        help="test-only source directory containing the installed assets",
    )
    parser.add_argument("--receipt-dir", type=Path)
    args = parser.parse_args()

    if args.allow_source_root is None:
        if os.geteuid() != 0:
            raise SystemExit("commissioning recovery rehearsal must run as root")
        source_root = INSTALLED_ROOT
        unit = INSTALLED_UNIT
        receipt_dir = args.receipt_dir or DEFAULT_RECEIPT_DIR
    else:
        source_root = args.allow_source_root.resolve()
        unit = source_root / (
            "paperclip-controlled-swarm-commissioning-recovery.service"
        )
        if args.receipt_dir is None:
            raise SystemExit("--receipt-dir is required with --allow-source-root")
        receipt_dir = args.receipt_dir.resolve()

    source = source_root / "controlled-swarm-commissioner.py"
    wrapper = source_root / "commission-controlled-swarm.sh"
    for path in (source, wrapper, unit):
        if not path.is_file():
            raise SystemExit(f"exact commissioning recovery asset is missing: {path}")
    unit_text = unit.read_text(encoding="utf-8")
    if (
        "User=root" not in unit_text
        or "ConditionPathExists=" not in unit_text
        or "--recover-interrupted" not in unit_text
        or "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false" in unit_text
    ):
        raise SystemExit("installed commissioning recovery unit is not bounded")
    wrapper_text = wrapper.read_text(encoding="utf-8")
    recovery_index = wrapper_text.find('systemctl start --wait "${RECOVERY_UNIT}"')
    if (
        recovery_index < 0
        or 'set-controlled-swarm-commissioning.py" false' in wrapper_text
    ):
        raise SystemExit(
            "commissioning wrapper does not delegate fencing to bounded recovery",
        )

    module = load_commissioner(source)
    started = dt.datetime.now(UTC)
    phases = [
        rehearse_phase(module, source_root, phase)
        for phase in module.ROLLBACK_JOURNAL_PHASES
    ]
    corrupt_refused = rehearse_corrupt_journal(module, source_root)
    rollback_dark = rehearse_rollback_failure(module, source_root)
    if not corrupt_refused or not rollback_dark:
        raise SystemExit("commissioning recovery failure-path rehearsal failed")
    systemd_proof = (
        rehearse_installed_recovery_unit(module)
        if args.allow_source_root is None
        else {
            "systemdUnitExecuted": False,
            "reason": "source-only harness; root installed-unit proof not claimed",
        }
    )
    installed_matrix = systemd_proof["systemdUnitExecuted"] is True
    receipt = {
        "schemaVersion": (
            "gloops.controlled-swarm-commissioning-recovery-rehearsal.v1"
        ),
        "startedAt": started.isoformat(
            timespec="milliseconds",
        ).replace("+00:00", "Z"),
        "completedAt": dt.datetime.now(UTC).isoformat(
            timespec="milliseconds",
        ).replace("+00:00", "Z"),
        "commissionerSha256": sha256(source),
        "wrapperSha256": sha256(wrapper),
        "recoveryUnitSha256": sha256(unit),
        "recoveryUnitRootOnly": True,
        "recoveryUnitRequiresOrphanJournal": True,
        "recoveryUnitRequiresFalseBarrier": False,
        "recoveryUnitFencesBeforeRollback": True,
        "wrapperDelegatesFencingToRecovery": True,
        "journalSchemaVersion": module.ROLLBACK_JOURNAL_VERSION,
        "sourceCommissionerSigkillMatrix": True,
        "gate2ExactTopologyClaimed": False,
        "phases": phases,
        "corruptJournalRefused": corrupt_refused,
        "rollbackFailureRemainedDark": rollback_dark,
        "installedSystemdProof": systemd_proof,
        "providersInvoked": False,
        "productionStateMutated": installed_matrix,
        "outcome": (
            "split_artifact_matrix_passed"
            if installed_matrix
            else "source_harness_passed"
        ),
    }
    receipt_path = write_receipt(receipt_dir, receipt)
    mode = stat.S_IMODE(receipt_path.stat().st_mode)
    if mode != 0o600:
        raise SystemExit("rehearsal receipt is not mode 0600")
    print(receipt_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
