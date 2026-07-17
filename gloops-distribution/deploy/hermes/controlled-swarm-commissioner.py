#!/usr/bin/env python3
"""One-use, fail-closed commissioning transition for the controlled swarm."""

from __future__ import annotations

import argparse
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
INSTRUCTION_VERSION = "gloops.controlled-swarm-instructions.v2"
ROLLBACK_JOURNAL_VERSION = "gloops.controlled-swarm-rollback-journal.v1"
EXECUTION_ROUTE = {
    "apiBaseUrl": "http://hermes-execution:8642",
    "maxTurnsPerRun": 6,
    "model": "kimi-k2.7-code",
    "paperclipApiUrl": "http://paperclip-gloops:3100",
    "persistSession": False,
    "provider": "ollama-cloud",
    "timeoutSec": 1200,
}

ROLE_CHARTERS = {
    "Northstar": (
        "portfolio and product owner",
        "turn operator burden and evidence into ranked outcomes; do not implement or self-approve",
    ),
    "Atlas": (
        "platform architect",
        "settle scoped contracts and boundaries; do not widen authority or promote your own design",
    ),
    "Conductor": (
        "program owner",
        "maintain the bounded work graph, one accountable owner per stage, and honest terminal state",
    ),
    "Dispatch": (
        "execution coordinator",
        "route eligible ready work without polling, duplicate ownership, or invented capacity",
    ),
    "Mason": (
        "accountable implementation owner",
        "deliver the assigned change through pushed exact-head verification; never review or promote your own work",
    ),
    "Wren": (
        "implementation engineer",
        "deliver only the assigned bounded slice and its failure-path tests; never broaden the repository or task",
    ),
    "Scout": (
        "implementation and investigation engineer",
        "ground the assigned defect and implement only when the issue explicitly grants implementation authority",
    ),
    "Radar": (
        "external-signal researcher",
        "return cited decision-relevant findings; do not implement, mutate runtime, or treat popularity as evidence",
    ),
    "Context Steward": (
        "context and continuation owner",
        "compile compact resumable packets and measure reduction without deleting decisions, failures, or authority facts",
    ),
    "Argus": (
        "independent quality owner",
        "adversarially verify the exact head and unresolved-thread state; never repair or accept your own implementation",
    ),
    "Harbor": (
        "release and promotion owner",
        "prepare rollback-ready immutable promotion packets; act only under separate exact promotion authority",
    ),
    "Reception": (
        "operator communications owner",
        "project concise verified status and genuine actions; do not create work, approve changes, or hide blockers",
    ),
}

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


def compact_instructions(name: str) -> str:
    try:
        role, mandate = ROLE_CHARTERS[name]
    except KeyError as exc:
        raise CommissioningError(f"no compact charter exists for {name}") from exc
    return f"""# GLoops controlled-swarm role

Identity: {name}
Role: {role}
Campaign: {CAMPAIGN_ID}
Mandate: {mandate}.

## Authority and work discipline

- The authenticated Paperclip issue, current execution stage, compact work packet, repository grant, accepted base, and ceilings are your complete authority. Host-observed facts win over prompts and output.
- Work only the assigned stage. Do not discover credentials, inspect unrelated environment state, revive backlog, poll for work, create schedules, widen scope, lower a gate, merge, deploy, or change authority.
- Missing repository, base, acceptance, ownership, reviewer, budget, or continuation evidence means `blocked`; it is not permission to reconstruct the whole program.
- Read the smallest relevant code surface. Preserve decisions and failed-attempt evidence. Keep one accountable owner. Do not start a parallel implementation of the same task.
- Code, tests, a draft PR, or review prose are progress—not completion. A review request requires a pushed exact head and required verification. Acceptance requires an independent reviewer, exact-head checks, and zero unresolved threads.
- The campaign may end at independently accepted `repair_ready`. Promotion requires separate pre-existing authority and an owner independent of implementation and review.
- xAI/Grok API, paid overage, direct credential-home/CLI projection, unattributed provider use, and speculative fallback are prohibited.

{PROTOCOL_START}
Emit at most one terminal line, never in a code fence:
PAPERCLIP_SWARM_V1:{{"action":"review_ready","headSha":"<40-lowercase-hex>","summary":"<180 chars>"}}
PAPERCLIP_SWARM_V1:{{"action":"accepted","headSha":"<40-lowercase-hex>","summary":"<180 chars>"}}
PAPERCLIP_SWARM_V1:{{"action":"changes_requested","headSha":"<40-lowercase-hex>","summary":"<180 chars>"}}
PAPERCLIP_SWARM_V1:{{"action":"blocked","reason":"<typed blocker and next condition, 240 chars>"}}
PAPERCLIP_SWARM_V1:{{"action":"repair_proposal","repository":"<owner/repo>","component":"<bounded component>","title":"<title>","negativeTest":"<fail-before/pass-after>","summary":"<evidence>"}}
Use only the action allowed by the host-owned stage. Malformed, duplicate, out-of-campaign, or unauthorized markers fail closed. Replayed delivery resumes the same idempotent transition; never invent a new side effect.
{PROTOCOL_END}
"""


def instruction_digest(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and value.startswith("sha256:")
        and len(value) == 71
        and all(character in "0123456789abcdef" for character in value[7:])
    )


def expected_instruction_set() -> dict[str, object]:
    compact = {name: compact_instructions(name) for name in ADMITTED}
    return {
        "setSha256": instruction_digest(
            "".join(
                f"{name}\0{compact[name]}\0"
                for name in sorted(compact)
            ),
        ),
        "afterBytes": sum(
            len(value.encode("utf-8"))
            for value in compact.values()
        ),
        "agents": {
            name: {
                "afterBytes": len(compact[name].encode("utf-8")),
                "sha256": instruction_digest(compact[name]),
            }
            for name in sorted(compact)
        },
    }


def validate_instruction_receipt(value: object) -> None:
    if not isinstance(value, dict):
        raise CommissioningError("commissioning instruction receipt is missing")
    expected = expected_instruction_set()
    before_bytes = value.get("beforeBytes")
    after_bytes = value.get("afterBytes")
    changed = value.get("changed")
    reduction = value.get("reductionBasisPoints")
    agents = value.get("agents")
    if (
        set(value) != {
            "schemaVersion",
            "setSha256",
            "beforeBytes",
            "afterBytes",
            "changed",
            "reductionBasisPoints",
            "agents",
        }
        or value.get("schemaVersion") != INSTRUCTION_VERSION
        or value.get("setSha256") != expected["setSha256"]
        or after_bytes != expected["afterBytes"]
        or type(before_bytes) is not int
        or before_bytes <= 0
        or not isinstance(changed, bool)
        or type(reduction) is not int
        or not isinstance(agents, dict)
        or set(agents) != set(ADMITTED)
    ):
        raise CommissioningError("commissioning instruction receipt is invalid")
    expected_agents = expected["agents"]
    assert isinstance(expected_agents, dict)
    for name in ADMITTED:
        row = agents.get(name)
        expected_row = expected_agents[name]
        if (
            not isinstance(row, dict)
            or set(row) != {
                "beforeBytes",
                "afterBytes",
                "sha256",
            }
            or type(row.get("beforeBytes")) is not int
            or row.get("beforeBytes") < 0
            or row.get("afterBytes") != expected_row["afterBytes"]
            or row.get("sha256") != expected_row["sha256"]
        ):
            raise CommissioningError(
                f"commissioning instruction receipt for {name} is invalid",
            )
    expected_reduction = (
        0
        if not changed
        else (before_bytes - after_bytes) * 10_000 // before_bytes
    )
    if (
        reduction != expected_reduction
        or (changed and before_bytes <= after_bytes)
        or (not changed and before_bytes != after_bytes)
        or sum(row["beforeBytes"] for row in agents.values()) != before_bytes
    ):
        raise CommissioningError(
            "commissioning instruction reduction evidence is inconsistent",
        )


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

    @property
    def rollback_journal(self) -> Path:
        return self.state_dir / "commissioning-rollback.json"


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


def validate_commissioning_receipt(
    receipt: object,
    approved_image: str,
) -> None:
    admitted_ids = (
        receipt.get("admittedAgentIds")
        if isinstance(receipt, dict)
        else None
    )
    burst_ids = (
        receipt.get("burstAgentIds")
        if isinstance(receipt, dict)
        else None
    )
    if (
        not isinstance(receipt, dict)
        or set(receipt) != {
            "schemaVersion",
            "campaignId",
            "approvedImage",
            "governanceMerge",
            "authorization",
            "approvalSha256",
            "commissionedAt",
            "admittedAgentIds",
            "burstAgentIds",
            "executionProvider",
            "executionRoute",
            "instructionSet",
            "timerHeartbeatsEnabled",
            "campaignEpochState",
            "outcome",
        }
        or receipt.get("schemaVersion")
        != "gloops.controlled-swarm-commissioning.v1"
        or receipt.get("campaignId") != CAMPAIGN_ID
        or receipt.get("approvedImage") != approved_image
        or receipt.get("governanceMerge") != GOVERNANCE_MERGE
        or receipt.get("authorization") != AUTHORIZATION
        or not is_sha256(receipt.get("approvalSha256"))
        or not isinstance(receipt.get("commissionedAt"), str)
        or not isinstance(admitted_ids, list)
        or admitted_ids != sorted(ADMITTED.values())
        or not isinstance(burst_ids, list)
        or burst_ids
        != sorted([
            EXCLUDED["Grok Burst"][0],
            EXCLUDED["Codex Burst"][0],
        ])
        or receipt.get("executionProvider")
        != "ollama-cloud-via-hermes-gateway"
        or receipt.get("executionRoute") != EXECUTION_ROUTE
        or receipt.get("timerHeartbeatsEnabled") is not False
        or receipt.get("campaignEpochState") != "unarmed"
        or receipt.get("outcome") != "commissioned"
    ):
        raise CommissioningError(
            "controlled-swarm commissioning receipt is invalid",
        )
    parse_timestamp(receipt["commissionedAt"], "commissionedAt")
    validate_instruction_receipt(receipt.get("instructionSet"))


def validate_roster(agents: object, *, require_compact_instructions: bool) -> None:
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
        adapter_config = agent.get("adapterConfig", {})
        if not isinstance(adapter_config, dict):
            raise CommissioningError(
                f"admitted identity {name} has malformed adapter configuration",
            )
        instructions = adapter_config.get("instructions", "")
        instruction_mismatch = (
            require_compact_instructions
            and instructions != compact_instructions(name)
        )
        route_mismatch = (
            require_compact_instructions
            and any(
                adapter_config.get(key) != value
                for key, value in EXECUTION_ROUTE.items()
            )
        )
        if (
            agent.get("id") != agent_id
            or agent.get("status") != "paused"
            or agent.get("adapterType") != "hermes_gateway"
            or heartbeat.get("enabled") is not False
            or heartbeat.get("intervalSec") != 3600
            or heartbeat.get("wakeOnDemand") is not True
            or heartbeat.get("maxConcurrentRuns") != 1
            or not isinstance(instructions, str)
            or instruction_mismatch
            or route_mismatch
        ):
            raise CommissioningError(
                f"admitted identity {name} has drifted from the exact paused charter",
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

    def set_agent_adapter_config(
        self,
        token: str,
        agent_id: str,
        adapter_config: dict[str, object],
        *,
        replace: bool,
    ) -> None:
        payload = json.dumps(
            {
                "adapterConfig": adapter_config,
                "replaceAdapterConfig": replace,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:3100/api/agents/{agent_id}",
            data=payload,
            method="PATCH",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise CommissioningError(
                    f"Paperclip refused the bounded adapter configuration for {agent_id}",
                )

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

    def _capture_adapter_configs(
        self,
        agents: object,
    ) -> dict[str, dict[str, object]]:
        validate_roster(agents, require_compact_instructions=False)
        assert isinstance(agents, list)
        by_name = {agent["name"]: agent for agent in agents}
        captured: dict[str, dict[str, object]] = {}
        for name in ADMITTED:
            adapter_config = by_name[name].get("adapterConfig", {})
            if not isinstance(adapter_config, dict):
                raise CommissioningError(
                    f"admitted identity {name} has malformed adapter configuration",
                )
            instructions = adapter_config.get("instructions", "")
            if not isinstance(instructions, str):
                raise CommissioningError(
                    f"admitted identity {name} has non-text instructions",
                )
            captured[name] = adapter_config
        return captured

    def _apply_compact_configs(
        self,
        token: str,
    ) -> None:
        for name, agent_id in ADMITTED.items():
            self.platform.set_agent_adapter_config(
                token,
                agent_id,
                {
                    **EXECUTION_ROUTE,
                    "instructions": compact_instructions(name),
                },
                replace=False,
            )

    def _restore_adapter_configs(
        self,
        token: str,
        adapter_configs: dict[str, dict[str, object]],
    ) -> None:
        for name, agent_id in ADMITTED.items():
            self.platform.set_agent_adapter_config(
                token,
                agent_id,
                adapter_configs[name],
                replace=True,
            )

    def _instruction_receipt(
        self,
        prior_configs: dict[str, dict[str, object]],
    ) -> dict[str, object]:
        prior = {
            name: str(config.get("instructions", ""))
            for name, config in prior_configs.items()
        }
        before_bytes = sum(len(value.encode("utf-8")) for value in prior.values())
        compact = {name: compact_instructions(name) for name in ADMITTED}
        after_bytes = sum(len(value.encode("utf-8")) for value in compact.values())
        changed = any(prior[name] != compact[name] for name in compact)
        if changed and after_bytes >= before_bytes:
            raise CommissioningError(
                "compact charter did not reduce aggregate instruction bytes",
            )
        return {
            "schemaVersion": INSTRUCTION_VERSION,
            "setSha256": instruction_digest(
                "".join(
                    f"{name}\0{compact[name]}\0"
                    for name in sorted(compact)
                ),
            ),
            "beforeBytes": before_bytes,
            "afterBytes": after_bytes,
            "changed": changed,
            "reductionBasisPoints": 0 if not changed else (
                (before_bytes - after_bytes) * 10_000 // before_bytes
            ),
            "agents": {
                name: {
                    "beforeBytes": len(prior[name].encode("utf-8")),
                    "afterBytes": len(compact[name].encode("utf-8")),
                    "sha256": instruction_digest(compact[name]),
                }
                for name in sorted(compact)
            },
        }

    def _configs_need_update(
        self,
        prior_configs: dict[str, dict[str, object]],
    ) -> bool:
        for name, config in prior_configs.items():
            if config.get("instructions") != compact_instructions(name):
                return True
            if any(
                config.get(key) != value
                for key, value in EXECUTION_ROUTE.items()
            ):
                return True
        return False

    def _write_rollback_journal(
        self,
        approval_in_progress: Path,
        prior_configs: dict[str, dict[str, object]],
    ) -> None:
        self.paths.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.paths.rollback_journal.exists():
            raise CommissioningError(
                "interrupted commissioning requires rollback recovery",
            )
        temporary = self.paths.state_dir / f".commissioning-rollback.{os.getpid()}"
        journal = {
            "schemaVersion": ROLLBACK_JOURNAL_VERSION,
            "campaignId": CAMPAIGN_ID,
            "companyId": COMPANY_ID,
            "approvalSha256": (
                "sha256:"
                + hashlib.sha256(approval_in_progress.read_bytes()).hexdigest()
            ),
            "createdAt": dt.datetime.now(dt.timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "agents": {
                name: {
                    "id": ADMITTED[name],
                    "adapterConfig": prior_configs[name],
                }
                for name in sorted(ADMITTED)
            },
        }
        temporary.write_text(
            json.dumps(journal, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        if self.enforce_root_ownership:
            os.chown(temporary, 0, 0)
        os.replace(temporary, self.paths.rollback_journal)

    def _read_rollback_journal(self) -> dict[str, dict[str, object]]:
        self._require_protected_file(
            self.paths.rollback_journal,
            "commissioning rollback journal",
        )
        value = json.loads(
            self.paths.rollback_journal.read_text(encoding="utf-8"),
        )
        if (
            not isinstance(value, dict)
            or set(value) != {
                "schemaVersion",
                "campaignId",
                "companyId",
                "approvalSha256",
                "createdAt",
                "agents",
            }
            or value.get("schemaVersion") != ROLLBACK_JOURNAL_VERSION
            or value.get("campaignId") != CAMPAIGN_ID
            or value.get("companyId") != COMPANY_ID
            or not is_sha256(value.get("approvalSha256"))
            or not isinstance(value.get("createdAt"), str)
            or not isinstance(value.get("agents"), dict)
            or set(value["agents"]) != set(ADMITTED)
        ):
            raise CommissioningError("commissioning rollback journal is invalid")
        parse_timestamp(value["createdAt"], "createdAt")
        result: dict[str, dict[str, object]] = {}
        for name, agent_id in ADMITTED.items():
            row = value["agents"].get(name)
            if (
                not isinstance(row, dict)
                or set(row) != {"id", "adapterConfig"}
                or row.get("id") != agent_id
                or not isinstance(row.get("adapterConfig"), dict)
            ):
                raise CommissioningError(
                    f"commissioning rollback journal for {name} is invalid",
                )
            result[name] = row["adapterConfig"]
        return result

    def _verify_adapter_configs(
        self,
        agents: object,
        expected: dict[str, dict[str, object]],
    ) -> None:
        validate_roster(agents, require_compact_instructions=False)
        assert isinstance(agents, list)
        by_name = {agent["name"]: agent for agent in agents}
        for name in ADMITTED:
            if by_name[name].get("adapterConfig") != expected[name]:
                raise CommissioningError(
                    f"rollback did not restore the exact adapter configuration for {name}",
                )

    def _rollback_from_journal(self, token: str) -> None:
        prior_configs = self._read_rollback_journal()
        self._restore_adapter_configs(token, prior_configs)
        self._verify_adapter_configs(
            self.platform.fetch_agents(token),
            prior_configs,
        )
        self.paths.rollback_journal.unlink()

    def _recover_interrupted_commissioning(self) -> None:
        self._require_protected_file(self.paths.token, "operator board token")
        token = self.paths.token.read_text(encoding="utf-8").strip()
        if not token:
            raise CommissioningError("operator board token is empty")
        self.platform.set_barrier(False)
        if not self.platform.is_active("paperclip-gloops.service"):
            self.platform.restart_paperclip()
        self.platform.health()
        self._rollback_from_journal(token)
        self.paths.receipt.unlink(missing_ok=True)
        self.platform.restart_paperclip()
        self.platform.health()
        for stale in self.paths.config_dir.glob(
            ".CONTROLLED_SWARM_COMMISSIONING_APPROVED.*",
        ):
            stale.unlink()
        self.paths.approval.unlink(missing_ok=True)

    def _write_receipt(
        self,
        approval: dict[str, object],
        approved_image: str,
        approval_in_progress: Path,
        instruction_receipt: dict[str, object],
    ) -> None:
        validate_instruction_receipt(instruction_receipt)
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
            "executionRoute": EXECUTION_ROUTE,
            "instructionSet": instruction_receipt,
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
        if self.paths.rollback_journal.exists():
            self._recover_interrupted_commissioning()
            raise CommissioningError(
                "recovered interrupted commissioning; fresh approval required",
            )
        self._require_protected_file(self.paths.approval, "commissioning approval")
        approval_in_progress = self.paths.config_dir / (
            f".CONTROLLED_SWARM_COMMISSIONING_APPROVED.{os.getpid()}"
        )
        os.replace(self.paths.approval, approval_in_progress)
        barrier_changed = False
        configs_changed = False
        journal_written = False
        token = ""
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
            prior_configs = self._capture_adapter_configs(
                self.platform.fetch_agents(token),
            )
            instruction_receipt = self._instruction_receipt(prior_configs)
            configs_changed = self._configs_need_update(prior_configs)
            if configs_changed:
                self._write_rollback_journal(
                    approval_in_progress,
                    prior_configs,
                )
                journal_written = True
                self._apply_compact_configs(token)
            validate_roster(
                self.platform.fetch_agents(token),
                require_compact_instructions=True,
            )
            self._write_receipt(
                approval,
                approved_image,
                approval_in_progress,
                instruction_receipt,
            )
            barrier_changed = True
            self.platform.set_barrier(True)
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
            validate_roster(
                self.platform.fetch_agents(token),
                require_compact_instructions=True,
            )
            self.paths.rollback_journal.unlink(missing_ok=True)
        except BaseException:
            if barrier_changed:
                try:
                    self.platform.set_barrier(False)
                finally:
                    try:
                        if journal_written:
                            self._rollback_from_journal(token)
                    finally:
                        self.paths.receipt.unlink(missing_ok=True)
                        self.platform.restart_paperclip()
            else:
                try:
                    if journal_written:
                        self._rollback_from_journal(token)
                finally:
                    self.paths.receipt.unlink(missing_ok=True)
            raise
        finally:
            approval_in_progress.unlink(missing_ok=True)


def verify_commissioned_state(
    paths: CommissioningPaths,
    platform: HostPlatform,
    *,
    live: bool,
    enforce_root_ownership: bool = True,
) -> None:
    commissioner = Commissioner(
        paths,
        platform,
        enforce_root_ownership=enforce_root_ownership,
    )
    if paths.rollback_journal.exists():
        raise CommissioningError(
            "commissioning rollback journal remains unresolved",
        )
    commissioner._require_protected_file(
        paths.receipt,
        "commissioning receipt",
    )
    approved_image = paths.image.read_text(encoding="utf-8").strip()
    receipt = json.loads(paths.receipt.read_text(encoding="utf-8"))
    validate_commissioning_receipt(receipt, approved_image)
    if not live:
        return
    commissioner._require_protected_file(paths.token, "operator board token")
    token = paths.token.read_text(encoding="utf-8").strip()
    if not token:
        raise CommissioningError("operator board token is empty")
    platform.health()
    validate_roster(
        platform.fetch_agents(token),
        require_compact_instructions=True,
    )


def main() -> int:
    paths = CommissioningPaths()
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--verify-receipt", action="store_true")
    mode.add_argument("--verify-live", action="store_true")
    mode.add_argument("--verify-live-if-commissioned", action="store_true")
    args = parser.parse_args()
    platform = HostPlatform(paths)
    if args.verify_live_if_commissioned:
        lines = paths.runtime_env.read_text(encoding="utf-8").splitlines()
        if lines.count("PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false") == 1:
            print("PASS controlled swarm remains inert and uncommissioned")
            return 0
        if lines.count("PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true") != 1:
            raise CommissioningError(
                "controlled-swarm commissioning barrier is malformed",
            )
    if (
        args.verify_receipt
        or args.verify_live
        or args.verify_live_if_commissioned
    ):
        verify_commissioned_state(
            paths,
            platform,
            live=args.verify_live or args.verify_live_if_commissioned,
        )
        print(
            "PASS controlled-swarm commissioning receipt"
            + (
                " and live roster are exact"
                if args.verify_live or args.verify_live_if_commissioned
                else " is exact"
            ),
        )
        return 0
    Commissioner(paths, platform).run()
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
