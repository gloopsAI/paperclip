#!/usr/bin/env python3
"""Execute exactly one Gate 2.5 implementation/review calibration and return dark."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import time
from typing import Any
import urllib.error
import urllib.request
import uuid


SCHEMA = "gloops.gate25-calibration-approval.v1"
RECEIPT_SCHEMA = "gloops.gate25-calibration-receipt.v1"
COMPANY_ID = "89ed0964-d918-4fcc-b830-5be49d2d4089"
PROJECT_ID = "cfca4683-e256-40e0-91b3-f2e513170ec0"
PROJECT_WORKSPACE_ID = "4c2c5815-32ea-4fc5-9991-6a31a7b42bd4"
IMPLEMENTER_ID = "76a090e6-1523-4086-be5f-2a7dd7a37238"
REVIEWER_ID = "843c62bc-6f32-420e-9b62-7a2d6a34846f"
REPOSITORY_ID = 1297008772
REPOSITORY = "gloopsAI/gloops-paperclip-plugin"
DEFAULT_BRANCH = "main"
ZERO_OID = "0" * 40
EXPECTED_IMAGE = (
    "ghcr.io/gloopsai/paperclip-gloops@sha256:"
    "c6cace2d01b45ee22275f4648155c75b72ec7cb0c7c361ddb1a9c48e9db7caa1"
)
CONFIG_DIR = Path("/etc/paperclip-gloops")
RUNTIME_DIR = Path("/run/paperclip-gate25")
STATE_DIR = Path("/var/lib/paperclip-gloops/gate25-calibrations")
APPROVAL = CONFIG_DIR / "GATE25_CALIBRATION_APPROVED"
BOARD_TOKEN = CONFIG_DIR / "operator-board-token"
APPROVED_IMAGE = CONFIG_DIR / "approved-image"
BASE_RUNTIME = CONFIG_DIR / "runtime.env"
LOCK = Path("/run/lock/paperclip-gate25.lock")
PAPERCLIP_API = "http://127.0.0.1:3100"
UNITS = (
    "paperclip-gate25-calibration.service",
    "paperclip-hermes-gate25-calibration.service",
    "paperclip-github-push-broker-gate25.service",
)
PRODUCTION_UNITS = (
    "paperclip-gloops.service",
    "paperclip-hermes-execution.service",
    "paperclip-github-push-broker.service",
    "paperclip-campaign-deadman.service",
    "paperclip-gloops-handshake.service",
    "paperclip-hermes-handshake.service",
)
TERMINAL_RUNS = {"succeeded", "failed", "cancelled", "timed_out"}
WORKSPACE = Path(
    "/opt/paperclip/hermes-execution-state/workspace/controlled-swarm-plugin",
)
BROKER_DATABASE = Path(
    "/var/lib/paperclip-gloops/github-push-broker/broker.sqlite3",
)


class CalibrationError(RuntimeError):
    """A fail-closed calibration refusal."""


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def timestamp(value: dt.datetime | None = None) -> str:
    return (value or now()).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def parse_timestamp(value: object, field: str) -> dt.datetime:
    if not isinstance(value, str):
        raise CalibrationError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise CalibrationError(f"{field} is invalid") from error
    if parsed.tzinfo is None:
        raise CalibrationError(f"{field} must include a timezone")
    return parsed


def validate_approval(value: object, at: dt.datetime, approved_image: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "authorization",
        "calibrationId",
        "approvedImage",
        "companyId",
        "projectId",
        "projectWorkspaceId",
        "implementationAgentId",
        "reviewAgentId",
        "repositoryId",
        "repositoryFullName",
        "defaultBranch",
        "baseSha",
        "authorizedAt",
        "expiresAt",
        "maxWallSeconds",
    }:
        raise CalibrationError("Gate 2.5 approval has an inexact schema")
    authorized = parse_timestamp(value["authorizedAt"], "authorizedAt")
    expires = parse_timestamp(value["expiresAt"], "expiresAt")
    if (
        value["schemaVersion"] != SCHEMA
        or value["authorization"] != "execute_one_implementation_one_review_one_push"
        or not re.fullmatch(r"gate25-[0-9a-f]{32}", str(value["calibrationId"]))
        or value["approvedImage"] != approved_image
        or value["approvedImage"] != EXPECTED_IMAGE
        or value["companyId"] != COMPANY_ID
        or value["projectId"] != PROJECT_ID
        or value["projectWorkspaceId"] != PROJECT_WORKSPACE_ID
        or value["implementationAgentId"] != IMPLEMENTER_ID
        or value["reviewAgentId"] != REVIEWER_ID
        or value["repositoryId"] != REPOSITORY_ID
        or value["repositoryFullName"] != REPOSITORY
        or value["defaultBranch"] != DEFAULT_BRANCH
        or not re.fullmatch(r"[0-9a-f]{40}", str(value["baseSha"]))
        or type(value["maxWallSeconds"]) is not int
        or not 900 <= value["maxWallSeconds"] <= 5400
        or not authorized <= at < expires
        or expires - authorized > dt.timedelta(hours=4)
    ):
        raise CalibrationError("Gate 2.5 approval is stale or boundary-mismatched")
    return value


def protected_file(path: Path, label: str) -> bytes:
    try:
        metadata = path.stat()
    except FileNotFoundError as error:
        raise CalibrationError(f"{label} is missing") from error
    if (
        metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise CalibrationError(f"{label} must be root:root mode 0600")
    return path.read_bytes()


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, capture_output=True, text=True)


def is_active(unit: str) -> bool:
    return run("systemctl", "is-active", "--quiet", unit, check=False).returncode == 0


def api(token: str, method: str, path: str, body: object | None = None) -> Any:
    data = None if body is None else canonical_json(body).encode()
    request = urllib.request.Request(
        f"{PAPERCLIP_API}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = response.read(4 * 1024 * 1024 + 1)
            if len(payload) > 4 * 1024 * 1024:
                raise CalibrationError("Paperclip API response exceeds the calibration limit")
            return {} if not payload else json.loads(payload)
    except urllib.error.HTTPError as error:
        detail = error.read(4096).decode(errors="replace")
        raise CalibrationError(f"Paperclip {method} {path} returned HTTP {error.code}: {detail}") from error
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        raise CalibrationError(f"Paperclip {method} {path} is unavailable or malformed") from error


def runtime_environment(approval: dict[str, Any]) -> str:
    excluded = {
        "PAPERCLIP_CAMPAIGN_ID",
        "PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET",
        "PAPERCLIP_CAMPAIGN_DURATION_SECONDS",
        "PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS",
        "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED",
        "PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS",
        "PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE",
        "PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK",
        "PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK",
        "PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK",
        "PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK",
        "PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK",
        "PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION",
        "PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION",
        "PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION",
        "PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION",
    }
    retained = []
    for line in BASE_RUNTIME.read_text(encoding="utf-8").splitlines():
        key = line.split("=", 1)[0]
        if key not in excluded:
            retained.append(line)
    cutoff = timestamp(now() - dt.timedelta(seconds=5))
    retained.extend([
        "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true",
        "PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS=1",
        f"PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE={cutoff}",
        "PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK=2",
        "PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK=0",
        "PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK=40000",
        "PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK=12000",
        f"PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK={approval['maxWallSeconds'] * 1000}",
        "PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION=20000",
        "PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION=6000",
        "PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION=6",
        "PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION=16",
    ])
    return "\n".join(retained) + "\n"


def calibration_instructions(role: str, approval: dict[str, Any]) -> str:
    common = f"""# Gate 2.5 one-use calibration

Calibration: {approval["calibrationId"]}
Repository: {REPOSITORY}
Workspace: /opt/data/workspace/controlled-swarm-plugin
Base: {approval["baseSha"]}

This is one bounded substrate measurement. Do not inspect unrelated work, create another
issue/run, retry, merge, deploy, open a pull request, touch another repository, use a
fallback provider, or invoke Grok/xAI. Use only the assigned issue and current run.
"""
    if role == "implementer":
        return common + """
Verify the workspace is clean and HEAD equals the exact base. Add one JSON file at
`receipts/gate25-calibration.json` containing only schemaVersion
`gloops.gate25-sandbox-artifact.v1`, this calibration id, the current Paperclip run id,
and outcome `implementation_complete`. Commit it with message
`test: record Gate 2.5 calibration artifact`. Then invoke exactly once:

`node /opt/data/bin/github-push-tool.bundle.cjs client --run-id "$PAPERCLIP_RUN_ID" --repo-dir /opt/data/workspace/controlled-swarm-plugin`

After a successful broker receipt, PATCH the assigned Paperclip issue to `in_review`
with a reviewRequest asking the configured reviewer to verify the exact commit, diff,
single broker push, and no merge/deploy. Leave one concise comment. End with exactly one:
`PAPERCLIP_SWARM_V1:{"action":"review_ready","headSha":"<40 hex>","summary":"Gate 2.5 implementation pushed once for independent review"}`
"""
    return common + """
Do not modify or push. Verify the workspace HEAD, the one-file diff from the exact base,
the artifact schema and identities, and the broker receipt recorded on the assigned
Paperclip issue. Confirm no merge, deployment, second push, or unrelated repository
mutation occurred. If accepted, POST one issue comment whose first heading is
`## Review: Gate 2.5 - APPROVED`; otherwise PATCH the issue to `in_progress` with a
precise changes-requested comment. End with exactly one accepted or changes_requested
PAPERCLIP_SWARM_V1 marker using the reviewed head.
"""


def build_adapter(original: dict[str, Any], instructions: str) -> dict[str, Any]:
    config = original.get("adapterConfig")
    if not isinstance(config, dict) or not isinstance(config.get("apiKey"), dict):
        raise CalibrationError("calibration agent lacks its secret-ref gateway key")
    return {
        "apiBaseUrl": "http://hermes-execution:8642",
        "dangerouslyAllowInsecureRemoteHttp": True,
        "executionProfile": "paperclip-execution-only",
        "fallbackOccurred": False,
        "paperclipApiUrl": "http://paperclip-gloops:3100",
        "routingReason": "gate25-ollama-only",
        "sessionKeyStrategy": "none",
        "subscriptionClass": "ollama-max",
        "timeoutSec": 1200,
        "apiKey": config["apiKey"],
        "instructions": instructions,
    }


def patch_agent(token: str, agent_id: str, original: dict[str, Any], instructions: str) -> None:
    api(token, "PATCH", f"/api/agents/{agent_id}", {
        "status": "active",
        "adapterConfig": build_adapter(original, instructions),
        "replaceAdapterConfig": True,
        "runtimeConfig": {
            "heartbeat": {
                "enabled": False,
                "intervalSec": 3600,
                "wakeOnDemand": True,
                "maxConcurrentRuns": 1,
            },
        },
    })


def restore_agent(token: str, original: dict[str, Any]) -> None:
    api(token, "PATCH", f"/api/agents/{original['id']}", {
        "status": "paused",
        "adapterConfig": original["adapterConfig"],
        "replaceAdapterConfig": True,
        "runtimeConfig": original["runtimeConfig"],
    })


def wait_run(token: str, run_id: str, deadline: float) -> dict[str, Any]:
    while time.monotonic() < deadline:
        value = api(token, "GET", f"/api/heartbeat-runs/{run_id}")
        if value.get("status") in TERMINAL_RUNS:
            return value
        time.sleep(2)
    raise CalibrationError(f"run {run_id} exceeded the one-use wall deadline")


def wait_review_run(token: str, issue_id: str, implementation_run: str, deadline: float) -> dict[str, Any]:
    seen: set[str] = {implementation_run}
    while time.monotonic() < deadline:
        for value in api(token, "GET", f"/api/issues/{issue_id}/runs"):
            run_id = value.get("runId")
            if isinstance(run_id, str) and run_id not in seen and value.get("agentId") == REVIEWER_ID:
                return wait_run(token, run_id, deadline)
        time.sleep(2)
    raise CalibrationError("independent review run was not admitted before the deadline")


def protect_root_file(path: Path) -> None:
    if os.geteuid() == 0:
        os.chown(path, 0, 0)
    os.chmod(path, 0o600)


def atomic_root_write(path: Path, value: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}")
    try:
        with temporary.open("wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        protect_root_file(temporary)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def install_authorization(approval: dict[str, Any], issue: dict[str, Any], run_id: str) -> str:
    deadline = min(
        parse_timestamp(approval["expiresAt"], "expiresAt"),
        now() + dt.timedelta(minutes=60),
    )
    value = {
        "schemaVersion": "gloops.github-push-authorization.v1",
        "calibrationId": approval["calibrationId"],
        "campaignId": "gate-2.5-no-campaign",
        "companyId": COMPANY_ID,
        "paperclipRunId": run_id,
        "issueId": issue["id"],
        "agentId": IMPLEMENTER_ID,
        "projectId": PROJECT_ID,
        "projectWorkspaceId": PROJECT_WORKSPACE_ID,
        "repositoryId": REPOSITORY_ID,
        "repositoryFullName": REPOSITORY,
        "defaultBranch": DEFAULT_BRANCH,
        "branchRef": f"refs/heads/paperclip/{run_id}/calibration",
        "deadline": timestamp(deadline),
        "mutationClass": "create_one_branch_ref",
        "maxLeases": 1,
        "maxMutations": 1,
        "expectedOldOid": ZERO_OID,
    }
    raw = canonical_json(value).encode()
    domain_digest = sha256_bytes(
        b"gloops.github-push-authorization.v1\0" + raw,
    )
    authorization = CONFIG_DIR / "github-push-authorization.json"
    digest_path = CONFIG_DIR / "github-push-authorization.sha256"
    atomic_root_write(authorization, raw)
    atomic_root_write(digest_path, (domain_digest + "\n").encode())
    return domain_digest


def verify_workspace(approval: dict[str, Any]) -> None:
    safe = f"safe.directory={WORKSPACE}"
    head = run("git", "-c", safe, "-C", str(WORKSPACE), "rev-parse", "HEAD").stdout.strip()
    status = run(
        "git",
        "-c",
        safe,
        "-C",
        str(WORKSPACE),
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    ).stdout
    origin = run(
        "git",
        "-c",
        safe,
        "-C",
        str(WORKSPACE),
        "remote",
        "get-url",
        "origin",
    ).stdout.strip()
    if head != approval["baseSha"] or status:
        raise CalibrationError("calibration workspace is not clean at the exact approved base")
    if origin not in {
        f"https://github.com/{REPOSITORY}.git",
        f"git@github.com:{REPOSITORY}.git",
    }:
        raise CalibrationError("calibration workspace origin is not the approved repository")


def run_receipt(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if not value:
        return None
    allowed = (
        "id",
        "status",
        "agentId",
        "startedAt",
        "finishedAt",
        "createdAt",
        "invocationSource",
        "errorCode",
        "usageJson",
        "retryOfRunId",
        "scheduledRetryAttempt",
        "continuationAttempt",
    )
    return {key: value[key] for key in allowed if key in value}


def broker_receipt(run_id: str, authorization_digest: str) -> dict[str, Any]:
    connection = sqlite3.connect(f"file:{BROKER_DATABASE}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT authorization_digest, state, terminal_receipt_json, terminal_posted
            FROM leases
            WHERE json_extract(lease_json, '$.paperclipRunId') = ?
            """,
            (run_id,),
        ).fetchall()
    finally:
        connection.close()
    if len(rows) != 1:
        raise CalibrationError("implementation run did not consume exactly one broker lease")
    row = rows[0]
    if (
        row["authorization_digest"] != authorization_digest
        or row["state"] != "reconciled_success"
        or row["terminal_posted"] != 1
        or not row["terminal_receipt_json"]
    ):
        raise CalibrationError("GitHub broker did not settle one successful terminal receipt")
    value = json.loads(row["terminal_receipt_json"])
    expected_branch = f"refs/heads/paperclip/{run_id}/calibration"
    if (
        value.get("heartbeatRunId") != run_id
        or value.get("branchRef") != expected_branch
        or value.get("state") != "reconciled_success"
        or value.get("rootAuthorizationDigest") != authorization_digest
        or value.get("expectedOldOid") != ZERO_OID
        or value.get("remoteOldOid") != ZERO_OID
        or value.get("remoteNewOid") != value.get("expectedNewOid")
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(value.get("brokerReceiptDigest")))
    ):
        raise CalibrationError("GitHub broker terminal receipt conflicts with the calibration")
    return {
        key: value[key]
        for key in (
            "heartbeatRunId",
            "branchRef",
            "expectedNewOid",
            "remoteNewOid",
            "state",
            "brokerReceiptDigest",
        )
    }


def company_run_ids(token: str) -> set[str]:
    values = api(
        token,
        "GET",
        f"/api/companies/{COMPANY_ID}/heartbeat-runs?limit=1000&summary=true",
    )
    if not isinstance(values, list):
        raise CalibrationError("company run inventory is malformed")
    return {
        value["id"]
        for value in values
        if isinstance(value, dict) and isinstance(value.get("id"), str)
    }


def create_issue(token: str, approval: dict[str, Any]) -> dict[str, Any]:
    review_stage = str(uuid.uuid4())
    issue = api(token, "POST", f"/api/companies/{COMPANY_ID}/issues", {
        "projectId": PROJECT_ID,
        "projectWorkspaceId": PROJECT_WORKSPACE_ID,
        "title": f"Gate 2.5 calibration {approval['calibrationId']}",
        "description": (
            "One disposable implementation plus independent review against the sandbox "
            "repository. No PR, merge, deploy, retry, recovery, or unrelated wake is authorized."
        ),
        "status": "todo",
        "priority": "high",
        "executionPolicy": {
            "mode": "normal",
            "commentRequired": True,
            "stages": [{
                "id": review_stage,
                "type": "review",
                "approvalsNeeded": 1,
                "participants": [{"type": "agent", "agentId": REVIEWER_ID}],
            }],
        },
        "assigneeAdapterOverrides": {"useProjectWorkspace": True},
    })
    return api(token, "PATCH", f"/api/issues/{issue['id']}", {
        "assigneeAgentId": IMPLEMENTER_ID,
        "status": "todo",
    })


def stop_and_mask() -> None:
    for unit in UNITS:
        run("systemctl", "stop", unit, check=False)
    run("docker", "rm", "-f", "paperclip-gloops", check=False)
    run("docker", "rm", "-f", "paperclip-hermes-execution", check=False)
    run("systemctl", "mask", *UNITS, check=False)
    for path in (
        CONFIG_DIR / "github-push-authorization.json",
        CONFIG_DIR / "github-push-authorization.sha256",
    ):
        path.unlink(missing_ok=True)
    for pattern in (
        ".github-push-authorization.json.*",
        ".github-push-authorization.sha256.*",
    ):
        for path in CONFIG_DIR.glob(pattern):
            path.unlink(missing_ok=True)
    if RUNTIME_DIR.exists():
        for child in RUNTIME_DIR.iterdir():
            if child.is_file() or child.is_symlink():
                child.unlink(missing_ok=True)
        try:
            RUNTIME_DIR.rmdir()
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--approval", type=Path, default=APPROVAL)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Gate 2.5 calibration must run as root")
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    with LOCK.open("w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run("/usr/local/lib/paperclip-gloops/verify-dark.sh")
        if any(is_active(unit) for unit in PRODUCTION_UNITS + UNITS):
            raise CalibrationError("Gate 2.5 requires the exact fully dark baseline")
        approved_image = protected_file(APPROVED_IMAGE, "approved image").decode().strip()
        approval_raw = protected_file(args.approval, "Gate 2.5 approval")
        approval = validate_approval(json.loads(approval_raw), now(), approved_image)
        verify_workspace(approval)
        in_progress = CONFIG_DIR / f".GATE25_CALIBRATION_APPROVED.{os.getpid()}"
        os.replace(args.approval, in_progress)

        approval_digest = sha256_bytes(approval_raw)
        token = ""
        original_agents: dict[str, dict[str, Any]] = {}
        issue: dict[str, Any] | None = None
        implementation_run: dict[str, Any] | None = None
        review_run: dict[str, Any] | None = None
        authorization_digest: str | None = None
        mutation_receipt: dict[str, Any] | None = None
        outcome = "failed"
        error_text: str | None = None
        started = timestamp()
        deadline = time.monotonic() + approval["maxWallSeconds"]
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            os.chown(STATE_DIR, 0, 0)
            os.chmod(STATE_DIR, 0o700)
            token = protected_file(BOARD_TOKEN, "operator board token").decode().strip()
            if not token.startswith("pcp_board_"):
                raise CalibrationError("operator board token is malformed")
            RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
            os.chown(RUNTIME_DIR, 0, 0)
            os.chmod(RUNTIME_DIR, 0o700)
            (RUNTIME_DIR / "approval.sha256").write_text(
                approval_digest + "\n",
                encoding="utf-8",
            )
            (RUNTIME_DIR / "runtime.env").write_text(
                runtime_environment(approval),
                encoding="utf-8",
            )
            for name in ("BROKER_ACTIVE", "HERMES_ACTIVE", "PAPERCLIP_ACTIVE"):
                (RUNTIME_DIR / name).touch(mode=0o600)
            for child in RUNTIME_DIR.iterdir():
                os.chown(child, 0, 0)
                os.chmod(child, 0o600)

            run("systemctl", "unmask", *UNITS)
            run("systemctl", "daemon-reload")
            run("systemctl", "start", UNITS[2])
            run("systemctl", "start", UNITS[1])
            run("systemctl", "start", UNITS[0])

            agents = api(token, "GET", f"/api/companies/{COMPANY_ID}/agent-configurations")
            if (
                not isinstance(agents, list)
                or len(agents) != 16
                or any(agent.get("status") not in {"paused", "pending_approval"} for agent in agents)
            ):
                raise CalibrationError("the exact paused sixteen-identity roster is not present")
            by_id = {agent.get("id"): agent for agent in agents}
            for agent_id in (IMPLEMENTER_ID, REVIEWER_ID):
                agent = by_id.get(agent_id)
                if not isinstance(agent, dict) or agent.get("status") != "paused" or agent.get("adapterType") != "hermes_gateway":
                    raise CalibrationError("a Gate 2.5 identity has drifted")
                original_agents[agent_id] = agent

            baseline_run_ids = company_run_ids(token)
            if api(token, "GET", f"/api/companies/{COMPANY_ID}/live-runs?limit=50"):
                raise CalibrationError("Gate 2.5 requires zero live company runs before mutation")
            issue = create_issue(token, approval)
            time.sleep(1)
            if api(token, "GET", f"/api/issues/{issue['id']}/live-runs"):
                raise CalibrationError("assignment created a run while the implementer was paused")
            patch_agent(token, IMPLEMENTER_ID, original_agents[IMPLEMENTER_ID], calibration_instructions("implementer", approval))
            patch_agent(token, REVIEWER_ID, original_agents[REVIEWER_ID], calibration_instructions("reviewer", approval))
            if company_run_ids(token) != baseline_run_ids:
                raise CalibrationError("an unrequested run started while preparing Gate 2.5")
            implementation_run = api(token, "POST", f"/api/agents/{IMPLEMENTER_ID}/wakeup", {
                "source": "on_demand",
                "triggerDetail": "system",
                "reason": "gate25_calibration_implementation",
                "payload": {"issueId": issue["id"], "taskId": issue["id"]},
                "idempotencyKey": f"{approval['calibrationId']}:implementation",
                "forceFreshSession": True,
            })
            run_id = implementation_run.get("id")
            if not isinstance(run_id, str):
                raise CalibrationError("implementation wake did not return a run identity")
            authorization_digest = install_authorization(approval, issue, run_id)
            implementation_run = wait_run(token, run_id, deadline)
            if implementation_run.get("status") != "succeeded":
                raise CalibrationError("the one implementation run did not succeed")
            mutation_receipt = broker_receipt(run_id, authorization_digest)
            review_run = wait_review_run(token, issue["id"], run_id, deadline)
            if review_run.get("status") != "succeeded":
                raise CalibrationError("the one independent review run did not succeed")
            terminal_issue = api(token, "GET", f"/api/issues/{issue['id']}")
            if terminal_issue.get("status") != "done":
                raise CalibrationError("independent review did not complete the calibration issue")
            review_run_id = review_run.get("id")
            if not isinstance(review_run_id, str):
                raise CalibrationError("review run lacks its exact identity")
            new_run_ids = company_run_ids(token) - baseline_run_ids
            if new_run_ids != {run_id, review_run_id}:
                raise CalibrationError("Gate 2.5 admitted an unrelated or duplicate run")
            issue_runs = api(token, "GET", f"/api/issues/{issue['id']}/runs")
            if (
                not isinstance(issue_runs, list)
                or len(issue_runs) != 2
                or {value.get("runId") for value in issue_runs} != new_run_ids
                or any(value.get("retryOfRunId") for value in issue_runs)
            ):
                raise CalibrationError("Gate 2.5 issue did not settle as exactly two non-retry runs")
            if api(token, "GET", f"/api/companies/{COMPANY_ID}/live-runs?limit=50"):
                raise CalibrationError("a live run remains at the Gate 2.5 terminal boundary")
            outcome = "passed"
        except BaseException as error:
            error_text = f"{type(error).__name__}: {error}"
            raise
        finally:
            for agent_id in (IMPLEMENTER_ID, REVIEWER_ID):
                if agent_id in original_agents:
                    try:
                        restore_agent(token, original_agents[agent_id])
                    except BaseException as restore_error:
                        error_text = (
                            f"{error_text}; " if error_text else ""
                        ) + f"restore {agent_id}: {restore_error}"
                        outcome = "failed"
            try:
                stop_and_mask()
            except BaseException as cleanup_error:
                error_text = (
                    f"{error_text}; " if error_text else ""
                ) + f"cleanup failed: {cleanup_error}"
                outcome = "failed"
            finally:
                in_progress.unlink(missing_ok=True)
            dark_result = run(
                "/usr/local/lib/paperclip-gloops/verify-dark.sh",
                check=False,
            )
            dark_verified = dark_result.returncode == 0
            if not dark_verified:
                dark_detail = (dark_result.stderr or dark_result.stdout)[-2000:].strip()
                error_text = (
                    f"{error_text}; " if error_text else ""
                ) + f"dark verification failed: {dark_detail}"
                outcome = "failed"
            receipt = {
                "schemaVersion": RECEIPT_SCHEMA,
                "calibrationId": approval["calibrationId"],
                "approvalSha256": approval_digest,
                "approvedImage": approved_image,
                "startedAt": started,
                "completedAt": timestamp(),
                "outcome": outcome,
                "issueId": issue.get("id") if issue else None,
                "implementationRun": run_receipt(implementation_run),
                "reviewRun": run_receipt(review_run),
                "githubAuthorizationDigest": authorization_digest,
                "repositoryMutationReceipt": mutation_receipt,
                "providerPolicy": "ollama-cloud-only",
                "automaticRetries": 0,
                "maximumRuns": 2,
                "mergeAuthorized": False,
                "deploymentAuthorized": False,
                "campaignEpochUsed": False,
                "darkVerifiedAfterRun": dark_verified,
                "error": error_text,
            }
            receipt_path = STATE_DIR / f"{approval['calibrationId']}.json"
            receipt_path.write_text(canonical_json(receipt) + "\n", encoding="utf-8")
            os.chown(receipt_path, 0, 0)
            os.chmod(receipt_path, 0o600)
            print(canonical_json({
                "outcome": outcome,
                "receipt": str(receipt_path),
                "receiptSha256": sha256_bytes(receipt_path.read_bytes()),
            }))
        if outcome != "passed":
            raise CalibrationError(error_text or "Gate 2.5 calibration failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
