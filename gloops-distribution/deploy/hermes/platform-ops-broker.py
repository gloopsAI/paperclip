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
from typing import Any

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

# Image digest pattern: sha256:64hex or a named registry path ending in @sha256:64hex
IMAGE_DIGEST_PATTERN = re.compile(
    r"^(?:[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)?@sha256:[0-9a-f]{64}$"
)

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
    "service-restart",
    "disk-usage",
    "memory-usage",
    "cpu-usage",
    "cache-inspect",
    "cache-reclaim",
    "deploy-pinned-image",
    "rollback-rehearsal",
    "list-receipts",
    "get-receipt",
})

# Operations that mutate state and require idempotent receipts
MUTATING_OPERATIONS = frozenset({
    "service-restart",
    "cache-reclaim",
    "deploy-pinned-image",
    "rollback-rehearsal",
})

# Operations that are read-only
READONLY_OPERATIONS = ALLOWED_OPERATIONS - MUTATING_OPERATIONS


class BrokerError(RuntimeError):
    pass


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
) -> dict[str, Any]:
    """Create a new idempotent receipt.  Raises if the idempotency key already
    exists with a different receipt_id."""
    existing = connection.execute(
        "SELECT * FROM receipts WHERE idempotency_key = ?",
        (idempotency_key,),
    ).fetchone()
    if existing:
        if existing["receipt_id"] != receipt_id:
            raise BrokerError("idempotency key is already consumed by a different action")
        return _to_receipt_dict(existing)
    now = timestamp()
    receipt = {
        "receiptId": receipt_id,
        "operation": operation,
        "target": target,
        "idempotencyKey": idempotency_key,
        "state": "initiated",
        "actor": actor,
        "commandClass": command_class,
        "evidence": {},
        "outcome": "pending",
        "createdAt": now,
        "updatedAt": now,
    }
    connection.execute(
        """
        INSERT INTO receipts
          (receipt_id, operation, target, idempotency_key, state, actor,
           command_class, evidence_json, outcome, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (receipt_id, operation, target, idempotency_key, "initiated",
         actor, command_class, "{}", "pending", now, now),
    )
    append_journal(connection, receipt_id, "initiated", {
        "operation": operation, "target": target, "actor": actor,
        "commandClass": command_class,
    })
    return receipt


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


def _to_receipt_dict(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["evidence"] = json.loads(result.pop("evidence_json", "{}"))
    result["receiptId"] = result.pop("receipt_id")
    result["idempotencyKey"] = result.pop("idempotency_key")
    result["commandClass"] = result.pop("command_class")
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


def derive_receipt_id(command_class: str, target: str, idempotency_key: str) -> str:
    """Return a deterministic receipt id from command class, target and key."""
    base = f"{command_class}:{target}:{idempotency_key}"
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:32]


def op_service_restart(params: dict[str, Any], connection: sqlite3.Connection,
                       actor: str, idempotency_key: str) -> Any:
    service = params.get("service")
    if not isinstance(service, str) or not SERVICE_NAME_PATTERN.match(service):
        raise BrokerError("service must be a valid systemd unit name ending in .service")
    if service not in allowed_service_names():
        raise BrokerError(f"service {service} is not in the allowlist")
    receipt_id = derive_receipt_id("restart_named_service", service, idempotency_key)
    receipt = create_receipt(
        connection, receipt_id, "service-restart", service,
        idempotency_key, actor, "restart_named_service",
    )
    if receipt["state"] != "initiated":
        # Idempotent replay
        return {"receiptId": receipt["receiptId"], "state": receipt["state"], "replayed": True}
    # Pre-restart health
    pre_health = _check_service_active(service)
    # Execute restart
    returncode, stdout, stderr = run_command(
        ["systemctl", "restart", service], timeout=COMMAND_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        complete_receipt(connection, receipt_id, "failed", {
            "preHealth": pre_health, "stderr": stderr,
        }, "failure")
        raise BrokerError(f"systemctl restart failed: {stderr}")
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
    receipt_id = derive_receipt_id("reclaim_disposable_cache", cache_name, idempotency_key)
    receipt = create_receipt(
        connection, receipt_id, "cache-reclaim", cache_name,
        idempotency_key, actor, "reclaim_disposable_cache",
    )
    if receipt["state"] != "initiated":
        return {"receiptId": receipt["receiptId"], "state": receipt["state"], "replayed": True}
    # Reclaim: remove contents but not the directory itself
    if cache_path.exists():
        returncode, stdout, stderr = run_command(
            ["find", str(cache_path), "-mindepth", "1", "-delete"],
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
        if returncode != 0:
            complete_receipt(connection, receipt_id, "failed", {
                "preSizeBytes": pre_size, "stderr": stderr,
            }, "failure")
            raise BrokerError(f"cache reclaim failed: {stderr}")
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
    receipt_id = derive_receipt_id("deploy_pinned_image", service, idempotency_key)
    receipt = create_receipt(
        connection, receipt_id, "deploy-pinned-image", service,
        idempotency_key, actor, "deploy_pinned_image",
    )
    if receipt["state"] != "initiated":
        return {"receiptId": receipt["receiptId"], "state": receipt["state"], "replayed": True}
    # Pull the pinned image
    returncode, stdout, stderr = run_command(
        ["docker", "pull", image], timeout=COMMAND_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        complete_receipt(connection, receipt_id, "failed", {
            "image": image, "stderr": stderr,
        }, "failure")
        raise BrokerError(f"docker pull failed: {stderr}")
    # Bind both the service environment and the preflight release pin before
    # restart. Both files are restored if the new release cannot start.
    env_file = CONFIG_DIR / "runtime.env"
    approved_image_file = CONFIG_DIR / "approved-image"
    if not env_file.exists() or not approved_image_file.exists():
        complete_receipt(connection, receipt_id, "failed", {
            "image": image,
            "configurationComplete": False,
        }, "failure")
        raise BrokerError("runtime.env and approved-image must exist before deployment")
    previous_env = env_file.read_text(encoding="utf-8")
    previous_approved_image = approved_image_file.read_text(encoding="utf-8")
    previous_image = previous_approved_image.strip()
    lines = previous_env.splitlines()
    new_lines = [
        line for line in lines if not line.startswith(f"{image_env}=")
    ]
    new_lines.append(f"{image_env}={image}")
    env_file.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    os.chmod(env_file, 0o600)
    approved_image_file.write_text(image + "\n", encoding="utf-8")
    os.chmod(approved_image_file, 0o600)
    returncode, stdout, stderr = run_command(
        ["systemctl", "restart", service], timeout=COMMAND_TIMEOUT_SECONDS,
    )
    if returncode != 0:
        env_file.write_text(previous_env, encoding="utf-8")
        os.chmod(env_file, 0o600)
        approved_image_file.write_text(previous_approved_image, encoding="utf-8")
        os.chmod(approved_image_file, 0o600)
        rollback_code, _, rollback_stderr = run_command(
            ["systemctl", "restart", service], timeout=COMMAND_TIMEOUT_SECONDS,
        )
        complete_receipt(connection, receipt_id, "failed", {
            "image": image,
            "previousImage": previous_image,
            "stderr": stderr,
            "configurationRestored": True,
            "rollbackRestartSucceeded": rollback_code == 0,
            "rollbackStderr": rollback_stderr,
        }, "failure")
        raise BrokerError(f"service restart after deploy failed: {stderr}")
    time.sleep(2)
    post_health = _check_service_active(service)
    evidence = {
        "service": service,
        "image": image,
        "previousImage": previous_image,
        "container": container,
        "postHealth": post_health,
    }
    complete_receipt(connection, receipt_id, "completed", evidence, "success")
    return {"receiptId": receipt_id, "state": "completed", "evidence": evidence}


def op_rollback_rehearsal(params: dict[str, Any], connection: sqlite3.Connection,
                          actor: str, idempotency_key: str) -> Any:
    service = params.get("service")
    if not isinstance(service, str) or not SERVICE_NAME_PATTERN.match(service):
        raise BrokerError("service must be a valid systemd unit name ending in .service")
    if service not in allowed_service_names():
        raise BrokerError(f"service {service} is not in the allowlist")
    receipt_id = derive_receipt_id("rollback_rehearsal", service, idempotency_key)
    receipt = create_receipt(
        connection, receipt_id, "rollback-rehearsal", service,
        idempotency_key, actor, "rollback_rehearsal",
    )
    if receipt["state"] != "initiated":
        return {"receiptId": receipt["receiptId"], "state": receipt["state"], "replayed": True}
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
        else:
            raise BrokerError(f"unhandled mutating operation: {operation}")
    else:
        if operation == "service-status":
            data = op_service_status(request)
        elif operation == "service-health":
            data = op_service_health(request)
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
