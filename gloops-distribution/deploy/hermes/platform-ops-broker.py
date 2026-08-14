#!/usr/bin/env python3
"""Root-owned platform operations broker.

Serves bounded, governed host operations over a peer-authenticated Unix
socket.  The broker enforces a focused allowlist of exact services, cache
paths, and image identifiers.  No generic shell, SSH, sudo, path, service,
or image-tag inputs are accepted.  Every mutating action writes a durable,
idempotent receipt to SQLite with a hash-chained journal.

Request schema (single JSON object, one per connection)::

    {"operation": "<op>", ...}

Response schema::

    {"ok": true,  "data": <bounded json>}
    {"ok": false, "error": "<message>"}

No credential, token, header, or secret is ever placed in a response.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shlex
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CONFIG_DIR = Path(os.environ.get("GLOOPS_PLATFORM_OPS_BROKER_CONFIG_DIR", "/etc/paperclip-gloops"))
RUNTIME_DIR = Path(os.environ.get("GLOOPS_PLATFORM_OPS_BROKER_RUNTIME_DIR", "/run/paperclip-platform-ops-broker"))
SOCKET_PATH = RUNTIME_DIR / "broker.sock"
STATE_DIR = Path(os.environ.get("GLOOPS_PLATFORM_OPS_BROKER_STATE_DIR", "/var/lib/paperclip-gloops/platform-ops-broker"))
COMMAND_LOCK = Path(os.environ.get("GLOOPS_PLATFORM_OPS_BROKER_LOCK", str(STATE_DIR / "command.lock")))
ALLOWLIST_PATH = CONFIG_DIR / "platform-ops-allowlist.json"
DATABASE = STATE_DIR / "broker.sqlite3"
ROLLBACK_SCRIPT = Path(os.environ.get("GLOOPS_PLATFORM_OPS_BROKER_ROLLBACK_SCRIPT", "/usr/local/lib/paperclip-gloops/rollback.sh"))
BACKUP_DIR = Path(os.environ.get("GLOOPS_PLATFORM_OPS_BROKER_BACKUP_DIR", "/opt/paperclip/backups"))

MAX_REQUEST_BYTES = 16 * 1024
MAX_RESPONSE_BYTES = 128 * 1024
COMMAND_TIMEOUT_SECONDS = 120
HEALTH_TIMEOUT_SECONDS = 15
EXPECTED_HERMES_UID = 10_000
HERMES_GID = 10_000
SO_PEERCRED = getattr(socket, "SO_PEERCRED", 17)
TEST_MODE = os.environ.get("GLOOPS_PLATFORM_OPS_BROKER_TEST_MODE") == "1"
GITHUB_API_BASE = os.environ.get("GLOOPS_PLATFORM_OPS_GITHUB_API_BASE", "https://api.github.com").rstrip("/")
DEPLOY_REPOSITORY = "gloopsAI/paperclip"
DEPLOY_BASE_REF = "gloops/stable"

# Image digest pattern: sha256:64hex or a named registry path ending in @sha256:64hex
IMAGE_DIGEST_PATTERN = re.compile(
    r"^(?:[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)?@sha256:[0-9a-f]{64}$"
)
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
SOURCE_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")

# Service name pattern: word characters, hyphens, dots, ending in .service
SERVICE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]+\.service$")

# Receipt ID pattern: hex or UUID
RECEIPT_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

# Fields stripped from every response
CREDENTIAL_KEYS = frozenset({
    "token", "access_token", "refresh_token", "authorization",
    "auth_header", "credentials", "secret", "private_key",
    "password", "otp_secret", "signed_jwt", "api_key",
    "API_SERVER_KEY",
})

ALLOWED_OPERATIONS = frozenset({
    "service-status",
    "service-health",
    "front-door-health",
    "service-restart",
    "disk-usage",
    "memory-usage",
    "cpu-usage",
    "cache-inspect",
    "cache-reclaim",
    "deploy-pinned-image",
    "rollback-rehearsal",
    "rollback-proof",
    "list-receipts",
    "get-receipt",
})

# Operations that mutate state and require idempotent receipts
MUTATING_OPERATIONS = frozenset({
    "service-restart",
    "cache-reclaim",
    "deploy-pinned-image",
    "rollback-rehearsal",
    "rollback-proof",
})

# Operations that are read-only
READONLY_OPERATIONS = ALLOWED_OPERATIONS - MUTATING_OPERATIONS


class BrokerError(RuntimeError):
    pass


class ReceiptedOperationError(BrokerError):
    """A terminal operation failure whose receipt transaction must commit."""


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(domain: str, value: Any) -> str:
    payload = domain.encode() + b"\0" + canonical_json(value).encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def ensure_dirs() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True, mode=0o755)
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    COMMAND_LOCK.parent.mkdir(parents=True, exist_ok=True, mode=0o700)


def strip_credentials(value: Any) -> Any:
    """Recursively remove any key that looks like a credential."""
    if isinstance(value, dict):
        return {
            k: strip_credentials(v)
            for k, v in value.items()
            if k not in CREDENTIAL_KEYS
        }
    if isinstance(value, list):
        return [strip_credentials(v) for v in value]
    return value


def bound_output(data: Any, max_bytes: int = MAX_RESPONSE_BYTES) -> bytes:
    """Serialise to valid, bounded JSON without ever slicing encoded JSON."""
    raw = json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(raw) <= max_bytes:
        return raw
    if isinstance(data, dict) and "data" in data and isinstance(data["data"], list):
        data = dict(data)
        items = data["data"]
        lo, hi = 0, len(items)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            candidate = dict(data)
            candidate["data"] = items[:mid]
            candidate["truncated"] = True
            candidate["totalReturned"] = mid
            candidate["totalAvailable"] = len(items)
            raw = json.dumps(candidate, sort_keys=True, separators=(",", ":")).encode("utf-8")
            if len(raw) <= max_bytes:
                lo = mid
            else:
                hi = mid - 1
        raw = json.dumps(
            {**data, "data": items[:lo], "truncated": True,
             "totalReturned": lo, "totalAvailable": len(items)},
            sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")
        if len(raw) <= max_bytes:
            return raw
    return json.dumps(
        {"ok": False, "error": "response exceeds the bounded-response ceiling",
         "truncated": True},
        sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")


# ---------------------------------------------------------------------------
# Allowlist loading and validation
# ---------------------------------------------------------------------------

_allowlist_cache: dict[str, Any] | None = None


def load_allowlist() -> dict[str, Any]:
    global _allowlist_cache
    if _allowlist_cache is not None:
        return _allowlist_cache
    if not ALLOWLIST_PATH.exists():
        raise BrokerError("platform-ops allowlist is not installed")
    try:
        allowlist = json.loads(ALLOWLIST_PATH.read_text())
    except (json.JSONDecodeError, OSError) as error:
        raise BrokerError(f"allowlist is malformed: {error}") from error
    if not isinstance(allowlist, dict):
        raise BrokerError("allowlist must be a JSON object")
    for key in ("allowedServices", "allowedCachePaths"):
        if key not in allowlist:
            raise BrokerError(f"allowlist missing required key: {key}")
        if not isinstance(allowlist[key], dict):
            raise BrokerError(f"allowlist.{key} must be a JSON object")
    _allowlist_cache = allowlist
    return allowlist


def allowed_service_names() -> frozenset[str]:
    return frozenset(load_allowlist().get("allowedServices", {}).keys())


def allowed_cache_paths() -> dict[str, str]:
    return dict(load_allowlist().get("allowedCachePaths", {}))


def cache_threshold_percent() -> int:
    return int(load_allowlist().get("cacheThresholdPercent", 85))


# ---------------------------------------------------------------------------
# Command execution
# ---------------------------------------------------------------------------

def run_command(args: list[str], timeout: int = COMMAND_TIMEOUT_SECONDS,
                env: dict[str, str] | None = None) -> tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr).  stdout/stderr are
    truncated to a bounded size."""
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired:
        raise BrokerError("command timed out")
    except FileNotFoundError:
        raise BrokerError("required command is not available")
    stdout = result.stdout.decode("utf-8", errors="replace")[:MAX_RESPONSE_BYTES // 2]
    stderr = result.stderr.decode("utf-8", errors="replace")[:500]
    return result.returncode, stdout, stderr


# ---------------------------------------------------------------------------
# Durable receipt state (SQLite + hash-chained journal)
# ---------------------------------------------------------------------------

def connect_database() -> sqlite3.Connection:
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS receipts (
          receipt_id TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          target TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          actor TEXT NOT NULL,
          command_class TEXT NOT NULL,
          action_digest TEXT,
          evidence_json TEXT NOT NULL,
          outcome TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS journal (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          receipt_id TEXT NOT NULL,
          state TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          previous_digest TEXT NOT NULL,
          entry_digest TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_receipts_operation ON receipts(operation);
        CREATE INDEX IF NOT EXISTS idx_receipts_state ON receipts(state);
        """
    )
    receipt_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(receipts)")
    }
    if "action_digest" not in receipt_columns:
        connection.execute("ALTER TABLE receipts ADD COLUMN action_digest TEXT")
    connection.commit()
    os.chmod(DATABASE, 0o600)
    return connection


def append_journal(
    connection: sqlite3.Connection,
    receipt_id: str,
    state_value: str,
    payload: dict[str, Any],
) -> str:
    previous = connection.execute(
        "SELECT entry_digest FROM journal ORDER BY sequence DESC LIMIT 1"
    ).fetchone()
    previous_digest = previous["entry_digest"] if previous else "sha256:" + "0" * 64
    created_at = timestamp()
    projection = {
        "receiptId": receipt_id,
        "state": state_value,
        "payload": payload,
        "previousDigest": previous_digest,
        "createdAt": created_at,
    }
    entry_digest = digest("gloops.platform-ops-journal.v1", projection)
    connection.execute(
        """
        INSERT INTO journal (receipt_id, state, payload_json, previous_digest, entry_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (receipt_id, state_value, canonical_json(payload), previous_digest, entry_digest, created_at),
    )
    return entry_digest


def verify_journal(connection: sqlite3.Connection) -> None:
    previous = "sha256:" + "0" * 64
    for row in connection.execute("SELECT * FROM journal ORDER BY sequence"):
        payload = json.loads(row["payload_json"])
        projection = {
            "receiptId": row["receipt_id"],
            "state": row["state"],
            "payload": payload,
            "previousDigest": previous,
            "createdAt": row["created_at"],
        }
        expected = digest("gloops.platform-ops-journal.v1", projection)
        if row["previous_digest"] != previous or row["entry_digest"] != expected:
            raise BrokerError("platform-ops journal hash chain is invalid")
        previous = expected


def create_receipt(
    connection: sqlite3.Connection,
    receipt_id: str,
    operation: str,
    target: str,
    idempotency_key: str,
    actor: str,
    command_class: str,
    action: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    """Durably reserve an idempotency key before any external host effect.

    The boolean result is true only for the request that created the durable
    reservation.  Every existing state, including ``initiated``, is a replay
    and must never authorize the caller to execute the host operation again.
    """
    action_digest = digest("gloops.platform-ops-action.v1", action)
    existing = connection.execute(
        "SELECT * FROM receipts WHERE idempotency_key = ?",
        (idempotency_key,),
    ).fetchone()
    if existing:
        if existing["action_digest"] is None:
            raise BrokerError(
                "idempotency key belongs to a legacy unbound receipt; manual reconciliation required"
            )
        if (
            existing["receipt_id"] != receipt_id
            or existing["action_digest"] != action_digest
        ):
            raise BrokerError("idempotency key is already consumed by a different action")
        return _to_receipt_dict(existing), False
    now = timestamp()
    receipt = {
        "receiptId": receipt_id,
        "operation": operation,
        "target": target,
        "idempotencyKey": idempotency_key,
        "state": "initiated",
        "actor": actor,
        "commandClass": command_class,
        "actionDigest": action_digest,
        "evidence": {},
        "outcome": "pending",
        "createdAt": now,
        "updatedAt": now,
    }
    inserted = connection.execute(
        """
        INSERT INTO receipts
          (receipt_id, operation, target, idempotency_key, state, actor,
           command_class, action_digest, evidence_json, outcome, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
        """,
        (receipt_id, operation, target, idempotency_key, "initiated",
         actor, command_class, action_digest, "{}", "pending", now, now),
    )
    if inserted.rowcount == 0:
        existing = connection.execute(
            "SELECT * FROM receipts WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        if existing is None:
            raise BrokerError("idempotency reservation conflict could not be resolved")
        if existing["action_digest"] is None:
            raise BrokerError(
                "idempotency key belongs to a legacy unbound receipt; manual reconciliation required"
            )
        if (
            existing["receipt_id"] != receipt_id
            or existing["action_digest"] != action_digest
        ):
            raise BrokerError("idempotency key is already consumed by a different action")
        return _to_receipt_dict(existing), False
    append_journal(connection, receipt_id, "initiated", {
        "operation": operation, "target": target, "actor": actor,
        "commandClass": command_class,
        "action": action,
        "actionDigest": action_digest,
    })
    # This is intentionally a separate durability boundary.  A broker crash or
    # unexpected exception after this point leaves an inspectable ``initiated``
    # reservation rather than allowing the same key to repeat a host effect.
    connection.commit()
    return receipt, True


def complete_receipt(
    connection: sqlite3.Connection,
    receipt_id: str,
    state: str,
    evidence: dict[str, Any],
    outcome: str,
) -> dict[str, Any]:
    now = timestamp()
    connection.execute(
        """
        UPDATE receipts
        SET state = ?, evidence_json = ?, outcome = ?, updated_at = ?
        WHERE receipt_id = ?
        """,
        (state, canonical_json(evidence), outcome, now, receipt_id),
    )
    append_journal(connection, receipt_id, state, {
        "evidence": evidence, "outcome": outcome,
    })
    row = connection.execute(
        "SELECT * FROM receipts WHERE receipt_id = ?", (receipt_id,)
    ).fetchone()
    return _to_receipt_dict(row)


def fail_receipted_operation(
    connection: sqlite3.Connection,
    receipt_id: str,
    evidence: dict[str, Any],
    message: str,
) -> NoReturn:
    """Record a terminal failure and signal the socket boundary to commit it."""
    complete_receipt(connection, receipt_id, "failed", evidence, "failure")
    raise ReceiptedOperationError(message)


def terminalize_receipted_operation(
    connection: sqlite3.Connection,
    receipt_id: str,
    state: str,
    evidence: dict[str, Any],
    outcome: str,
    message: str,
) -> NoReturn:
    """Commit an explicit non-success terminal state at the socket boundary."""
    complete_receipt(connection, receipt_id, state, evidence, outcome)
    raise ReceiptedOperationError(message)


def replay_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    """Return an existing reservation without re-running any host effect."""
    return {
        "receiptId": receipt["receiptId"],
        "state": receipt["state"],
        "outcome": receipt["outcome"],
        "replayed": True,
    }


def _to_receipt_dict(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["evidence"] = json.loads(result.pop("evidence_json", "{}"))
    result["receiptId"] = result.pop("receipt_id")
    result["idempotencyKey"] = result.pop("idempotency_key")
    result["commandClass"] = result.pop("command_class")
    result["actionDigest"] = result.pop("action_digest", None)
    result["createdAt"] = result.pop("created_at")
    result["updatedAt"] = result.pop("updated_at")
    return result


def get_receipt(connection: sqlite3.Connection, receipt_id: str) -> dict[str, Any] | None:
    row = connection.execute(
        "SELECT * FROM receipts WHERE receipt_id = ?", (receipt_id,)
    ).fetchone()
    if row is None:
        return None
    return _to_receipt_dict(row)


def list_receipts(connection: sqlite3.Connection, limit: int = 50) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT * FROM receipts ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return [_to_receipt_dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Operation handlers
# ---------------------------------------------------------------------------

def op_service_status(params: dict[str, Any]) -> Any:
    service = params.get("service")
    if not isinstance(service, str) or not SERVICE_NAME_PATTERN.match(service):
        raise BrokerError("service must be a valid systemd unit name ending in .service")
    if service not in allowed_service_names():
        raise BrokerError(f"service {service} is not in the allowlist")
    returncode, stdout, stderr = run_command(
        ["systemctl", "show", service, "--property=ActiveState,SubState,LoadState,Result"],
        timeout=HEALTH_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        raise BrokerError(f"systemctl show failed: {stderr}")
    properties = {}
    for line in stdout.strip().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            properties[key] = value
    return {
        "service": service,
        "activeState": properties.get("ActiveState", "unknown"),
        "subState": properties.get("SubState", "unknown"),
        "loadState": properties.get("LoadState", "unknown"),
        "result": properties.get("Result", "unknown"),
    }


def op_service_health(params: dict[str, Any]) -> Any:
    service = params.get("service")
    if not isinstance(service, str) or not SERVICE_NAME_PATTERN.match(service):
        raise BrokerError("service must be a valid systemd unit name ending in .service")
    if service not in allowed_service_names():
        raise BrokerError(f"service {service} is not in the allowlist")
    allowlist = load_allowlist()
    service_config = allowlist["allowedServices"].get(service)
    if service_config is None:
        raise BrokerError(f"service {service} is not in the allowlist")
    health_url = service_config.get("healthUrl")
    result = {"service": service, "healthy": False}
    # Check systemctl status first
    returncode, stdout, stderr = run_command(
        ["systemctl", "is-active", service], timeout=HEALTH_TIMEOUT_SECONDS,
    )
    is_active = returncode == 0 and stdout.strip() == "active"
    result["systemctlActive"] = is_active
    if health_url:
        # HTTP health check via curl
        returncode, stdout, stderr = run_command(
            ["curl", "-sf", "--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}", health_url],
            timeout=HEALTH_TIMEOUT_SECONDS,
        )
        http_code = stdout.strip() if returncode == 0 else "000"
        result["httpStatus"] = http_code
        result["healthy"] = is_active and http_code == "200"
    else:
        result["healthy"] = is_active
    return result


HTTP_PROBE_MARKER = "__PAPERCLIP_HTTP_PROBE__"


def _parse_curl_probe(stdout: str) -> tuple[str, int | None, str]:
    body, separator, metadata = stdout.rpartition("\n" + HTTP_PROBE_MARKER)
    if not separator:
        return stdout, None, ""
    status_text, _, content_type = metadata.partition("\t")
    try:
        status = int(status_text.strip())
    except ValueError:
        status = None
    return body, status, content_type.strip()


def _http_probe(
    *,
    name: str,
    url: str,
    expected_statuses: frozenset[int],
    content_type_prefix: str | None = None,
    expected_json_status: str | None = None,
    body_contains: str | None = None,
) -> dict[str, Any]:
    returncode, stdout, stderr = run_command(
        [
            "curl", "--silent", "--show-error", "--max-time", "10",
            "--output", "-", "--write-out",
            f"\n{HTTP_PROBE_MARKER}%{{http_code}}\t%{{content_type}}",
            url,
        ],
        timeout=HEALTH_TIMEOUT_SECONDS,
    )
    body, status, content_type = _parse_curl_probe(stdout)
    passed = returncode == 0 and status in expected_statuses
    if content_type_prefix is not None:
        passed = passed and content_type.lower().startswith(content_type_prefix.lower())
    if body_contains is not None:
        passed = passed and body_contains in body
    json_status = None
    if expected_json_status is not None:
        try:
            decoded = json.loads(body)
            json_status = decoded.get("status") if isinstance(decoded, dict) else None
        except json.JSONDecodeError:
            json_status = None
        passed = passed and json_status == expected_json_status
    return {
        "name": name,
        "url": url,
        "statusCode": status,
        "contentType": content_type,
        "jsonStatus": json_status,
        "transportSucceeded": returncode == 0,
        "passed": passed,
        "error": stderr.strip()[:500] if returncode != 0 else "",
    }


def _websocket_probe(url: str) -> dict[str, Any]:
    # This is intentionally credential-free.  A 101 proves a local-trusted
    # upgrade, while 401/403 proves that the public proxy forwarded the upgrade
    # to Paperclip's authenticated websocket boundary instead of serving a
    # generic HTTP page or a 404.  curl may hit its short deadline after a 101;
    # the received upgrade status remains valid evidence in that one case.
    returncode, stdout, stderr = run_command(
        [
            "curl", "--silent", "--show-error", "--max-time", "3",
            "--http1.1", "--output", "/dev/null", "--write-out",
            f"\n{HTTP_PROBE_MARKER}%{{http_code}}\t%{{content_type}}",
            "--header", "Connection: Upgrade",
            "--header", "Upgrade: websocket",
            "--header", "Sec-WebSocket-Version: 13",
            "--header", "Sec-WebSocket-Key: cGFwZXJjbGlwLWhlYWx0aA==",
            url,
        ],
        timeout=HEALTH_TIMEOUT_SECONDS,
    )
    _, status, content_type = _parse_curl_probe(stdout)
    passed = status in {101, 401, 403} and (returncode == 0 or (status == 101 and returncode == 28))
    return {
        "name": "websocket",
        "url": url,
        "statusCode": status,
        "contentType": content_type,
        "transportSucceeded": returncode == 0 or (status == 101 and returncode == 28),
        "passed": passed,
        "error": stderr.strip()[:500] if not passed else "",
    }


def _front_door_health(service: str) -> dict[str, Any]:
    service_config = load_allowlist()["allowedServices"].get(service)
    if service_config is None:
        raise BrokerError(f"service {service} is not in the allowlist")
    config = service_config.get("frontDoorHealth")
    if not isinstance(config, dict):
        raise BrokerError(f"service {service} has no front-door health profile")
    required = (
        "publicUrl", "publicBodyContains", "apiHealthUrl",
        "protectedUrl", "websocketUrl",
    )
    if any(not isinstance(config.get(key), str) or not config[key] for key in required):
        raise BrokerError(f"service {service} has an incomplete front-door health profile")

    active = _check_service_active(service)
    probes = [
        _http_probe(
            name="public-browser",
            url=config["publicUrl"],
            expected_statuses=frozenset({200}),
            content_type_prefix="text/html",
            body_contains=config["publicBodyContains"],
        ),
        _http_probe(
            name="api-health",
            url=config["apiHealthUrl"],
            expected_statuses=frozenset({200}),
            content_type_prefix="application/json",
            expected_json_status="ok",
        ),
        _http_probe(
            name="protected-api",
            url=config["protectedUrl"],
            expected_statuses=frozenset({401, 403}),
            content_type_prefix="application/json",
        ),
        _websocket_probe(config["websocketUrl"]),
    ]
    return {
        "service": service,
        "healthy": active["active"] and all(probe["passed"] for probe in probes),
        "systemctl": active,
        "probes": probes,
    }


def op_front_door_health(params: dict[str, Any]) -> Any:
    service = params.get("service")
    if not isinstance(service, str) or not SERVICE_NAME_PATTERN.match(service):
        raise BrokerError("service must be a valid systemd unit name ending in .service")
    if service not in allowed_service_names():
        raise BrokerError(f"service {service} is not in the allowlist")
    return _front_door_health(service)


def canonical_action(
    command_class: str,
    target: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    """Bind an idempotency reservation to the complete canonical request."""
    return {
        "schemaVersion": "gloops.platform-ops-action.v1",
        "commandClass": command_class,
        "target": target,
        "request": request,
    }


def derive_receipt_id(action: dict[str, Any]) -> str:
    """Return a deterministic receipt id from the full canonical action."""
    return hashlib.sha256(canonical_json(action).encode("utf-8")).hexdigest()[:32]


def op_service_restart(params: dict[str, Any], connection: sqlite3.Connection,
                       actor: str, idempotency_key: str) -> Any:
    service = params.get("service")
    if not isinstance(service, str) or not SERVICE_NAME_PATTERN.match(service):
        raise BrokerError("service must be a valid systemd unit name ending in .service")
    if service not in allowed_service_names():
        raise BrokerError(f"service {service} is not in the allowlist")
    action = canonical_action("restart_named_service", service, params)
    receipt_id = derive_receipt_id(action)
    receipt, reserved = create_receipt(
        connection, receipt_id, "service-restart", service,
        idempotency_key, actor, "restart_named_service", action,
    )
    if not reserved:
        return replay_receipt(receipt)
    # Pre-restart health
    pre_health = _check_service_active(service)
    # Execute restart
    returncode, stdout, stderr = run_command(
        ["systemctl", "restart", service], timeout=COMMAND_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        fail_receipted_operation(connection, receipt_id, {
            "preHealth": pre_health, "stderr": stderr,
        }, f"systemctl restart failed: {stderr}")
    # Wait for service to be active again
    time.sleep(2)
    post_health = _check_service_active(service)
    evidence = {
        "preHealth": pre_health,
        "postHealth": post_health,
        "service": service,
    }
    complete_receipt(connection, receipt_id, "completed", evidence, "success")
    return {"receiptId": receipt_id, "state": "completed", "evidence": evidence}


def _check_service_active(service: str) -> dict[str, Any]:
    returncode, stdout, stderr = run_command(
        ["systemctl", "is-active", service], timeout=HEALTH_TIMEOUT_SECONDS,
    )
    return {
        "active": returncode == 0 and stdout.strip() == "active",
        "state": stdout.strip() if returncode == 0 else "inactive",
    }


def op_disk_usage(params: dict[str, Any]) -> Any:
    path = params.get("path", "/")
    if not isinstance(path, str) or not path.startswith("/"):
        raise BrokerError("path must be an absolute path")
    # Prevent path traversal to arbitrary locations - only allow specific paths
    allowed_paths = {"/", "/opt", "/var", "/tmp", "/opt/paperclip"}
    if path not in allowed_paths:
        raise BrokerError(f"path {path} is not allowed for disk usage inspection")
    returncode, stdout, stderr = run_command(
        ["df", "-h", "--output=size,used,avail,pcent", path],
        timeout=HEALTH_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        raise BrokerError(f"df failed: {stderr}")
    lines = stdout.strip().splitlines()
    if len(lines) < 2:
        raise BrokerError("df output was unexpected")
    parts = lines[1].split()
    return {
        "path": path,
        "size": parts[0] if len(parts) > 0 else "unknown",
        "used": parts[1] if len(parts) > 1 else "unknown",
        "available": parts[2] if len(parts) > 2 else "unknown",
        "usePercent": parts[3] if len(parts) > 3 else "unknown",
    }


def op_memory_usage(params: dict[str, Any]) -> Any:
    returncode, stdout, stderr = run_command(
        ["free", "-m"], timeout=HEALTH_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        raise BrokerError(f"free failed: {stderr}")
    lines = stdout.strip().splitlines()
    result = {"raw": lines}
    if len(lines) >= 2:
        mem_parts = lines[1].split()
        if len(mem_parts) >= 7:
            result["totalMb"] = mem_parts[1]
            result["usedMb"] = mem_parts[2]
            result["availableMb"] = mem_parts[6]
    return result


def op_cpu_usage(params: dict[str, Any]) -> Any:
    returncode, stdout, stderr = run_command(
        ["uptime"], timeout=HEALTH_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        raise BrokerError(f"uptime failed: {stderr}")
    return {"uptime": stdout.strip()}


def op_cache_inspect(params: dict[str, Any]) -> Any:
    cache_name = params.get("cache")
    if not isinstance(cache_name, str):
        raise BrokerError("cache is required")
    cache_paths = allowed_cache_paths()
    if cache_name not in cache_paths:
        raise BrokerError(f"cache {cache_name} is not in the allowlist")
    cache_path = Path(cache_paths[cache_name])
    if not cache_path.exists():
        return {"cache": cache_name, "path": str(cache_path), "exists": False, "sizeBytes": 0}
    returncode, stdout, stderr = run_command(
        ["du", "-sb", str(cache_path)], timeout=HEALTH_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        raise BrokerError(f"du failed: {stderr}")
    size_bytes = int(stdout.strip().split()[0]) if stdout.strip() else 0
    return {
        "cache": cache_name,
        "path": str(cache_path),
        "exists": True,
        "sizeBytes": size_bytes,
    }


def op_cache_reclaim(params: dict[str, Any], connection: sqlite3.Connection,
                     actor: str, idempotency_key: str) -> Any:
    cache_name = params.get("cache")
    if not isinstance(cache_name, str):
        raise BrokerError("cache is required")
    cache_paths = allowed_cache_paths()
    if cache_name not in cache_paths:
        raise BrokerError(f"cache {cache_name} is not in the allowlist")
    cache_path = Path(cache_paths[cache_name])
    # Pre-reclaim size
    pre_size = 0
    if cache_path.exists():
        returncode, stdout, stderr = run_command(
            ["du", "-sb", str(cache_path)], timeout=HEALTH_TIMEOUT_SECONDS,
        )
        if returncode == 0 and stdout.strip():
            pre_size = int(stdout.strip().split()[0])
    action = canonical_action("reclaim_disposable_cache", cache_name, params)
    receipt_id = derive_receipt_id(action)
    receipt, reserved = create_receipt(
        connection, receipt_id, "cache-reclaim", cache_name,
        idempotency_key, actor, "reclaim_disposable_cache", action,
    )
    if not reserved:
        return replay_receipt(receipt)
    # Reclaim: remove contents but not the directory itself
    if cache_path.exists():
        returncode, stdout, stderr = run_command(
            ["find", str(cache_path), "-mindepth", "1", "-delete"],
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
        if returncode != 0:
            fail_receipted_operation(connection, receipt_id, {
                "preSizeBytes": pre_size, "stderr": stderr,
            }, f"cache reclaim failed: {stderr}")
    # Post-reclaim size
    post_size = 0
    if cache_path.exists():
        returncode, stdout, stderr = run_command(
            ["du", "-sb", str(cache_path)], timeout=HEALTH_TIMEOUT_SECONDS,
        )
        if returncode == 0 and stdout.strip():
            post_size = int(stdout.strip().split()[0])
    evidence = {
        "cache": cache_name,
        "preSizeBytes": pre_size,
        "postSizeBytes": post_size,
        "reclaimedBytes": pre_size - post_size,
    }
    complete_receipt(connection, receipt_id, "completed", evidence, "success")
    return {"receiptId": receipt_id, "state": "completed", "evidence": evidence}


def _deploy_checkpoint(_name: str) -> None:
    """Network-free failure-injection seam; production intentionally does nothing."""


def _bounded_failure(error: Exception) -> dict[str, str]:
    return {
        "name": type(error).__name__,
        "message": str(error)[:500] if isinstance(error, BrokerError) else "unexpected deployment exception",
    }


def _capture_pin_snapshot(path: Path) -> dict[str, Any]:
    """Read a pin from a no-follow descriptor and bind bytes plus metadata."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise BrokerError(f"unable to open deployment pin {path.name}: {type(error).__name__}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise BrokerError(f"deployment pin {path.name} is not a regular file")
        if metadata.st_size > MAX_REQUEST_BYTES:
            raise BrokerError(f"deployment pin {path.name} exceeds the bounded size")
        chunks: list[bytes] = []
        remaining = metadata.st_size
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                raise BrokerError(f"deployment pin {path.name} changed while being read")
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        final_metadata = os.fstat(descriptor)
        if (
            final_metadata.st_size != metadata.st_size
            or final_metadata.st_mtime_ns != metadata.st_mtime_ns
            or final_metadata.st_ctime_ns != metadata.st_ctime_ns
        ):
            raise BrokerError(f"deployment pin {path.name} changed while being read")
    finally:
        os.close(descriptor)
    current = os.lstat(path)
    if not stat.S_ISREG(current.st_mode) or current.st_size != metadata.st_size or (
        current.st_dev,
        current.st_ino,
    ) != (metadata.st_dev, metadata.st_ino):
        raise BrokerError(f"deployment pin {path.name} changed during capture")
    return {
        "path": path,
        "content": content,
        "device": metadata.st_dev,
        "inode": metadata.st_ino,
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
    }


def _pin_snapshot_evidence(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": snapshot["path"].name,
        "contentDigest": "sha256:" + hashlib.sha256(snapshot["content"]).hexdigest(),
        "size": len(snapshot["content"]),
        "device": snapshot["device"],
        "inode": snapshot["inode"],
        "uid": snapshot["uid"],
        "gid": snapshot["gid"],
        "mode": snapshot["mode"],
    }


def _pin_snapshot_matches(snapshot: dict[str, Any]) -> bool:
    try:
        current = _capture_pin_snapshot(snapshot["path"])
    except (BrokerError, OSError):
        return False
    return all(
        current[key] == snapshot[key]
        for key in ("content", "device", "inode", "uid", "gid", "mode")
    )


def _write_bound_pin(
    snapshot: dict[str, Any],
    content: bytes,
    *,
    expected_current: bytes | None = None,
) -> None:
    """Write the captured inode without truncating an unverified replacement."""
    path = snapshot["path"]
    flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        current = os.fstat(descriptor)
        if not stat.S_ISREG(current.st_mode) or (
            current.st_dev,
            current.st_ino,
        ) != (snapshot["device"], snapshot["inode"]) or (
            current.st_uid,
            current.st_gid,
            stat.S_IMODE(current.st_mode),
        ) != (snapshot["uid"], snapshot["gid"], snapshot["mode"]):
            raise BrokerError(f"deployment pin {path.name} identity changed before write")
        if expected_current is not None:
            if current.st_size != len(expected_current):
                raise BrokerError(f"deployment pin {path.name} content changed before write")
            observed = b""
            while len(observed) < current.st_size:
                chunk = os.read(descriptor, current.st_size - len(observed))
                if not chunk:
                    break
                observed += chunk
            if observed != expected_current:
                raise BrokerError(f"deployment pin {path.name} content changed before write")
        os.ftruncate(descriptor, 0)
        os.lseek(descriptor, 0, os.SEEK_SET)
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise BrokerError(f"deployment pin {path.name} write was incomplete")
            view = view[written:]
        if (current.st_uid, current.st_gid) != (snapshot["uid"], snapshot["gid"]):
            os.fchown(descriptor, snapshot["uid"], snapshot["gid"])
        os.fchmod(descriptor, snapshot["mode"])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    current = _capture_pin_snapshot(path)
    if any(
        current[key] != snapshot[key]
        for key in ("device", "inode", "uid", "gid", "mode")
    ) or current["content"] != content:
        raise BrokerError(f"deployment pin {path.name} write could not be proved")


def _release_identity(evidence: dict[str, Any]) -> str:
    projection = {
        key: evidence.get(key)
        for key in (
            "serviceState",
            "listeners",
            "containerArtifact",
            "expectedPriorImage",
            "imageBinding",
            "frontDoorHealth",
        )
    }
    return digest("gloops.prior-release-identity.v1", projection)


def _capture_prior_release_state(service: str, previous_image: str) -> dict[str, Any]:
    evidence = _rollback_terminal_evidence(service, "restored", previous_image)
    evidence["releaseIdentity"] = _release_identity(evidence)
    return evidence


def _compensate_deploy_failure(
    service: str,
    runtime_pin: dict[str, Any],
    approved_pin: dict[str, Any],
    previous_image: str,
    prior_release: dict[str, Any],
) -> dict[str, Any]:
    """Best-effort restore both pins, restart the prior service, and prove it."""
    restoration_errors: list[dict[str, str]] = []
    for label, snapshot in (
        ("runtimeEnv", runtime_pin),
        ("approvedImage", approved_pin),
    ):
        try:
            _write_bound_pin(snapshot, snapshot["content"])
        except Exception as error:
            restoration_errors.append({"operation": label, "errorName": type(error).__name__})

    configuration_restored = (
        _pin_snapshot_matches(runtime_pin)
        and _pin_snapshot_matches(approved_pin)
    )

    rollback_code: int | None = None
    rollback_stderr = ""
    rollback_restart_attempted = configuration_restored
    if configuration_restored:
        try:
            rollback_code, _, rollback_stderr = run_command(
                ["systemctl", "restart", service], timeout=COMMAND_TIMEOUT_SECONDS,
            )
        except Exception as error:
            restoration_errors.append({"operation": "restartPriorService", "errorName": type(error).__name__})
    else:
        restoration_errors.append({
            "operation": "restartPriorService",
            "errorName": "UnsafeWithoutExactConfiguration",
        })

    rollback_proof = _safe_rollback_terminal_evidence(
        service, previous_image, rollback_code,
    )
    prior_release_matches = (
        rollback_proof.get("proofComplete") is True
        and _release_identity(rollback_proof) == prior_release["releaseIdentity"]
    )
    prior_restoration_proved = configuration_restored and prior_release_matches
    return {
        "configurationRestored": configuration_restored,
        "restoredPins": [
            _pin_snapshot_evidence(runtime_pin),
            _pin_snapshot_evidence(approved_pin),
        ],
        "rollbackRestartAttempted": rollback_restart_attempted,
        "rollbackRestartSucceeded": rollback_code == 0,
        "rollbackStderr": rollback_stderr[:500],
        "rollbackProof": rollback_proof,
        "priorReleaseIdentity": prior_release["releaseIdentity"],
        "restoredReleaseIdentity": (
            _release_identity(rollback_proof)
            if rollback_proof.get("proofComplete") is True
            else None
        ),
        "priorReleaseMatches": prior_release_matches,
        "priorRestorationProved": prior_restoration_proved,
        "restorationErrors": restoration_errors,
    }


def op_deploy_pinned_image(params: dict[str, Any], connection: sqlite3.Connection,
                            actor: str, idempotency_key: str) -> Any:
    service = params.get("service")
    if not isinstance(service, str) or not SERVICE_NAME_PATTERN.match(service):
        raise BrokerError("service must be a valid systemd unit name ending in .service")
    if service not in allowed_service_names():
        raise BrokerError(f"service {service} is not in the allowlist")
    image = params.get("image")
    if not isinstance(image, str) or not IMAGE_DIGEST_PATTERN.match(image):
        raise BrokerError("image must be a pinned digest (registry/path@sha256:64hex)")
    source_commit = params.get("sourceCommit")
    if not isinstance(source_commit, str) or not SOURCE_COMMIT_PATTERN.match(source_commit):
        raise BrokerError("sourceCommit must be the exact 40-character merge commit")
    allowlist = load_allowlist()
    service_config = allowlist["allowedServices"].get(service)
    if service_config is None:
        raise BrokerError(f"service {service} is not in the allowlist")
    image_env = service_config.get("imageEnv")
    if not image_env:
        raise BrokerError(f"service {service} does not support image deployment")
    container = service_config.get("container")
    if not container:
        raise BrokerError(f"service {service} has no container for deployment")
    action = canonical_action("deploy_pinned_image", service, params)
    receipt_id = derive_receipt_id(action)
    receipt, reserved = create_receipt(
        connection, receipt_id, "deploy-pinned-image", service,
        idempotency_key, actor, "deploy_pinned_image", action,
    )
    if not reserved:
        return replay_receipt(receipt)
    env_file = CONFIG_DIR / "runtime.env"
    approved_image_file = CONFIG_DIR / "approved-image"
    if not env_file.exists() or not approved_image_file.exists():
        fail_receipted_operation(connection, receipt_id, {
            "image": image,
            "configurationComplete": False,
        }, "runtime.env and approved-image must exist before deployment")
    try:
        runtime_pin = _capture_pin_snapshot(env_file)
        approved_pin = _capture_pin_snapshot(approved_image_file)
        if (runtime_pin["device"], runtime_pin["inode"]) == (
            approved_pin["device"], approved_pin["inode"],
        ):
            raise BrokerError("deployment pins must be distinct regular files")
        previous_env = runtime_pin["content"].decode("utf-8")
        previous_approved_image = approved_pin["content"].decode("utf-8")
        previous_image = previous_approved_image.strip()
        if not IMAGE_DIGEST_PATTERN.match(previous_image):
            raise BrokerError("approved-image does not contain a prior pinned digest")
        if _runtime_env_value_from_text(previous_env, image_env) != previous_image:
            raise BrokerError("runtime.env and approved-image do not bind the same prior image")
        prior_release = _capture_prior_release_state(service, previous_image)
        if not prior_release.get("proofComplete"):
            fail_receipted_operation(connection, receipt_id, {
                "image": image,
                "priorPins": [
                    _pin_snapshot_evidence(runtime_pin),
                    _pin_snapshot_evidence(approved_pin),
                ],
                "priorRelease": prior_release,
                "priorReleaseInspectable": False,
            }, "prior release state could not be proved before deployment")
        if not _pin_snapshot_matches(runtime_pin) or not _pin_snapshot_matches(approved_pin):
            raise BrokerError("deployment pins changed during prior-state capture")
    except ReceiptedOperationError:
        raise
    except Exception as error:
        fail_receipted_operation(connection, receipt_id, {
            "image": image,
            "priorStateCaptureFailure": _bounded_failure(error),
        }, "prior deployment state could not be captured safely")

    approved_merge = _github_approved_merge_evidence(source_commit)
    if not approved_merge["proofComplete"]:
        fail_receipted_operation(connection, receipt_id, {
            "image": image,
            "approvedMerge": approved_merge,
        }, "sourceCommit is not the authoritative merged head of an approved pull request")

    # Pull only after the exact prior configuration/live release and the
    # authoritative GitHub merge record are bound.
    returncode, _, stderr = run_command(
        ["docker", "pull", image], timeout=COMMAND_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        fail_receipted_operation(connection, receipt_id, {
            "image": image, "stderr": stderr,
        }, f"docker pull failed: {stderr}")
    candidate_source_binding = _image_source_binding_evidence(image, source_commit)
    if not candidate_source_binding["proofComplete"]:
        fail_receipted_operation(connection, receipt_id, {
            "image": image,
            "candidateSourceBinding": candidate_source_binding,
        }, "candidate image does not bind an exact source commit to its immutable artifact digest")
    if not _pin_snapshot_matches(runtime_pin) or not _pin_snapshot_matches(approved_pin):
        fail_receipted_operation(connection, receipt_id, {
            "image": image,
            "priorPins": [
                _pin_snapshot_evidence(runtime_pin),
                _pin_snapshot_evidence(approved_pin),
            ],
        }, "deployment pins changed before candidate mutation")
    try:
        pre_mutation_release = _capture_prior_release_state(service, previous_image)
    except Exception as error:
        fail_receipted_operation(connection, receipt_id, {
            "image": image,
            "priorReleaseIdentity": prior_release["releaseIdentity"],
            "preMutationCaptureFailure": _bounded_failure(error),
        }, "live prior release could not be recaptured before candidate mutation")
    if (
        not pre_mutation_release.get("proofComplete")
        or pre_mutation_release["releaseIdentity"] != prior_release["releaseIdentity"]
    ):
        fail_receipted_operation(connection, receipt_id, {
            "image": image,
            "priorReleaseIdentity": prior_release["releaseIdentity"],
            "preMutationRelease": pre_mutation_release,
        }, "live prior release changed before candidate mutation")

    post_health: dict[str, Any] | None = None
    post_front_door: dict[str, Any] | None = None
    post_image_binding: dict[str, Any] | None = None
    try:
        lines = previous_env.splitlines()
        new_lines = [
            line for line in lines if not line.startswith(f"{image_env}=")
        ]
        new_lines.append(f"{image_env}={image}")
        _write_bound_pin(
            runtime_pin,
            ("\n".join(new_lines) + "\n").encode("utf-8"),
            expected_current=runtime_pin["content"],
        )
        _deploy_checkpoint("runtime-env-written")
        _write_bound_pin(
            approved_pin,
            (image + "\n").encode("utf-8"),
            expected_current=approved_pin["content"],
        )
        _deploy_checkpoint("approved-image-written")
        returncode, _, stderr = run_command(
            ["systemctl", "restart", service], timeout=COMMAND_TIMEOUT_SECONDS,
        )
        _deploy_checkpoint("candidate-restart-returned")
        if returncode != 0:
            raise BrokerError(f"service restart after deploy failed: {stderr}")
        time.sleep(2)
        post_health = _check_service_active(service)
        _deploy_checkpoint("post-service-health")
        post_front_door = (
            _front_door_health(service)
            if service_config.get("frontDoorHealth") is not None
            else None
        )
        _deploy_checkpoint("post-front-door-health")
        post_image_binding = _image_binding_evidence(container, image)
        _deploy_checkpoint("post-image-binding")
        release_healthy = (
            post_health["active"]
            and (post_front_door is None or post_front_door["healthy"])
            and post_image_binding["proofComplete"]
        )
        if not release_healthy:
            raise BrokerError("deployed release failed comprehensive health")
        evidence = {
            "service": service,
            "image": image,
            "previousImage": previous_image,
            "container": container,
            "priorPins": [
                _pin_snapshot_evidence(runtime_pin),
                _pin_snapshot_evidence(approved_pin),
            ],
            "priorRelease": prior_release,
            "postHealth": post_health,
            "postFrontDoorHealth": post_front_door,
            "postImageBinding": post_image_binding,
            "candidateSourceBinding": candidate_source_binding,
            "comprehensiveHealthPassed": True,
        }
        complete_receipt(connection, receipt_id, "completed", evidence, "success")
        return {"receiptId": receipt_id, "state": "completed", "evidence": evidence}
    except Exception as error:
        compensation = _compensate_deploy_failure(
            service,
            runtime_pin,
            approved_pin,
            previous_image,
            prior_release,
        )
        proved = compensation["priorRestorationProved"]
        state = "failed" if proved else "reconciliation_required"
        outcome = "failure" if proved else "unknown"
        evidence = {
            "image": image,
            "previousImage": previous_image,
            "candidateFailure": _bounded_failure(error),
            "postHealth": post_health,
            "postFrontDoorHealth": post_front_door,
            "postImageBinding": post_image_binding,
            "candidateSourceBinding": candidate_source_binding,
            **compensation,
        }
        terminalize_receipted_operation(
            connection,
            receipt_id,
            state,
            evidence,
            outcome,
            (
                "deploy failed; prior release restoration proved"
                if proved
                else "deploy outcome requires reconciliation; prior release restoration was not proved"
            ),
        )


def op_rollback_rehearsal(params: dict[str, Any], connection: sqlite3.Connection,
                          actor: str, idempotency_key: str) -> Any:
    service = params.get("service")
    if not isinstance(service, str) or not SERVICE_NAME_PATTERN.match(service):
        raise BrokerError("service must be a valid systemd unit name ending in .service")
    if service not in allowed_service_names():
        raise BrokerError(f"service {service} is not in the allowlist")
    action = canonical_action("rollback_rehearsal", service, params)
    receipt_id = derive_receipt_id(action)
    receipt, reserved = create_receipt(
        connection, receipt_id, "rollback-rehearsal", service,
        idempotency_key, actor, "rollback_rehearsal", action,
    )
    if not reserved:
        return replay_receipt(receipt)
    # A rollback rehearsal only checks that the backup exists and the
    # rollback script is executable.  It does not perform the actual rollback.
    rollback_script = ROLLBACK_SCRIPT
    backup_dir = BACKUP_DIR
    evidence = {
        "service": service,
        "rollbackScriptExists": rollback_script.exists(),
        "rollbackScriptExecutable": (
            rollback_script.exists()
            and os.access(rollback_script, os.X_OK)
        ),
        "backupDirExists": backup_dir.exists(),
        "backups": [],
    }
    if backup_dir.exists():
        for entry in sorted(backup_dir.iterdir())[:10]:
            if entry.is_dir():
                evidence["backups"].append(entry.name)
    complete_receipt(connection, receipt_id, "completed", evidence, "success")
    return {"receiptId": receipt_id, "state": "completed", "evidence": evidence}


def _runtime_env_value_from_text(content: str, key: str) -> str | None:
    matches = [
        line.split("=", 1)[1]
        for line in content.splitlines()
        if line.startswith(f"{key}=")
    ]
    if len(matches) != 1:
        return None
    return matches[0].strip()


def _runtime_env_value(path: Path, key: str) -> str | None:
    if not path.exists():
        return None
    return _runtime_env_value_from_text(path.read_text(encoding="utf-8"), key)


def _inspect_listener_ports(ports: list[int]) -> dict[str, Any]:
    returncode, stdout, stderr = run_command(
        ["ss", "--tcp", "--listening", "--numeric", "--no-header"],
        timeout=HEALTH_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        return {
            "inspectable": False,
            "configuredPorts": ports,
            "presentPorts": [],
            "error": stderr.strip()[:500],
        }
    configured = set(ports)
    present: set[int] = set()
    for line in stdout.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        endpoint = fields[3]
        _, separator, port_text = endpoint.rpartition(":")
        if not separator:
            continue
        try:
            port = int(port_text)
        except ValueError:
            continue
        if port in configured:
            present.add(port)
    return {
        "inspectable": True,
        "configuredPorts": ports,
        "presentPorts": sorted(present),
        "error": "",
    }


def _inspect_container(container: str) -> dict[str, Any]:
    returncode, stdout, stderr = run_command(
        [
            "docker", "container", "inspect",
            "--format={{.State.Running}}\t{{.Config.Image}}\t{{.Image}}", container,
        ],
        timeout=HEALTH_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        error = stderr.strip()
        absent = "no such" in error.lower()
        return {
            "inspectable": absent,
            "exists": False if absent else None,
            "running": False,
            "configuredImage": "",
            "imageId": "",
            "error": "" if absent else error[:500],
        }
    parts = stdout.strip().split("\t")
    if len(parts) != 3 or not IMAGE_ID_PATTERN.match(parts[2].strip()):
        return {
            "inspectable": False,
            "exists": True,
            "running": False,
            "configuredImage": parts[1].strip() if len(parts) > 1 else "",
            "imageId": parts[2].strip() if len(parts) > 2 else "",
            "error": "docker container inspect returned incomplete immutable image evidence",
        }
    return {
        "inspectable": True,
        "exists": True,
        "running": parts[0].lower() == "true",
        "configuredImage": parts[1].strip(),
        "imageId": parts[2].strip(),
        "error": "",
    }


def _inspect_image_reference(image: str) -> dict[str, Any]:
    returncode, stdout, stderr = run_command(
        [
            "docker", "image", "inspect",
            "--format={{.Id}}\t{{json .RepoDigests}}\t{{index .Config.Labels \"org.opencontainers.image.revision\"}}", image,
        ],
        timeout=HEALTH_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        return {
            "inspectable": False,
            "reference": image,
            "imageId": "",
            "repoDigests": [],
            "sourceCommit": "",
            "error": stderr.strip()[:500],
        }
    image_id, separator, remainder = stdout.strip().partition("\t")
    repo_digests_json, source_separator, source_commit = remainder.partition("\t")
    try:
        repo_digests = json.loads(repo_digests_json) if separator else None
    except json.JSONDecodeError:
        repo_digests = None
    if (
        not IMAGE_ID_PATTERN.match(image_id.strip())
        or not isinstance(repo_digests, list)
        or any(not isinstance(item, str) for item in repo_digests)
    ):
        return {
            "inspectable": False,
            "reference": image,
            "imageId": image_id.strip(),
            "repoDigests": repo_digests if isinstance(repo_digests, list) else [],
            "sourceCommit": source_commit.strip() if source_separator else "",
            "error": "docker image inspect returned incomplete immutable image evidence",
        }
    return {
        "inspectable": True,
        "reference": image,
        "imageId": image_id.strip(),
        "repoDigests": repo_digests,
        "sourceCommit": source_commit.strip() if source_separator else "",
        "error": "",
    }


def _github_approved_merge_evidence(expected_source_commit: str) -> dict[str, Any]:
    """Prove the deployment commit is an authoritative merged PR head.

    This uses GitHub's public, TLS-authenticated repository record and no user or
    host credential.  The endpoint is commit-addressed, so the caller cannot
    substitute an unrelated PR number.  Any unavailable, oversized, malformed,
    ambiguous, unmerged, wrong-base, or commit-mismatched response fails closed.
    """
    path = f"/repos/{DEPLOY_REPOSITORY}/commits/{expected_source_commit}/pulls"
    request = Request(
        f"{GITHUB_API_BASE}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "gloops-platform-ops-broker/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(request, timeout=HEALTH_TIMEOUT_SECONDS) as response:
            payload = response.read(64 * 1024 + 1)
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        return {
            "repository": DEPLOY_REPOSITORY,
            "expectedSourceCommit": expected_source_commit,
            "proofComplete": False,
            "error": f"GitHub merge record unavailable: {type(error).__name__}",
        }
    if len(payload) > 64 * 1024:
        return {
            "repository": DEPLOY_REPOSITORY,
            "expectedSourceCommit": expected_source_commit,
            "proofComplete": False,
            "error": "GitHub merge record exceeds the response bound",
        }
    try:
        pulls = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        pulls = None
    if not isinstance(pulls, list):
        return {
            "repository": DEPLOY_REPOSITORY,
            "expectedSourceCommit": expected_source_commit,
            "proofComplete": False,
            "error": "GitHub merge record is malformed",
        }
    matches = []
    for pull in pulls:
        if not isinstance(pull, dict):
            continue
        base = pull.get("base")
        if (
            pull.get("state") == "closed"
            and isinstance(pull.get("merged_at"), str)
            and bool(pull["merged_at"].strip())
            and pull.get("merge_commit_sha") == expected_source_commit
            and isinstance(base, dict)
            and base.get("ref") == DEPLOY_BASE_REF
            and type(pull.get("number")) is int
            and pull["number"] > 0
        ):
            matches.append(pull)
    if len(matches) != 1:
        return {
            "repository": DEPLOY_REPOSITORY,
            "expectedSourceCommit": expected_source_commit,
            "baseRef": DEPLOY_BASE_REF,
            "matchingPullRequestCount": len(matches),
            "proofComplete": False,
            "error": "expected exactly one merged pull request for the deployment commit",
        }
    pull = matches[0]
    return {
        "repository": DEPLOY_REPOSITORY,
        "pullRequest": pull["number"],
        "baseRef": DEPLOY_BASE_REF,
        "mergedAt": pull["merged_at"],
        "sourceCommit": pull["merge_commit_sha"],
        "expectedSourceCommit": expected_source_commit,
        "proofComplete": True,
    }


def _image_source_binding_evidence(image: str, expected_source_commit: str) -> dict[str, Any]:
    inspected = _inspect_image_reference(image)
    artifact_digest = image.rsplit("@", 1)[-1] if "@" in image else ""
    source_commit = inspected.get("sourceCommit", "")
    proof_complete = (
        inspected.get("inspectable") is True
        and SOURCE_COMMIT_PATTERN.match(source_commit) is not None
        and source_commit == expected_source_commit
        and IMAGE_ID_PATTERN.match(artifact_digest) is not None
        and image in inspected.get("repoDigests", [])
    )
    return {
        "sourceCommit": source_commit,
        "expectedSourceCommit": expected_source_commit,
        "artifactDigest": artifact_digest,
        "expectedImage": image,
        "proofComplete": proof_complete,
    }


def _image_binding_evidence(
    container: str,
    expected_image: str,
    *,
    container_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    container_state = container_state or _inspect_container(container)
    expected_state = _inspect_image_reference(expected_image)
    configured_reference_matches = (
        container_state["inspectable"]
        and container_state["configuredImage"] == expected_image
    )
    immutable_id_matches = (
        container_state["inspectable"]
        and expected_state["inspectable"]
        and container_state["imageId"] == expected_state["imageId"]
    )
    expected_digest_present = (
        expected_state["inspectable"]
        and expected_image in expected_state["repoDigests"]
    )
    proof_complete = (
        container_state["inspectable"]
        and container_state["exists"] is True
        and container_state["running"]
        and expected_state["inspectable"]
        and configured_reference_matches
        and immutable_id_matches
        and expected_digest_present
    )
    return {
        "configuredReferenceMatches": configured_reference_matches,
        "immutableImageIdMatches": immutable_id_matches,
        "expectedDigestPresent": expected_digest_present,
        "container": container_state,
        "expectedImage": expected_state,
        "proofComplete": proof_complete,
    }


def _rollback_terminal_evidence(
    service: str,
    mode: str,
    expected_prior_image: str | None,
) -> dict[str, Any]:
    service_config = load_allowlist()["allowedServices"].get(service)
    if service_config is None:
        raise BrokerError(f"service {service} is not in the allowlist")
    proof_config = service_config.get("rollbackProof")
    if not isinstance(proof_config, dict):
        raise BrokerError(f"service {service} has no rollback-proof profile")
    ports = proof_config.get("listenerPorts")
    if (
        not isinstance(ports, list)
        or not ports
        or any(not isinstance(port, int) or isinstance(port, bool) or port < 1 or port > 65535 for port in ports)
    ):
        raise BrokerError(f"service {service} has invalid rollback-proof listener ports")
    container = service_config.get("container")
    image_env = service_config.get("imageEnv")
    if not isinstance(container, str) or not container:
        raise BrokerError(f"service {service} has no rollback-proof container artifact")

    service_state = _check_service_active(service)
    listeners = _inspect_listener_ports(ports)
    container_state = _inspect_container(container)
    evidence: dict[str, Any] = {
        "schemaVersion": "gloops.rollback-proof.v1",
        "service": service,
        "mode": mode,
        "serviceState": service_state,
        "listeners": listeners,
        "containerArtifact": container_state,
    }

    if mode == "absent":
        proof_complete = (
            not service_state["active"]
            and listeners["inspectable"]
            and not listeners["presentPorts"]
            and container_state["inspectable"]
            and container_state["exists"] is False
        )
        evidence.update({
            "listenerAbsenceProved": listeners["inspectable"] and not listeners["presentPorts"],
            "runtimeArtifactAbsenceProved": (
                container_state["inspectable"] and container_state["exists"] is False
            ),
            "priorRestorationProved": False,
            "proofComplete": proof_complete,
        })
        return evidence

    if mode != "restored" or expected_prior_image is None:
        raise BrokerError("rollback proof mode must be absent or restored with expectedPriorImage")
    if not isinstance(image_env, str) or not image_env:
        raise BrokerError(f"service {service} has no image environment binding")

    approved_image_path = CONFIG_DIR / "approved-image"
    runtime_env_path = CONFIG_DIR / "runtime.env"
    approved_image = (
        approved_image_path.read_text(encoding="utf-8").strip()
        if approved_image_path.exists()
        else None
    )
    runtime_image = _runtime_env_value(runtime_env_path, image_env)
    front_door = _front_door_health(service)
    image_binding = _image_binding_evidence(
        container,
        expected_prior_image,
        container_state=container_state,
    )
    image_matches = {
        "approvedImage": approved_image == expected_prior_image,
        "runtimeImage": runtime_image == expected_prior_image,
        "containerConfiguredImage": image_binding["configuredReferenceMatches"],
        "containerImmutableImageId": image_binding["immutableImageIdMatches"],
        "expectedRepoDigest": image_binding["expectedDigestPresent"],
    }
    proof_complete = (
        service_state["active"]
        and listeners["inspectable"]
        and set(ports).issubset(set(listeners["presentPorts"]))
        and image_binding["proofComplete"]
        and all(image_matches.values())
        and front_door["healthy"]
    )
    evidence.update({
        "expectedPriorImage": expected_prior_image,
        "imageMatches": image_matches,
        "imageBinding": image_binding,
        "frontDoorHealth": front_door,
        "listenerAbsenceProved": False,
        "runtimeArtifactAbsenceProved": False,
        "priorRestorationProved": proof_complete,
        "proofComplete": proof_complete,
    })
    return evidence


def _safe_rollback_terminal_evidence(
    service: str,
    expected_prior_image: str,
    rollback_restart_code: int | None,
) -> dict[str, Any]:
    if rollback_restart_code != 0:
        return {
            "schemaVersion": "gloops.rollback-proof.v1",
            "service": service,
            "mode": "restored",
            "proofComplete": False,
            "error": "rollback restart failed before terminal proof",
        }
    try:
        return _rollback_terminal_evidence(service, "restored", expected_prior_image)
    except Exception as error:
        return {
            "schemaVersion": "gloops.rollback-proof.v1",
            "service": service,
            "mode": "restored",
            "proofComplete": False,
            "error": (
                str(error)[:500]
                if isinstance(error, BrokerError)
                else f"rollback proof raised {type(error).__name__}"
            ),
        }


def op_rollback_proof(params: dict[str, Any], connection: sqlite3.Connection,
                      actor: str, idempotency_key: str) -> Any:
    service = params.get("service")
    if not isinstance(service, str) or not SERVICE_NAME_PATTERN.match(service):
        raise BrokerError("service must be a valid systemd unit name ending in .service")
    if service not in allowed_service_names():
        raise BrokerError(f"service {service} is not in the allowlist")
    mode = params.get("mode")
    if mode not in {"absent", "restored"}:
        raise BrokerError("mode must be absent or restored")
    expected_prior_image = params.get("expectedPriorImage")
    if mode == "restored":
        if not isinstance(expected_prior_image, str) or not IMAGE_DIGEST_PATTERN.match(expected_prior_image):
            raise BrokerError("expectedPriorImage must be a pinned digest in restored mode")
    elif expected_prior_image is not None:
        raise BrokerError("expectedPriorImage is only valid in restored mode")

    target = f"{service}:{mode}"
    action = canonical_action("prove_rollback_terminal_state", target, params)
    receipt_id = derive_receipt_id(action)
    receipt, reserved = create_receipt(
        connection, receipt_id, "rollback-proof", target,
        idempotency_key, actor, "prove_rollback_terminal_state", action,
    )
    if not reserved:
        return replay_receipt(receipt)

    evidence = _rollback_terminal_evidence(service, mode, expected_prior_image)
    if not evidence["proofComplete"]:
        fail_receipted_operation(
            connection,
            receipt_id,
            evidence,
            f"rollback terminal proof failed; receiptId={receipt_id}",
        )
    complete_receipt(connection, receipt_id, "completed", evidence, "success")
    return {"receiptId": receipt_id, "state": "completed", "evidence": evidence}


def op_list_receipts(params: dict[str, Any], connection: sqlite3.Connection) -> Any:
    limit = min(int(params.get("limit", 50)), 200)
    receipts = list_receipts(connection, limit)
    return {"receipts": receipts}


def op_get_receipt(params: dict[str, Any], connection: sqlite3.Connection) -> Any:
    receipt_id = params.get("receiptId")
    if not isinstance(receipt_id, str) or not RECEIPT_ID_PATTERN.match(receipt_id):
        raise BrokerError("receiptId is required and must be a short alphanumeric string")
    receipt = get_receipt(connection, receipt_id)
    if receipt is None:
        raise BrokerError(f"receipt {receipt_id} not found")
    return receipt


# ---------------------------------------------------------------------------
# Request validation and processing
# ---------------------------------------------------------------------------

def validate_request(request: dict[str, Any]) -> None:
    operation = request.get("operation")
    if not isinstance(operation, str) or operation not in ALLOWED_OPERATIONS:
        raise BrokerError(
            f"operation must be one of: {', '.join(sorted(ALLOWED_OPERATIONS))}"
        )


def extract_actor(request: dict[str, Any]) -> str:
    actor = request.get("actor")
    if not isinstance(actor, str) or not actor.strip():
        raise BrokerError("actor is required for mutating operations")
    if len(actor) > 200:
        raise BrokerError("actor is too long")
    return actor.strip()


def extract_idempotency_key(request: dict[str, Any]) -> str:
    key = request.get("idempotencyKey")
    if not isinstance(key, str) or not key.strip():
        raise BrokerError("idempotencyKey is required for mutating operations")
    if len(key) > 200:
        raise BrokerError("idempotencyKey is too long")
    return key.strip()


def process_request(
    request: dict[str, Any],
    connection: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    validate_request(request)
    operation = request["operation"]

    if operation in MUTATING_OPERATIONS:
        if connection is None:
            raise BrokerError("database connection is required for mutating operations")
        actor = extract_actor(request)
        idempotency_key = extract_idempotency_key(request)
        if operation == "service-restart":
            data = op_service_restart(request, connection, actor, idempotency_key)
        elif operation == "cache-reclaim":
            data = op_cache_reclaim(request, connection, actor, idempotency_key)
        elif operation == "deploy-pinned-image":
            data = op_deploy_pinned_image(request, connection, actor, idempotency_key)
        elif operation == "rollback-rehearsal":
            data = op_rollback_rehearsal(request, connection, actor, idempotency_key)
        elif operation == "rollback-proof":
            data = op_rollback_proof(request, connection, actor, idempotency_key)
        else:
            raise BrokerError(f"unhandled mutating operation: {operation}")
    else:
        if operation == "service-status":
            data = op_service_status(request)
        elif operation == "service-health":
            data = op_service_health(request)
        elif operation == "front-door-health":
            data = op_front_door_health(request)
        elif operation == "disk-usage":
            data = op_disk_usage(request)
        elif operation == "memory-usage":
            data = op_memory_usage(request)
        elif operation == "cpu-usage":
            data = op_cpu_usage(request)
        elif operation == "cache-inspect":
            data = op_cache_inspect(request)
        elif operation == "list-receipts":
            data = op_list_receipts(request, connection)
        elif operation == "get-receipt":
            data = op_get_receipt(request, connection)
        else:
            raise BrokerError(f"unhandled readonly operation: {operation}")

    data = strip_credentials(data)
    return {"ok": True, "data": data}


# ---------------------------------------------------------------------------
# Socket server
# ---------------------------------------------------------------------------

def read_request(client: socket.socket) -> dict[str, Any]:
    chunks: list[bytes] = []
    total = 0
    while total < MAX_REQUEST_BYTES:
        chunk = client.recv(min(4096, MAX_REQUEST_BYTES - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if b"\n" in chunk:
            break
    raw = b"".join(chunks).strip()
    if not raw:
        raise BrokerError("request is empty")
    if len(raw) > MAX_REQUEST_BYTES:
        raise BrokerError("request exceeds the maximum size")
    try:
        request = json.loads(raw)
    except json.JSONDecodeError:
        raise BrokerError("request is not valid JSON")
    if not isinstance(request, dict):
        raise BrokerError("request must be a JSON object")
    return request


def verify_peer(client: socket.socket) -> None:
    """Verify the connecting peer is the Hermes execution identity."""
    if TEST_MODE:
        return
    try:
        cred = client.getsockopt(
            socket.SOL_SOCKET, SO_PEERCRED, struct.calcsize("iII")
        )
    except (AttributeError, OSError) as error:
        raise BrokerError("unable to verify peer identity") from error
    _pid, uid, _gid = struct.unpack("iII", cred)
    if uid != EXPECTED_HERMES_UID:
        raise BrokerError("peer identity is not authorized")


def handle_connection(client: socket.socket, connection: sqlite3.Connection) -> None:
    response: dict[str, Any]
    try:
        verify_peer(client)
        request = read_request(client)
        response = process_request(request, connection)
        connection.commit()
    except ReceiptedOperationError as error:
        # Only an operation that has already written a terminal failed receipt
        # may cross this commit boundary.  Validation and unreceipted failures
        # continue to roll back below.
        connection.commit()
        response = {"ok": False, "error": str(error)[:500]}
    except BrokerError as error:
        response = {"ok": False, "error": str(error)[:500]}
        connection.rollback()
    except Exception as error:
        response = {"ok": False, "error": f"internal error: {type(error).__name__}"}
        connection.rollback()
    payload = bound_output(response)
    try:
        client.sendall(payload + b"\n")
    except (BrokenPipeError, ConnectionResetError, OSError):
        # The operation and receipt are already committed. A caller may have
        # reached its own bounded wait while a deploy was still health-checking;
        # losing that response must not terminate the long-lived broker.
        return


def serve() -> None:
    if os.geteuid() != 0 and not TEST_MODE:
        raise BrokerError("run as root")
    ensure_dirs()
    connection = connect_database()
    try:
        SOCKET_PATH.unlink(missing_ok=True)
    except FileNotFoundError:
        pass
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(SOCKET_PATH))
    if not TEST_MODE:
        os.chown(SOCKET_PATH, 0, HERMES_GID)
        os.chmod(SOCKET_PATH, 0o660)
    else:
        os.chmod(SOCKET_PATH, 0o660)
    listener.listen(8)
    try:
        while True:
            client, _address = listener.accept()
            with client:
                handle_connection(client, connection)
    finally:
        listener.close()
        try:
            SOCKET_PATH.unlink(missing_ok=True)
        except FileNotFoundError:
            pass
        connection.close()


def check() -> int:
    """Verify the broker can start: allowlist exists and is valid."""
    try:
        load_allowlist()
        print("platform-ops-broker: allowlist is valid")
    except BrokerError as error:
        print(f"platform-ops-broker: {error}", file=sys.stderr)
        raise SystemExit(1)
    # Verify systemctl is available
    returncode, _, _ = run_command(["systemctl", "--version"], timeout=5)
    if returncode != 0:
        print("platform-ops-broker: systemctl is not available", file=sys.stderr)
        raise SystemExit(1)
    print("platform-ops-broker: systemctl is available")
    return 0


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"serve", "check"}:
        raise BrokerError("usage: platform-ops-broker.py serve|check")
    if sys.argv[1] == "check":
        return check()
    ensure_dirs()
    lock_fd = os.open(COMMAND_LOCK, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        os.fchmod(lock_fd, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        serve()
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BrokerError, OSError, json.JSONDecodeError) as error:
        print(f"platform-ops-broker: {error}", file=sys.stderr)
        raise SystemExit(1)
