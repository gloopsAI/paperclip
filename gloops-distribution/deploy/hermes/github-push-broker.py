#!/usr/bin/env python3
from __future__ import annotations

import fcntl
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ZERO_OID = "0" * 40
OID_PATTERN = re.compile(r"^[0-9a-f]{40}$")
RUN_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
MANIFEST_PATTERN = re.compile(r"^[0-9a-f-]{36}-[0-9a-f]{32}\.json$")
MAX_REQUEST_BYTES = 16 * 1024
MAX_RESPONSE_BYTES = 128 * 1024
MAX_PACK_BYTES = 64 * 1024 * 1024
MAX_OBJECTS = 100_000
EXPECTED_HERMES_UID = 10_000
WORKER_UID = 10_001
WORKER_GID = 10_001

CONFIG_DIR = Path(os.environ.get("GLOOPS_GITHUB_BROKER_CONFIG_DIR", "/etc/paperclip-gloops"))
STATE_DIR = Path(os.environ.get("GLOOPS_GITHUB_BROKER_STATE_DIR", "/var/lib/paperclip-gloops/github-push-broker"))
RUNTIME_DIR = Path(os.environ.get("GLOOPS_GITHUB_BROKER_RUNTIME_DIR", "/run/paperclip-github-broker"))
SOCKET_PATH = RUNTIME_DIR / "broker.sock"
INGRESS_DIR = RUNTIME_DIR / "ingress"
AUTHORIZATION = CONFIG_DIR / "github-push-authorization.json"
AUTHORIZATION_DIGEST = CONFIG_DIR / "github-push-authorization.sha256"
BROKER_TOKEN = CONFIG_DIR / "github-broker-receipt-token"
BOARD_TOKEN = CONFIG_DIR / "operator-board-token"
APP_CONFIG = CONFIG_DIR / "github-app.json"
TOOL = Path(os.environ.get(
    "GLOOPS_GITHUB_PUSH_TOOL",
    "/usr/local/lib/paperclip-gloops/tools/github-push-tool.bundle.cjs",
))
CREDENTIAL_MODULE = Path(os.environ.get(
    "GLOOPS_GITHUB_CREDENTIAL_MODULE",
    "/usr/local/lib/paperclip-gloops/github-app-credentials.py",
))
PAPERCLIP_API = os.environ.get(
    "GLOOPS_PAPERCLIP_API_BASE",
    "http://127.0.0.1:3100/api",
).rstrip("/")
DATABASE = STATE_DIR / "broker.sqlite3"
COMMAND_LOCK = STATE_DIR / "command.lock"
TEST_MODE = os.environ.get("GLOOPS_GITHUB_BROKER_TEST_MODE") == "1"


class BrokerError(RuntimeError):
    pass


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise BrokerError("timestamp lacks a timezone")
    return parsed.astimezone(timezone.utc)


def canonical_json(value: Any) -> str:
    def validate(entry: Any) -> None:
        if entry is None or isinstance(entry, (str, bool)):
            return
        if isinstance(entry, int) and not isinstance(entry, bool):
            if entry < 0:
                raise BrokerError("canonical record contains a negative number")
            return
        if isinstance(entry, list):
            for item in entry:
                validate(item)
            return
        if isinstance(entry, dict) and all(isinstance(key, str) for key in entry):
            for item in entry.values():
                validate(item)
            return
        raise BrokerError("canonical record contains an unsupported value")

    validate(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(domain: str, value: Any) -> str:
    payload = domain.encode() + b"\0" + canonical_json(value).encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise BrokerError(f"{label} keys do not match the accepted schema")
    return value


def read_root_secret(path: Path, label: str) -> str:
    metadata = path.stat()
    mode = stat.S_IMODE(metadata.st_mode)
    if metadata.st_uid != 0 or mode not in {0o400, 0o600, 0o640} or mode & 0o007:
        raise BrokerError(f"{label} is not root-protected")
    value = path.read_text().strip()
    if not value:
        raise BrokerError(f"{label} is empty")
    return value


def durable_write(path: Path, value: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, stage = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, 0, 0)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(stage, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            os.unlink(stage)
        except FileNotFoundError:
            pass
        raise


def durable_unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def fsync_database() -> None:
    for path in (DATABASE, Path(f"{DATABASE}-wal")):
        try:
            fd = os.open(path, os.O_RDONLY)
        except FileNotFoundError:
            continue
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    directory = os.open(STATE_DIR, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def connect_database() -> sqlite3.Connection:
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE_DIR, 0o700)
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS allocations (
          authorization_digest TEXT NOT NULL,
          heartbeat_run_id TEXT NOT NULL,
          repository_id TEXT NOT NULL,
          mutation_class TEXT NOT NULL,
          branch_ref TEXT NOT NULL,
          nonce TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (authorization_digest, heartbeat_run_id, repository_id, mutation_class),
          UNIQUE (repository_id, branch_ref),
          UNIQUE (nonce)
        );
        CREATE TABLE IF NOT EXISTS leases (
          nonce TEXT PRIMARY KEY,
          authorization_json TEXT NOT NULL,
          authorization_digest TEXT NOT NULL,
          lease_json TEXT NOT NULL,
          lease_digest TEXT NOT NULL,
          state TEXT NOT NULL,
          prepared_receipt_json TEXT NOT NULL,
          prepared_posted INTEGER NOT NULL DEFAULT 0,
          terminal_receipt_json TEXT,
          terminal_posted INTEGER NOT NULL DEFAULT 0,
          token_path TEXT,
          mint_started_at TEXT,
          mint_safe_after TEXT,
          token_expires_at TEXT,
          remote_old_oid TEXT,
          remote_new_oid TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS journal (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          nonce TEXT NOT NULL,
          state TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          previous_digest TEXT NOT NULL,
          entry_digest TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );
        """
    )
    lease_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(leases)").fetchall()
    }
    for column in ("mint_started_at", "mint_safe_after", "token_expires_at"):
        if column not in lease_columns:
            connection.execute(f"ALTER TABLE leases ADD COLUMN {column} TEXT")
    connection.commit()
    os.chmod(DATABASE, 0o600)
    fsync_database()
    return connection


def append_journal(
    connection: sqlite3.Connection,
    nonce: str,
    state_value: str,
    payload: dict[str, Any],
) -> str:
    previous = connection.execute(
        "SELECT entry_digest FROM journal ORDER BY sequence DESC LIMIT 1"
    ).fetchone()
    previous_digest = previous["entry_digest"] if previous else "sha256:" + "0" * 64
    created_at = timestamp()
    projection = {
        "nonce": nonce,
        "state": state_value,
        "payload": payload,
        "previousDigest": previous_digest,
        "createdAt": created_at,
    }
    entry_digest = digest("gloops.github-push-journal.v1", projection)
    connection.execute(
        """
        INSERT INTO journal (nonce, state, payload_json, previous_digest, entry_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (nonce, state_value, canonical_json(payload), previous_digest, entry_digest, created_at),
    )
    return entry_digest


def verify_journal(connection: sqlite3.Connection) -> None:
    previous = "sha256:" + "0" * 64
    for row in connection.execute("SELECT * FROM journal ORDER BY sequence"):
        payload = json.loads(row["payload_json"])
        projection = {
            "nonce": row["nonce"],
            "state": row["state"],
            "payload": payload,
            "previousDigest": previous,
            "createdAt": row["created_at"],
        }
        expected = digest("gloops.github-push-journal.v1", projection)
        if row["previous_digest"] != previous or row["entry_digest"] != expected:
            raise BrokerError("lease journal hash chain is invalid")
        previous = expected


def load_authorization() -> tuple[dict[str, Any], str]:
    authorization = exact_keys(
        json.loads(read_root_secret(AUTHORIZATION, "GitHub push authorization")),
        {
            "schemaVersion",
            "calibrationId",
            "campaignId",
            "companyId",
            "paperclipRunId",
            "issueId",
            "agentId",
            "projectId",
            "projectWorkspaceId",
            "repositoryId",
            "repositoryFullName",
            "defaultBranch",
            "branchRef",
            "deadline",
            "mutationClass",
            "maxLeases",
            "maxMutations",
            "expectedOldOid",
        },
        "root authorization",
    )
    authorization_digest = digest("gloops.github-push-authorization.v1", authorization)
    recorded_digest = read_root_secret(AUTHORIZATION_DIGEST, "GitHub push authorization digest")
    if recorded_digest != authorization_digest:
        raise BrokerError("root authorization digest does not match its canonical body")
    if (
        authorization["schemaVersion"] != "gloops.github-push-authorization.v1"
        or authorization["mutationClass"] != "create_one_branch_ref"
        or authorization["maxLeases"] != 1
        or authorization["maxMutations"] != 1
        or authorization["expectedOldOid"] != ZERO_OID
        or not RUN_ID_PATTERN.fullmatch(str(authorization["paperclipRunId"]))
        or authorization["branchRef"]
        != f"refs/heads/paperclip/{authorization['paperclipRunId']}/calibration"
        or not REPOSITORY_PATTERN.fullmatch(str(authorization["repositoryFullName"]))
        or not isinstance(authorization["repositoryId"], int)
        or authorization["repositoryId"] <= 0
        or parse_timestamp(str(authorization["deadline"])) <= datetime.now(timezone.utc)
    ):
        raise BrokerError("root authorization violates the one-run/one-push contract")
    return authorization, authorization_digest


def load_app_module():
    spec = importlib.util.spec_from_file_location("gloops_github_app_credentials", CREDENTIAL_MODULE)
    if spec is None or spec.loader is None:
        raise BrokerError("GitHub App credential module is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def paperclip_request(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    board_token = read_root_secret(BOARD_TOKEN, "Paperclip board token")
    broker_token = read_root_secret(BROKER_TOKEN, "Paperclip broker receipt token")
    if not board_token.startswith("pcp_board_") or not re.fullmatch(r"pcp_broker_[0-9a-f]{64}", broker_token):
        raise BrokerError("Paperclip broker credentials are malformed")
    data = None if body is None else canonical_json(body).encode()
    request = Request(
        f"{PAPERCLIP_API}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {board_token}",
            "X-Paperclip-Github-Broker-Token": broker_token,
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise BrokerError("Paperclip broker response exceeds limit")
            return {} if not payload else json.loads(payload)
    except HTTPError as error:
        raise BrokerError(f"Paperclip broker boundary returned HTTP {error.code}") from error
    except (URLError, json.JSONDecodeError) as error:
        raise BrokerError("Paperclip broker boundary is unavailable or malformed") from error


def read_peer_credentials(connection: socket.socket) -> tuple[int, int, int]:
    if TEST_MODE:
        return os.getpid(), os.getuid(), os.getgid()
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", raw)


def verify_peer(connection: socket.socket) -> None:
    if TEST_MODE:
        return
    pid, uid, _gid = read_peer_credentials(connection)
    if uid != EXPECTED_HERMES_UID:
        raise BrokerError("socket peer is not the fixed Hermes identity")
    init_pid_text = subprocess.run(
        [
            "/usr/bin/docker",
            "inspect",
            "--format",
            "{{.State.Pid}}",
            "paperclip-hermes-execution",
        ],
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()
    if not init_pid_text.isdigit():
        raise BrokerError("Hermes container identity is unavailable")
    peer_cgroup = Path(f"/proc/{pid}/cgroup").read_text()
    init_cgroup = Path(f"/proc/{init_pid_text}/cgroup").read_text()
    if peer_cgroup != init_cgroup or "docker" not in peer_cgroup:
        raise BrokerError("socket peer is outside the exact Hermes container cgroup")
    executable = os.readlink(f"/proc/{pid}/exe")
    if not executable.endswith("/node"):
        raise BrokerError("socket peer executable is not the pinned Node runtime")
    command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    expected_script = b"/opt/data/bin/github-push-tool.bundle.cjs"
    if expected_script not in command or b"client" not in command:
        raise BrokerError("socket peer command is not the installed GitHub push client")
    peer_tool = Path(f"/proc/{pid}/root/opt/data/bin/github-push-tool.bundle.cjs")
    metadata = peer_tool.stat()
    if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o555:
        raise BrokerError("installed GitHub push client is not root-owned and immutable")
    if hashlib.sha256(peer_tool.read_bytes()).digest() != hashlib.sha256(TOOL.read_bytes()).digest():
        raise BrokerError("socket peer GitHub push client digest has drifted")


def read_request(connection: socket.socket) -> dict[str, Any]:
    chunks = bytearray()
    while True:
        chunk = connection.recv(4096)
        if not chunk:
            break
        chunks.extend(chunk)
        if len(chunks) > MAX_REQUEST_BYTES:
            raise BrokerError("socket request exceeds limit")
    try:
        request = json.loads(chunks)
    except json.JSONDecodeError as error:
        raise BrokerError("socket request is malformed") from error
    return exact_keys(
        request,
        {"schemaVersion", "heartbeatRunId", "expectedNewOid", "manifestName"},
        "socket request",
    )


def read_bundle(request: dict[str, Any], work_dir: Path) -> tuple[dict[str, Any], Path]:
    if (
        request["schemaVersion"] != "gloops.github-push-client-request.v1"
        or not RUN_ID_PATTERN.fullmatch(str(request["heartbeatRunId"]))
        or not OID_PATTERN.fullmatch(str(request["expectedNewOid"]))
        or not MANIFEST_PATTERN.fullmatch(str(request["manifestName"]))
    ):
        raise BrokerError("socket request violates the accepted schema")
    manifest_path = INGRESS_DIR / request["manifestName"]
    metadata = manifest_path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != EXPECTED_HERMES_UID:
        raise BrokerError("bundle manifest is not a regular Hermes-owned file")
    manifest = exact_keys(
        json.loads(manifest_path.read_text()),
        {
            "schemaVersion",
            "heartbeatRunId",
            "expectedNewOid",
            "objectCount",
            "objectOids",
            "packBytes",
            "packName",
            "packSha256",
        },
        "bundle manifest",
    )
    object_oids = manifest["objectOids"]
    if (
        manifest["schemaVersion"] != "gloops.github-push-bundle.v1"
        or manifest["heartbeatRunId"] != request["heartbeatRunId"]
        or manifest["expectedNewOid"] != request["expectedNewOid"]
        or not isinstance(object_oids, list)
        or not object_oids
        or len(object_oids) > MAX_OBJECTS
        or manifest["objectCount"] != len(object_oids)
        or len(set(object_oids)) != len(object_oids)
        or any(not isinstance(oid, str) or not OID_PATTERN.fullmatch(oid) for oid in object_oids)
        or not isinstance(manifest["packBytes"], int)
        or not 0 < manifest["packBytes"] <= MAX_PACK_BYTES
        or not SHA256_PATTERN.fullmatch(str(manifest["packSha256"]))
        or not isinstance(manifest["packName"], str)
        or Path(manifest["packName"]).name != manifest["packName"]
        or not manifest["packName"].endswith(".pack")
        or not manifest["packName"].startswith(request["manifestName"][:-5])
    ):
        raise BrokerError("bundle manifest violates the accepted content contract")
    pack_path = INGRESS_DIR / manifest["packName"]
    pack_metadata = pack_path.lstat()
    if (
        not stat.S_ISREG(pack_metadata.st_mode)
        or pack_metadata.st_uid != EXPECTED_HERMES_UID
        or pack_metadata.st_size != manifest["packBytes"]
    ):
        raise BrokerError("bundle pack is not a bounded regular Hermes-owned file")
    copied_pack = work_dir / "input.pack"
    source_fd = os.open(pack_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        destination_fd = os.open(
            copied_pack,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
            0o400,
        )
        try:
            hasher = hashlib.sha256()
            copied = 0
            while True:
                chunk = os.read(source_fd, 1024 * 1024)
                if not chunk:
                    break
                copied += len(chunk)
                if copied > MAX_PACK_BYTES:
                    raise BrokerError("bundle pack exceeds the byte ceiling")
                hasher.update(chunk)
                os.write(destination_fd, chunk)
            os.fsync(destination_fd)
        finally:
            os.close(destination_fd)
    finally:
        os.close(source_fd)
    if copied != manifest["packBytes"] or f"sha256:{hasher.hexdigest()}" != manifest["packSha256"]:
        raise BrokerError("bundle pack digest or byte length changed during import")
    return manifest, copied_pack


def compare_work_facts(authorization: dict[str, Any], context: dict[str, Any]) -> None:
    exact_keys(
        context,
        {
            "schemaVersion",
            "heartbeatRunId",
            "runStatus",
            "companyId",
            "agentId",
            "issueId",
            "issueStatus",
            "projectId",
            "projectWorkspaceId",
            "repositoryFullName",
            "configuredDefaultBranch",
            "configuredRepositoryRef",
        },
        "Paperclip mutation context",
    )
    expected = {
        "heartbeatRunId": authorization["paperclipRunId"],
        "companyId": authorization["companyId"],
        "agentId": authorization["agentId"],
        "issueId": authorization["issueId"],
        "projectId": authorization["projectId"],
        "projectWorkspaceId": authorization["projectWorkspaceId"],
        "repositoryFullName": authorization["repositoryFullName"],
        "configuredDefaultBranch": authorization["defaultBranch"],
    }
    if (
        context["schemaVersion"] != "gloops.repository-mutation-context.v1"
        or context["runStatus"] not in {"queued", "running"}
        or context["issueStatus"] != "in_progress"
        or any(context.get(key) != value for key, value in expected.items())
    ):
        raise BrokerError("Paperclip work facts conflict with the root authorization")


def prepared_receipt(
    authorization: dict[str, Any],
    authorization_digest: str,
    lease: dict[str, Any],
    lease_digest: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": "gloops.repository-mutation-receipt.v1",
        "companyId": authorization["companyId"],
        "agentId": authorization["agentId"],
        "heartbeatRunId": authorization["paperclipRunId"],
        "issueId": authorization["issueId"],
        "projectId": authorization["projectId"],
        "projectWorkspaceId": authorization["projectWorkspaceId"],
        "repositoryId": str(authorization["repositoryId"]),
        "repositoryFullName": authorization["repositoryFullName"],
        "defaultBranch": authorization["defaultBranch"],
        "branchRef": authorization["branchRef"],
        "mutationClass": authorization["mutationClass"],
        "rootAuthorizationDigest": authorization_digest,
        "leaseDigest": lease_digest,
        "nonce": lease["nonce"],
        "expectedOldOid": lease["expectedOldOid"],
        "expectedNewOid": lease["expectedNewOid"],
        "state": "prepared",
        "preparedAt": lease["attestedAt"],
    }


def create_lease(
    connection: sqlite3.Connection,
    authorization: dict[str, Any],
    authorization_digest: str,
    expected_new_oid: str,
) -> tuple[dict[str, Any], str, dict[str, Any]]:
    nonce = secrets.token_hex(32)
    lease = {
        "schemaVersion": "gloops.github-push-lease.v1",
        "paperclipRunId": authorization["paperclipRunId"],
        "issueId": authorization["issueId"],
        "agentId": authorization["agentId"],
        "companyId": authorization["companyId"],
        "projectId": authorization["projectId"],
        "projectWorkspaceId": authorization["projectWorkspaceId"],
        "repositoryId": authorization["repositoryId"],
        "repositoryFullName": authorization["repositoryFullName"],
        "defaultBranch": authorization["defaultBranch"],
        "branchRef": authorization["branchRef"],
        "requiredBranchPrefix": f"refs/heads/paperclip/{authorization['paperclipRunId']}/",
        "expectedOldOid": authorization["expectedOldOid"],
        "expectedNewOid": expected_new_oid,
        "expiry": authorization["deadline"],
        "mutationClass": authorization["mutationClass"],
        "nonce": nonce,
        "attestedAt": timestamp(),
        "rootAuthorizationDigest": authorization_digest,
    }
    lease_digest = digest("gloops.github-push-lease.v1", lease)
    receipt = prepared_receipt(authorization, authorization_digest, lease, lease_digest)
    now = timestamp()
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            INSERT INTO allocations
              (authorization_digest, heartbeat_run_id, repository_id, mutation_class, branch_ref, nonce, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                authorization_digest,
                authorization["paperclipRunId"],
                str(authorization["repositoryId"]),
                authorization["mutationClass"],
                authorization["branchRef"],
                nonce,
                now,
            ),
        )
        connection.execute(
            """
            INSERT INTO leases
              (nonce, authorization_json, authorization_digest, lease_json, lease_digest, state,
               prepared_receipt_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?)
            """,
            (
                nonce,
                canonical_json(authorization),
                authorization_digest,
                canonical_json(lease),
                lease_digest,
                canonical_json(receipt),
                now,
                now,
            ),
        )
        append_journal(connection, nonce, "prepared", {
            "authorizationDigest": authorization_digest,
            "leaseDigest": lease_digest,
            "expectedOldOid": lease["expectedOldOid"],
            "expectedNewOid": expected_new_oid,
            "branchRef": authorization["branchRef"],
        })
        connection.commit()
        fsync_database()
    except sqlite3.IntegrityError as error:
        connection.rollback()
        raise BrokerError("the one-run repository mutation allocation is already consumed") from error
    except BaseException:
        connection.rollback()
        raise
    return lease, lease_digest, receipt


def transition(
    connection: sqlite3.Connection,
    nonce: str,
    expected_state: str,
    next_state: str,
    payload: dict[str, Any],
    **fields: str | int | None,
) -> None:
    assignments = ["state = ?", "updated_at = ?"]
    values: list[Any] = [next_state, timestamp()]
    for key, value in fields.items():
        if key not in {
            "prepared_posted",
            "terminal_receipt_json",
            "terminal_posted",
            "token_path",
            "mint_started_at",
            "mint_safe_after",
            "token_expires_at",
            "remote_old_oid",
            "remote_new_oid",
        }:
            raise BrokerError("invalid lease transition field")
        assignments.append(f"{key} = ?")
        values.append(value)
    values.extend([nonce, expected_state])
    connection.execute("BEGIN IMMEDIATE")
    cursor = connection.execute(
        f"UPDATE leases SET {', '.join(assignments)} WHERE nonce = ? AND state = ?",
        values,
    )
    if cursor.rowcount != 1:
        connection.rollback()
        raise BrokerError(f"lease state changed before {expected_state} -> {next_state}")
    append_journal(connection, nonce, next_state, payload)
    connection.commit()
    fsync_database()


def mark_posted(connection: sqlite3.Connection, nonce: str, column: str) -> None:
    if column not in {"prepared_posted", "terminal_posted"}:
        raise BrokerError("invalid Paperclip projection column")
    connection.execute("BEGIN IMMEDIATE")
    connection.execute(f"UPDATE leases SET {column} = 1, updated_at = ? WHERE nonce = ?", (timestamp(), nonce))
    connection.commit()
    fsync_database()


def record_mint_intent(connection: sqlite3.Connection, nonce: str) -> None:
    started = datetime.now(timezone.utc)
    safe_after = started + timedelta(minutes=65)
    connection.execute("BEGIN IMMEDIATE")
    cursor = connection.execute(
        """
        UPDATE leases
        SET mint_started_at = ?, mint_safe_after = ?, updated_at = ?
        WHERE nonce = ? AND state = 'prepared' AND mint_started_at IS NULL
        """,
        (
            started.isoformat().replace("+00:00", "Z"),
            safe_after.isoformat().replace("+00:00", "Z"),
            timestamp(),
            nonce,
        ),
    )
    if cursor.rowcount != 1:
        connection.rollback()
        raise BrokerError("GitHub App token mint intent is already consumed")
    append_journal(
        connection,
        nonce,
        "prepared",
        {
            "event": "token_mint_intent",
            "safeAfter": safe_after.isoformat().replace("+00:00", "Z"),
        },
    )
    connection.commit()
    fsync_database()


def post_prepared(connection: sqlite3.Connection, nonce: str, receipt: dict[str, Any]) -> None:
    paperclip_request(
        "POST",
        f"/heartbeat-runs/{receipt['heartbeatRunId']}/repository-mutation-receipts/prepared",
        receipt,
    )
    mark_posted(connection, nonce, "prepared_posted")


def verify_github_repository(module: Any, config: dict[str, Any], token: str, authorization: dict[str, Any]) -> None:
    repository = module.request_json("GET", f"/repositories/{authorization['repositoryId']}", token)
    if (
        not isinstance(repository, dict)
        or repository.get("id") != authorization["repositoryId"]
        or repository.get("full_name") != authorization["repositoryFullName"]
        or repository.get("default_branch") != authorization["defaultBranch"]
        or config["repositoryId"] != authorization["repositoryId"]
        or config["repository"] != authorization["repositoryFullName"]
    ):
        raise BrokerError("GitHub repository metadata conflicts with the root authorization")


def read_remote_ref(module: Any, token: str, authorization: dict[str, Any]) -> str:
    suffix = authorization["branchRef"].removeprefix("refs/")
    path = f"/repos/{authorization['repositoryFullName']}/git/ref/{urllib.parse.quote(suffix, safe='/')}"
    try:
        response = module.request_json("GET", path, token)
    except module.GitHubAPIError as error:
        if error.status == 404:
            return ZERO_OID
        raise
    if not isinstance(response, dict):
        raise BrokerError("GitHub ref response is malformed")
    oid = ((response.get("object") or {}).get("sha") if isinstance(response.get("object"), dict) else None)
    if not isinstance(oid, str) or not OID_PATTERN.fullmatch(oid):
        raise BrokerError("GitHub ref response does not contain an exact object id")
    return oid


def sealed_token_fd(token: str) -> int:
    fd = os.memfd_create("github-push-token", os.MFD_ALLOW_SEALING)
    os.write(fd, f"{token}\n".encode())
    os.lseek(fd, 0, os.SEEK_SET)
    fcntl.fcntl(
        fd,
        fcntl.F_ADD_SEALS,
        fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE,
    )
    return fd


def run_worker(nonce: str, request_path: Path, gitdir: Path, token: str) -> None:
    token_fd = sealed_token_fd(token)
    unit = f"paperclip-github-push-worker-{nonce[:16]}"
    command = [
        "/usr/bin/systemd-run",
        "--quiet",
        "--wait",
        "--pipe",
        "--collect",
        f"--unit={unit}",
        "--property=User=paperclip-git-worker",
        "--property=Group=paperclip-git-worker",
        "--property=NoNewPrivileges=yes",
        "--property=PrivateTmp=yes",
        "--property=PrivateDevices=yes",
        "--property=ProtectSystem=strict",
        "--property=ProtectHome=yes",
        "--property=ProtectKernelTunables=yes",
        "--property=ProtectKernelModules=yes",
        "--property=ProtectControlGroups=yes",
        "--property=RestrictSUIDSGID=yes",
        "--property=LockPersonality=yes",
        "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
        "--property=CapabilityBoundingSet=",
        "--property=AmbientCapabilities=",
        "--property=MemoryMax=512M",
        "--property=TasksMax=64",
        "--property=RuntimeMaxSec=180",
        f"--property=ReadWritePaths={gitdir}",
        f"--property=LoadCredential=github-token:/proc/{os.getpid()}/fd/{token_fd}",
        "/usr/bin/node",
        str(TOOL),
        "worker",
        "--request",
        str(request_path),
    ]
    try:
        completed = subprocess.run(command, text=True, capture_output=True, timeout=210)
    finally:
        os.close(token_fd)
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "worker failed"
        raise BrokerError(f"isolated Git protocol worker failed: {detail[:500]}")
    try:
        output = json.loads(completed.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as error:
        raise BrokerError("isolated Git protocol worker returned malformed evidence") from error
    if output != {"ok": True, "expectedNewOid": json.loads(request_path.read_text())["expectedNewOid"]}:
        raise BrokerError("isolated Git protocol worker returned conflicting evidence")


def terminal_receipt(
    prepared: dict[str, Any],
    state_value: str,
    remote_old_oid: str,
    remote_new_oid: str,
) -> dict[str, Any]:
    projection = {
        **{key: value for key, value in prepared.items() if key != "state"},
        "state": state_value,
        "remoteOldOid": remote_old_oid,
        "remoteNewOid": remote_new_oid,
        "terminalAt": timestamp(),
    }
    return {
        **projection,
        "brokerReceiptDigest": digest("gloops.github-push-terminal-receipt.v1", projection),
    }


def finalize(
    connection: sqlite3.Connection,
    nonce: str,
    expected_state: str,
    receipt: dict[str, Any],
) -> None:
    transition(
        connection,
        nonce,
        expected_state,
        receipt["state"],
        {
            "brokerReceiptDigest": receipt["brokerReceiptDigest"],
            "remoteOldOid": receipt["remoteOldOid"],
            "remoteNewOid": receipt["remoteNewOid"],
        },
        terminal_receipt_json=canonical_json(receipt),
        remote_old_oid=receipt["remoteOldOid"],
        remote_new_oid=receipt["remoteNewOid"],
    )
    paperclip_request(
        "POST",
        f"/heartbeat-runs/{receipt['heartbeatRunId']}/repository-mutation-receipts/terminal",
        receipt,
    )
    mark_posted(connection, nonce, "terminal_posted")


def process_request(connection: sqlite3.Connection, request: dict[str, Any]) -> dict[str, Any]:
    authorization, authorization_digest = load_authorization()
    if (
        request["heartbeatRunId"] != authorization["paperclipRunId"]
        or request["expectedNewOid"] == authorization["expectedOldOid"]
    ):
        raise BrokerError("client request conflicts with the root authorization")
    app_config = json.loads(read_root_secret(APP_CONFIG, "GitHub App configuration"))
    if (
        app_config.get("repositoryId") != authorization["repositoryId"]
        or app_config.get("repository") != authorization["repositoryFullName"]
    ):
        raise BrokerError("root authorization disagrees with the GitHub App repository boundary")
    context = paperclip_request(
        "GET",
        f"/heartbeat-runs/{authorization['paperclipRunId']}/repository-mutation-context",
    )
    compare_work_facts(authorization, context)

    work_dir = STATE_DIR / "work" / secrets.token_hex(24)
    work_dir.mkdir(parents=True, mode=0o711)
    try:
        manifest, pack_path = read_bundle(request, work_dir)
        lease, lease_digest, prepared = create_lease(
            connection,
            authorization,
            authorization_digest,
            manifest["expectedNewOid"],
        )
        post_prepared(connection, lease["nonce"], prepared)

        module = load_app_module()
        config = module.load_config()
        record_mint_intent(connection, lease["nonce"])
        token, expires_at, _permissions = module.mint(config, {"contents": "write"})
        token_path = STATE_DIR / "tokens" / lease["nonce"]
        durable_write(token_path, f"{token}\n", 0o600)
        transition(
            connection,
            lease["nonce"],
            "prepared",
            "token_minted",
            {"tokenFingerprint": hashlib.sha256(token.encode()).hexdigest()},
            token_path=str(token_path),
            token_expires_at=expires_at,
        )
        try:
            verify_github_repository(module, config, token, authorization)
            remote_before = read_remote_ref(module, token, authorization)
            if remote_before != lease["expectedOldOid"]:
                raise BrokerError("target branch is not absent at the mutation boundary")
            worker_root = work_dir / "worker"
            gitdir = worker_root / "repo.git"
            worker_root.mkdir(mode=0o711)
            gitdir.mkdir(mode=0o700)
            os.chown(worker_root, WORKER_UID, WORKER_GID)
            os.chown(gitdir, WORKER_UID, WORKER_GID)
            worker_request = {
                "schemaVersion": "gloops.github-push-worker-request.v1",
                "repositoryFullName": authorization["repositoryFullName"],
                "defaultBranch": authorization["defaultBranch"],
                "remoteRef": authorization["branchRef"],
                "expectedOldOid": lease["expectedOldOid"],
                "expectedNewOid": lease["expectedNewOid"],
                "objectOids": manifest["objectOids"],
                "packPath": str(pack_path),
                "gitdir": str(gitdir),
            }
            request_path = work_dir / "worker-request.json"
            durable_write(request_path, f"{canonical_json(worker_request)}\n", 0o444)
            os.chown(pack_path, WORKER_UID, WORKER_GID)
            os.chmod(pack_path, 0o400)
            transition(
                connection,
                lease["nonce"],
                "token_minted",
                "in_flight",
                {
                    "branchRef": authorization["branchRef"],
                    "expectedOldOid": lease["expectedOldOid"],
                    "expectedNewOid": lease["expectedNewOid"],
                },
            )
            worker_error: BrokerError | None = None
            try:
                run_worker(lease["nonce"], request_path, gitdir, token)
            except BrokerError as error:
                worker_error = error
            transition(
                connection,
                lease["nonce"],
                "in_flight",
                "reconciling",
                {"reason": "worker_returned" if worker_error is None else "worker_result_uncertain"},
            )
            remote_after = read_remote_ref(module, token, authorization)
            if remote_after == lease["expectedNewOid"]:
                state_value = "reconciled_success"
            elif remote_after == lease["expectedOldOid"]:
                state_value = "bounded_failure"
            else:
                state_value = "conflict"
            receipt = terminal_receipt(prepared, state_value, remote_before, remote_after)
            finalize(connection, lease["nonce"], "reconciling", receipt)
            if state_value != "reconciled_success":
                raise worker_error or BrokerError(f"repository mutation ended as {state_value}")
            return {
                "ok": True,
                "schemaVersion": "gloops.github-push-client-response.v1",
                "heartbeatRunId": lease["paperclipRunId"],
                "branchRef": lease["branchRef"],
                "remoteNewOid": remote_after,
                "brokerReceiptDigest": receipt["brokerReceiptDigest"],
            }
        finally:
            try:
                module.revoke_value(token)
            finally:
                durable_unlink(token_path)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def reconcile_pending(connection: sqlite3.Connection) -> None:
    verify_journal(connection)
    module = load_app_module()
    for row in connection.execute(
        "SELECT * FROM leases WHERE state IN ('prepared', 'token_minted', 'in_flight', 'reconciling')"
    ).fetchall():
        authorization = json.loads(row["authorization_json"])
        prepared = json.loads(row["prepared_receipt_json"])
        if not row["prepared_posted"]:
            try:
                post_prepared(connection, row["nonce"], prepared)
            except BrokerError:
                continue
        if row["state"] == "prepared":
            deterministic_token_path = STATE_DIR / "tokens" / row["nonce"]
            if deterministic_token_path.exists():
                token = deterministic_token_path.read_text().strip()
                try:
                    module.revoke_value(token)
                finally:
                    durable_unlink(deterministic_token_path)
            elif (
                row["mint_safe_after"]
                and parse_timestamp(row["mint_safe_after"]) > datetime.now(timezone.utc)
            ):
                continue
            receipt = terminal_receipt(prepared, "bounded_failure", ZERO_OID, ZERO_OID)
            finalize(connection, row["nonce"], "prepared", receipt)
            continue
        token_path = Path(row["token_path"]) if row["token_path"] else None
        token = token_path.read_text().strip() if token_path and token_path.exists() else None
        if row["state"] == "token_minted":
            if token:
                try:
                    module.revoke_value(token)
                finally:
                    durable_unlink(token_path)
            receipt = terminal_receipt(prepared, "bounded_failure", ZERO_OID, ZERO_OID)
            finalize(connection, row["nonce"], "token_minted", receipt)
            continue
        reconciliation_token = token
        minted_for_reconciliation = False
        if not reconciliation_token:
            config = module.load_config()
            reconciliation_token, _expires, _permissions = module.mint(config, {"contents": "write"})
            minted_for_reconciliation = True
        try:
            if row["state"] == "in_flight":
                transition(
                    connection,
                    row["nonce"],
                    "in_flight",
                    "reconciling",
                    {"reason": "broker_restart_after_in_flight"},
                )
            remote = read_remote_ref(module, reconciliation_token, authorization)
            expected_new = json.loads(row["lease_json"])["expectedNewOid"]
            state_value = (
                "reconciled_success"
                if remote == expected_new
                else "bounded_failure"
                if remote == ZERO_OID
                else "conflict"
            )
            receipt = terminal_receipt(prepared, state_value, ZERO_OID, remote)
            finalize(connection, row["nonce"], "reconciling", receipt)
        finally:
            if token or minted_for_reconciliation:
                try:
                    module.revoke_value(reconciliation_token)
                finally:
                    if token_path:
                        durable_unlink(token_path)

    for row in connection.execute(
        "SELECT * FROM leases WHERE terminal_receipt_json IS NOT NULL AND terminal_posted = 0"
    ).fetchall():
        receipt = json.loads(row["terminal_receipt_json"])
        try:
            paperclip_request(
                "POST",
                f"/heartbeat-runs/{receipt['heartbeatRunId']}/repository-mutation-receipts/terminal",
                receipt,
            )
            mark_posted(connection, row["nonce"], "terminal_posted")
        except BrokerError:
            continue


def reconciliation_delay(connection: sqlite3.Connection) -> float | None:
    pending_projection = connection.execute(
        """
        SELECT 1 FROM leases
        WHERE prepared_posted = 0
           OR (terminal_receipt_json IS NOT NULL AND terminal_posted = 0)
        LIMIT 1
        """
    ).fetchone()
    if pending_projection:
        return 15.0
    safe_after_rows = connection.execute(
        """
        SELECT mint_safe_after FROM leases
        WHERE state = 'prepared' AND mint_safe_after IS NOT NULL
        """
    ).fetchall()
    if not safe_after_rows:
        return None
    now = datetime.now(timezone.utc)
    return max(
        0.1,
        min(
            (parse_timestamp(row["mint_safe_after"]) - now).total_seconds()
            for row in safe_after_rows
        ),
    )


def completed_response(
    connection: sqlite3.Connection,
    request: dict[str, Any],
) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT lease_json, terminal_receipt_json, terminal_posted
        FROM leases
        WHERE json_extract(lease_json, '$.paperclipRunId') = ?
          AND json_extract(lease_json, '$.expectedNewOid') = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (request["heartbeatRunId"], request["expectedNewOid"]),
    ).fetchone()
    if not row or not row["terminal_receipt_json"] or not row["terminal_posted"]:
        return None
    lease = json.loads(row["lease_json"])
    receipt = json.loads(row["terminal_receipt_json"])
    if receipt["state"] != "reconciled_success":
        return {
            "ok": False,
            "schemaVersion": "gloops.github-push-client-response.v1",
            "error": f"repository mutation ended as {receipt['state']}",
        }
    return {
        "ok": True,
        "schemaVersion": "gloops.github-push-client-response.v1",
        "heartbeatRunId": lease["paperclipRunId"],
        "branchRef": lease["branchRef"],
        "remoteNewOid": receipt["remoteNewOid"],
        "brokerReceiptDigest": receipt["brokerReceiptDigest"],
    }


def handle_connection(connection: sqlite3.Connection, client: socket.socket) -> None:
    response: dict[str, Any]
    request: dict[str, Any] | None = None
    try:
        verify_peer(client)
        request = read_request(client)
        response = process_request(connection, request)
    except Exception as error:
        for attempt in range(3):
            try:
                reconcile_pending(connection)
                if request:
                    response = completed_response(connection, request)
                    if response:
                        break
            except Exception:
                pass
            time.sleep(0.25 * (attempt + 1))
        else:
            response = {
                "ok": False,
                "schemaVersion": "gloops.github-push-client-response.v1",
                "error": str(error)[:1000],
            }
    client.sendall((canonical_json(response) + "\n").encode())


def serve() -> None:
    if os.geteuid() != 0 and not TEST_MODE:
        raise BrokerError("run as root")
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True, mode=0o755)
    INGRESS_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not TEST_MODE:
        os.chown(INGRESS_DIR, EXPECTED_HERMES_UID, 10_000)
        os.chmod(INGRESS_DIR, 0o700)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    connection = connect_database()
    verify_journal(connection)
    reconcile_pending(connection)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(SOCKET_PATH))
    os.chown(SOCKET_PATH, 0, 10_000)
    os.chmod(SOCKET_PATH, 0o660)
    listener.listen(4)
    try:
        while True:
            listener.settimeout(reconciliation_delay(connection))
            try:
                client, _address = listener.accept()
            except socket.timeout:
                reconcile_pending(connection)
                continue
            with client:
                handle_connection(connection, client)
            reconcile_pending(connection)
    finally:
        listener.close()
        connection.close()
        try:
            SOCKET_PATH.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"serve", "reconcile", "verify-journal"}:
        raise BrokerError("usage: github-push-broker.py serve|reconcile|verify-journal")
    connection = connect_database()
    lock_fd = os.open(COMMAND_LOCK, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        os.fchmod(lock_fd, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        if sys.argv[1] == "serve":
            connection.close()
            serve()
        elif sys.argv[1] == "reconcile":
            reconcile_pending(connection)
        else:
            verify_journal(connection)
    finally:
        try:
            connection.close()
        except sqlite3.ProgrammingError:
            pass
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BrokerError, OSError, sqlite3.Error, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"github-push-broker: {error}", file=sys.stderr)
        raise SystemExit(1)
