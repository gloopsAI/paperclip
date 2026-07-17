#!/usr/bin/env python3
"""One-use, fail-closed commissioning transition for the controlled swarm."""

from __future__ import annotations

from dataclasses import dataclass
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import urllib.request


CAMPAIGN_ID = "controlled-swarm-20260717"
COMPANY_ID = "89ed0964-d918-4fcc-b830-5be49d2d4089"
GOVERNANCE_MERGE = "3a5820722e8c6f55d6a1a730cada1cb4f1a1df77"
AUTHORIZATION = "commission_twelve_ollama_roles"
PROTOCOL_START = "<!-- GLOOPS_CONTROLLED_SWARM_PROTOCOL_START -->"
PROTOCOL_END = "<!-- GLOOPS_CONTROLLED_SWARM_PROTOCOL_END -->"

ADMITTED = {
    "Northstar": "2f68703f-c2bd-40e1-a91e-70bc4d702e5e",
    "Atlas": "5768cc30-f8b9-4b20-871e-badf7d574b9b",
    "Conductor": "15cdc815-2a68-437b-a93b-d1f1157aa8a3",
    "Dispatch": "fd571350-6da8-482e-a17e-7edb914fa612",
    "Mason": "76a090e6-1523-4086-be5f-2a7dd7a37238",
    "Wren": "3298054f-0fc5-4ff9-8c53-b1382b3046d3",
    "Scout": "a89f54cc-3f1b-4157-b25b-c6c7a4fdcc1a",
    "Radar": "532a3827-3133-45a6-834a-486415c53b87",
    "Context Steward": "81a870b3-a474-44be-95e7-1151a9532832",
    "Argus": "843c62bc-6f32-420e-9b62-7a2d6a34846f",
    "Harbor": "a3a1cb4c-390a-4d40-9a88-8609183ed012",
    "Reception": "f57fe56c-639d-4826-b462-ff2e8a0116c4",
}
EXCLUDED = {
    "Grok Burst": (
        "fb0a4d29-a670-464a-8956-b9dfdb4e4529",
        "paused",
        "grok_local",
    ),
    "Codex Burst": (
        "a9ff2c34-0bd1-44e9-866a-3b03ce678cf4",
        "paused",
        "codex_local",
    ),
    "Fourth Pilot Engineer": (
        "dc607ee2-5c10-4bbd-9d2a-c8e5e33be936",
        "paused",
        "hermes_gateway",
    ),
    "Reflection Coach": (
        "2661eb0a-9b67-48cc-8033-767ca39c402a",
        "pending_approval",
        "claude_local",
    ),
}


class CommissioningError(RuntimeError):
    """A fail-closed commissioning refusal."""


@dataclass(frozen=True)
class CommissioningPaths:
    config_dir: Path = Path("/etc/paperclip-gloops")
    state_dir: Path = Path("/var/lib/paperclip-gloops/controlled-swarm")
    epoch: Path = Path(
        "/var/lib/paperclip-gloops/campaign-deadman/"
        "controlled-swarm-20260717/epoch.json",
    )
    lock: Path = Path("/run/lock/paperclip-controlled-swarm.lock")
    helper: Path = Path(
        "/usr/local/lib/paperclip-gloops/set-controlled-swarm-commissioning.py",
    )

    @property
    def approval(self) -> Path:
        return self.config_dir / "CONTROLLED_SWARM_COMMISSIONING_APPROVED"

    @property
    def runtime_env(self) -> Path:
        return self.config_dir / "runtime.env"

    @property
    def image(self) -> Path:
        return self.config_dir / "approved-image"

    @property
    def token(self) -> Path:
        return self.config_dir / "operator-board-token"

    @property
    def receipt(self) -> Path:
        return self.state_dir / "commissioning.json"


def parse_timestamp(value: object, field: str) -> dt.datetime:
    if not isinstance(value, str):
        raise CommissioningError(f"{field} must be an ISO-8601 string")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CommissioningError(f"{field} is not a valid timestamp") from exc
    if parsed.tzinfo is None:
        raise CommissioningError(f"{field} must include a timezone")
    return parsed


def validate_approval(
    approval: dict[str, object],
    approved_image: str,
    now: dt.datetime,
) -> None:
    expected_keys = {
        "schemaVersion",
        "authorization",
        "campaignId",
        "approvedImage",
        "governanceMerge",
        "authorizedAt",
        "expiresAt",
    }
    if set(approval) != expected_keys:
        raise CommissioningError("commissioning approval has an inexact schema")
    authorized = parse_timestamp(approval["authorizedAt"], "authorizedAt")
    expires = parse_timestamp(approval["expiresAt"], "expiresAt")
    if (
        approval["schemaVersion"]
        != "gloops.controlled-swarm-commissioning-approval.v1"
        or approval["authorization"] != AUTHORIZATION
        or approval["campaignId"] != CAMPAIGN_ID
        or approval["approvedImage"] != approved_image
        or approval["governanceMerge"] != GOVERNANCE_MERGE
        or not authorized <= now < expires
        or expires - authorized > dt.timedelta(hours=4)
    ):
        raise CommissioningError(
            "commissioning approval is stale, malformed, or boundary-mismatched",
        )


def validate_roster(agents: object) -> None:
    if not isinstance(agents, list) or any(not isinstance(agent, dict) for agent in agents):
        raise CommissioningError("agent configuration response is malformed")
    expected_identities = {
        (name, agent_id)
        for name, agent_id in ADMITTED.items()
    } | {
        (name, details[0])
        for name, details in EXCLUDED.items()
    }
    actual_identities = {
        (agent.get("name"), agent.get("id"))
        for agent in agents
    }
    if len(agents) != len(expected_identities) or actual_identities != expected_identities:
        raise CommissioningError("the company roster is not the exact authorized 16 identities")

    by_name = {agent["name"]: agent for agent in agents}
    for name, agent_id in ADMITTED.items():
        agent = by_name[name]
        heartbeat = agent.get("runtimeConfig", {}).get("heartbeat", {})
        instructions = agent.get("adapterConfig", {}).get("instructions", "")
        if (
            agent.get("id") != agent_id
            or agent.get("status") != "paused"
            or agent.get("adapterType") != "hermes_gateway"
            or heartbeat.get("enabled") is not False
            or heartbeat.get("intervalSec") != 3600
            or heartbeat.get("wakeOnDemand") is not True
            or heartbeat.get("maxConcurrentRuns") != 1
            or not isinstance(instructions, str)
            or instructions.count(PROTOCOL_START) != 1
            or instructions.count(PROTOCOL_END) != 1
            or CAMPAIGN_ID not in instructions
        ):
            raise CommissioningError(
                f"admitted identity {name} has drifted from the exact paused protocol",
            )

    for name, (agent_id, status, adapter_type) in EXCLUDED.items():
        agent = by_name[name]
        if (
            agent.get("id") != agent_id
            or agent.get("status") != status
            or agent.get("adapterType") != adapter_type
        ):
            raise CommissioningError(f"excluded identity {name} has drifted")


class HostPlatform:
    """Narrow host operations used by the commissioning transaction."""

    def __init__(self, paths: CommissioningPaths) -> None:
        self.paths = paths

    def is_active(self, unit: str) -> bool:
        return subprocess.run(
            ["systemctl", "is-active", "--quiet", unit],
            check=False,
        ).returncode == 0

    def restart_paperclip(self) -> None:
        subprocess.run(
            ["systemctl", "restart", "paperclip-gloops.service"],
            check=True,
        )

    def health(self) -> None:
        with urllib.request.urlopen(
            "http://127.0.0.1:3100/api/health",
            timeout=5,
        ) as response:
            if response.status != 200:
                raise CommissioningError("Paperclip health check failed")

    def fetch_agents(self, token: str) -> object:
        request = urllib.request.Request(
            f"http://127.0.0.1:3100/api/companies/{COMPANY_ID}/agent-configurations",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def inspect_commissioned(self) -> bool:
        result = subprocess.run(
            [
                "docker",
                "inspect",
                "paperclip-gloops",
                "--format",
                "{{range .Config.Env}}{{println .}}{{end}}",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return (
            "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true"
            in result.stdout.splitlines()
        )

    def set_barrier(self, commissioned: bool) -> None:
        subprocess.run(
            [
                str(self.paths.helper),
                "true" if commissioned else "false",
                "--runtime-env",
                str(self.paths.runtime_env),
            ],
            check=True,
        )


class Commissioner:
    def __init__(
        self,
        paths: CommissioningPaths,
        platform: HostPlatform,
        *,
        enforce_root_ownership: bool = True,
    ) -> None:
        self.paths = paths
        self.platform = platform
        self.enforce_root_ownership = enforce_root_ownership

    def _require_protected_file(self, path: Path, label: str) -> None:
        try:
            file_stat = path.stat()
        except FileNotFoundError as exc:
            raise CommissioningError(f"{label} is missing") from exc
        if stat.S_IMODE(file_stat.st_mode) != 0o600:
            raise CommissioningError(f"{label} must have mode 0600")
        if self.enforce_root_ownership and (
            file_stat.st_uid != 0 or file_stat.st_gid != 0
        ):
            raise CommissioningError(f"{label} must be root-owned")

    def _read_context(self, approval_in_progress: Path) -> tuple[dict[str, object], str, str]:
        self._require_protected_file(approval_in_progress, "commissioning approval")
        self._require_protected_file(self.paths.token, "operator board token")
        approval = json.loads(approval_in_progress.read_text(encoding="utf-8"))
        approved_image = self.paths.image.read_text(encoding="utf-8").strip()
        token = self.paths.token.read_text(encoding="utf-8").strip()
        if not token:
            raise CommissioningError("operator board token is empty")
        validate_approval(approval, approved_image, dt.datetime.now(dt.timezone.utc))
        return approval, approved_image, token

    def _write_receipt(
        self,
        approval: dict[str, object],
        approved_image: str,
        approval_in_progress: Path,
    ) -> None:
        self.paths.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.paths.state_dir / f".commissioning.{os.getpid()}"
        receipt = {
            "schemaVersion": "gloops.controlled-swarm-commissioning.v1",
            "campaignId": CAMPAIGN_ID,
            "approvedImage": approved_image,
            "governanceMerge": GOVERNANCE_MERGE,
            "authorization": AUTHORIZATION,
            "approvalSha256": (
                "sha256:"
                + hashlib.sha256(approval_in_progress.read_bytes()).hexdigest()
            ),
            "commissionedAt": dt.datetime.now(dt.timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "admittedAgentIds": sorted(ADMITTED.values()),
            "burstAgentIds": sorted(
                [EXCLUDED["Grok Burst"][0], EXCLUDED["Codex Burst"][0]],
            ),
            "executionProvider": "ollama-cloud-via-hermes-gateway",
            "timerHeartbeatsEnabled": False,
            "campaignEpochState": "unarmed",
            "outcome": "commissioned",
        }
        temporary.write_text(
            json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        if self.enforce_root_ownership:
            os.chown(temporary, 0, 0)
        os.replace(temporary, self.paths.receipt)

    def run(self) -> None:
        if self.enforce_root_ownership and os.geteuid() != 0:
            raise CommissioningError("controlled-swarm commissioning must run as root")
        self.paths.lock.parent.mkdir(parents=True, exist_ok=True)
        with self.paths.lock.open("a+", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise CommissioningError(
                    "another controlled-swarm operation holds the activation lock",
                ) from exc
            self._run_locked()

    def _run_locked(self) -> None:
        self._require_protected_file(self.paths.approval, "commissioning approval")
        approval_in_progress = self.paths.config_dir / (
            f".CONTROLLED_SWARM_COMMISSIONING_APPROVED.{os.getpid()}"
        )
        os.replace(self.paths.approval, approval_in_progress)
        barrier_changed = False
        try:
            for unit in (
                "paperclip-campaign-deadman.service",
                "paperclip-hermes-execution.service",
                "paperclip-gloops.service",
            ):
                if not self.platform.is_active(unit):
                    raise CommissioningError(
                        f"commissioning requires a healthy inert control plane: {unit}",
                    )
            self.platform.health()
            runtime_lines = self.paths.runtime_env.read_text(
                encoding="utf-8",
            ).splitlines()
            if runtime_lines.count(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
            ) != 1:
                raise CommissioningError(
                    "commissioning requires the exact inert execution barrier",
                )
            if self.paths.epoch.exists():
                raise CommissioningError(
                    "commissioning refuses an existing campaign epoch",
                )

            approval, approved_image, token = self._read_context(
                approval_in_progress,
            )
            validate_roster(self.platform.fetch_agents(token))
            self._write_receipt(
                approval,
                approved_image,
                approval_in_progress,
            )
            self.platform.set_barrier(True)
            barrier_changed = True
            self.platform.restart_paperclip()
            if not self.platform.is_active("paperclip-gloops.service"):
                raise CommissioningError("Paperclip did not restart active")
            self.platform.health()
            if not self.platform.inspect_commissioned():
                raise CommissioningError(
                    "Paperclip did not receive the commissioned barrier",
                )
            if self.paths.epoch.exists():
                raise CommissioningError(
                    "commissioning unexpectedly armed the campaign epoch",
                )
            validate_roster(self.platform.fetch_agents(token))
        except BaseException:
            if barrier_changed:
                try:
                    self.platform.set_barrier(False)
                finally:
                    self.paths.receipt.unlink(missing_ok=True)
                    self.platform.restart_paperclip()
            else:
                self.paths.receipt.unlink(missing_ok=True)
            raise
        finally:
            approval_in_progress.unlink(missing_ok=True)


def main() -> int:
    paths = CommissioningPaths()
    Commissioner(paths, HostPlatform(paths)).run()
    print(
        "PASS controlled swarm is commissioned; "
        "roles remain paused and epoch unarmed",
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CommissioningError as exc:
        raise SystemExit(str(exc)) from exc
