#!/usr/bin/env python3
"""Crash-rehearse the exact commissioner and recovery unit without live mutation."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import shlex
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
RECOVERY_UNIT = "paperclip-controlled-swarm-commissioning-recovery.service"
PAPERCLIP_UNIT = "paperclip-controlled-swarm.service"
GITHUB_BROKER = INSTALLED_ROOT / "github-app-credentials.py"
GITHUB_APP_CONFIG = Path("/etc/paperclip-gloops/github-app.json")
GITHUB_CREDENTIAL_RECEIPT = Path(
    "/var/lib/paperclip-gloops/credential-runtime/credential-receipt.json",
)
GITHUB_CREDENTIAL_HISTORY = Path(
    "/var/lib/paperclip-gloops/credential-history.jsonl",
)
PROJECT_REPOSITORY = Path(
    "/opt/paperclip/hermes-execution-state/workspace",
)
EXPECTED_RECOVERY_UNIT_SHA256 = (
    "sha256:46b1f9b94203471e37c46b27149ee509151413384f6e442c125f7b8edda05595"
)
RECOVERY_TIMEOUT_START_USEC = 180_000_000
RECOVERY_TIMEOUT_STOP_USEC = 180_000_000
RECOVERY_EXEC_ARGV = [
    str(INSTALLED_ROOT / "controlled-swarm-commissioner.py"),
    "--recover-interrupted",
]
RECOVERY_CONDITIONS = [
    "ConditionPathExists=/var/lib/paperclip-gloops/controlled-swarm/"
    "commissioning-rollback.json",
]
RECOVERY_SECURITY_PROPERTIES = {
    "User": "root",
    "Group": "root",
    "NoNewPrivileges": "true",
    "PrivateDevices": "true",
    "PrivateTmp": "true",
    "ProtectClock": "true",
    "ProtectControlGroups": "true",
    "ProtectHome": "true",
    "ProtectHostname": "true",
    "ProtectKernelLogs": "true",
    "ProtectKernelModules": "true",
    "ProtectKernelTunables": "true",
    "ProtectSystem": "strict",
    "ReadOnlyPaths": "/usr/local/lib/paperclip-gloops",
    "RestrictAddressFamilies": "AF_UNIX AF_INET AF_INET6",
    "RestrictNamespaces": "true",
    "RestrictRealtime": "true",
    "RestrictSUIDSGID": "true",
    "SystemCallArchitectures": "native",
}
RECOVERY_LOADED_SECURITY_PROPERTIES = {
    **RECOVERY_SECURITY_PROPERTIES,
    "ReadOnlyPaths": "/usr/local/lib/paperclip-gloops",
    "RestrictAddressFamilies": "AF_INET AF_INET6 AF_UNIX",
}
RECOVERY_READ_WRITE_PATHS = [
    "/etc/paperclip-gloops",
    "/run/lock",
    "/var/lib/paperclip-gloops/controlled-swarm",
]
PROJECTOR_PERMISSIONS = {
    "checks": "read",
    "contents": "read",
    "issues": "read",
    "metadata": "read",
    "pull_requests": "read",
    "statuses": "read",
}


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and value.startswith("sha256:")
        and len(value) == 71
        and all(character in "0123456789abcdef" for character in value[7:])
    )


def strict_json_object(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON object key: {key}")
        value[key] = item
    return value


def reject_json_constant(value: str) -> object:
    raise ValueError(f"non-finite JSON number: {value}")


def strict_json_loads(value: str) -> object:
    return json.loads(
        value,
        object_pairs_hook=strict_json_object,
        parse_constant=reject_json_constant,
    )


def protected_json_snapshot(
    path: Path,
    label: str,
) -> tuple[bytes, dict[str, object], str]:
    file_stat = path.stat()
    if stat.S_IMODE(file_stat.st_mode) != 0o600 or file_stat.st_uid != 0:
        raise RuntimeError(f"{label} is not root-owned mode 0600")
    raw = path.read_bytes()
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError(f"{label} is not strict UTF-8") from error
    if (
        not raw
        or not raw.endswith(b"\n")
        or raw.count(b"\n") != 1
        or b"\r" in raw
    ):
        raise RuntimeError(f"{label} line framing is malformed")
    try:
        payload = strict_json_loads(decoded[:-1])
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"{label} JSON is malformed") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label} JSON root is not an object")
    return raw, payload, sha256_bytes(raw)


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


def systemd_properties(
    unit: str,
    *properties: str,
) -> dict[str, str]:
    return {
        prop: run(
            "systemctl",
            "show",
            f"--property={prop}",
            "--value",
            unit,
            check=False,
        ).stdout.strip()
        for prop in properties
    }


def unit_directives(fragment: Path) -> dict[str, list[str]]:
    """Return non-comment systemd assignments without interpreting substrings."""

    directives: dict[str, list[str]] = {}
    section = ""
    for raw_line in fragment.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        if "=" not in line:
            raise RuntimeError(f"malformed recovery-unit directive: {raw_line}")
        key, value = line.split("=", 1)
        directives.setdefault(f"{section}.{key}", []).append(value)
    return directives


def exec_status_for_argv(raw: str, expected_argv: list[str]) -> bool:
    """Require command-specific success from a structured systemd Exec value."""

    matches = 0
    for record in re.findall(r"\{[^{}]*\}", raw):
        argv_match = re.search(r"(?:^|;\s*)argv\[\]=(.*?)(?:\s*;|$)", record)
        status_match = re.search(r"(?:^|;\s*)status=([^;}\s]+)", record)
        if argv_match is None:
            continue
        try:
            argv = shlex.split(argv_match.group(1).strip())
        except ValueError:
            continue
        if argv == expected_argv:
            matches += 1
            if status_match is None or status_match.group(1) != "0/SUCCESS":
                return False
    return matches == 1


def exec_argv_records(raw: str) -> list[list[str]]:
    commands: list[list[str]] = []
    for record in re.findall(r"\{[^{}]*\}", raw):
        argv_match = re.search(r"(?:^|;\s*)argv\[\]=(.*?)(?:\s*;|$)", record)
        if argv_match is None:
            raise RuntimeError("loaded systemd execution record lacks argv")
        commands.append(shlex.split(argv_match.group(1).strip()))
    if not commands:
        raise RuntimeError("loaded systemd execution property has no commands")
    return commands


def systemd_unit_dbus_path(unit: str) -> str:
    escaped = "".join(
        character
        if character.isascii() and character.isalnum()
        else f"_{ord(character):02x}"
        for character in unit
    )
    return f"/org/freedesktop/systemd1/unit/{escaped}"


def loaded_conditions(unit: str, raw_conditions: str) -> list[str]:
    """Read the manager's complex Conditions property, retaining show output."""

    result = run(
        "busctl",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        systemd_unit_dbus_path(unit),
        "org.freedesktop.systemd1.Unit",
        "Conditions",
    )
    try:
        payload = strict_json_loads(result.stdout)
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("systemd Conditions JSON is malformed") from error
    if payload.get("type") != "a(sbbsi)" or not isinstance(
        payload.get("data"),
        list,
    ):
        raise RuntimeError(
            f"loaded systemd Conditions property is malformed: {payload}",
        )
    normalized: list[str] = []
    for record in payload["data"]:
        if (
            not isinstance(record, list)
            or len(record) != 5
            or not isinstance(record[0], str)
            or not isinstance(record[1], bool)
            or not isinstance(record[2], bool)
            or not isinstance(record[3], str)
            or not isinstance(record[4], int)
        ):
            raise RuntimeError(
                f"loaded systemd condition record is malformed: {record}",
            )
        condition_type, trigger, negate, parameter, _result = record
        if trigger or negate:
            raise RuntimeError(
                "loaded recovery-unit conditions may not trigger or negate",
            )
        normalized.append(f"{condition_type}={parameter}")
    if not raw_conditions:
        raise RuntimeError("systemctl show omitted the loaded Conditions receipt")
    return sorted(normalized)


def normalize_loaded_security(
    loaded: dict[str, str],
) -> dict[str, str]:
    normalized: dict[str, str] = {}
    boolean_properties = {
        name
        for name, value in RECOVERY_SECURITY_PROPERTIES.items()
        if value == "true"
    }
    for name, expected in RECOVERY_SECURITY_PROPERTIES.items():
        value = loaded.get(name, "")
        if name in boolean_properties:
            if value != "yes":
                raise RuntimeError(f"loaded {name} is not enabled")
            normalized[name] = "true"
        elif name in {"ReadOnlyPaths", "RestrictAddressFamilies"}:
            normalized[name] = " ".join(sorted(shlex.split(value)))
        else:
            normalized[name] = value
    if normalized != RECOVERY_LOADED_SECURITY_PROPERTIES:
        raise RuntimeError(
            f"loaded recovery-unit security properties drifted: {normalized}",
        )
    return normalized


def loaded_unit_contract_digest(evidence: dict[str, object]) -> str:
    contract = {
        "execCommands": evidence.get("loadedExecCommands"),
        "conditions": evidence.get("loadedConditions"),
        "timeoutStartUSec": evidence.get("loadedTimeoutStartUSec"),
        "timeoutStopUSec": evidence.get("loadedTimeoutStopUSec"),
        "timeoutStartMicroseconds": evidence.get(
            "loadedTimeoutStartMicroseconds",
        ),
        "timeoutStopMicroseconds": evidence.get(
            "loadedTimeoutStopMicroseconds",
        ),
        "readWritePaths": evidence.get("loadedReadWritePaths"),
        "securityProperties": evidence.get("loadedSecurityProperties"),
    }
    payload = json.dumps(
        contract,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def normalize_systemd_duration_usec(value: str) -> int:
    multipliers = {
        "us": 1,
        "ms": 1_000,
        "s": 1_000_000,
        "min": 60_000_000,
        "h": 3_600_000_000,
        "d": 86_400_000_000,
        "week": 604_800_000_000,
        "month": 2_629_800_000_000,
        "year": 31_557_600_000_000,
    }
    position = 0
    total = 0
    matched = False
    token = re.compile(
        r"\s*(\d+)\s*(us|ms|min|week|month|year|s|h|d)",
    )
    while position < len(value):
        match = token.match(value, position)
        if match is None:
            raise RuntimeError(f"unparseable systemd duration: {value}")
        total += int(match.group(1)) * multipliers[match.group(2)]
        position = match.end()
        matched = True
    if not matched:
        raise RuntimeError("systemd duration is empty")
    return total


def systemd_duration_matches(value: object, expected_usec: int) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return normalize_systemd_duration_usec(value) == expected_usec
    except RuntimeError:
        return False


def credential_history_digest(record: dict[str, object]) -> str:
    payload = dict(record)
    payload.pop("receiptDigest", None)
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def credential_history_snapshot() -> tuple[bytes, list[dict[str, object]]]:
    if not GITHUB_CREDENTIAL_HISTORY.exists():
        return b"", []
    file_stat = GITHUB_CREDENTIAL_HISTORY.stat()
    if stat.S_IMODE(file_stat.st_mode) != 0o600 or file_stat.st_uid != 0:
        raise RuntimeError("GitHub credential history is not root-owned mode 0600")
    raw = GITHUB_CREDENTIAL_HISTORY.read_bytes()
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError("GitHub credential history is not strict UTF-8") from error
    if raw and (
        not raw.endswith(b"\n")
        or "\n\n" in decoded
        or b"\r" in raw
    ):
        raise RuntimeError("GitHub credential history line framing is malformed")
    try:
        records = [
            strict_json_loads(line)
            for line in decoded.splitlines()
        ]
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("GitHub credential history JSON is malformed") from error
    prior: str | None = None
    lifecycles: set[str] = set()
    for sequence, record in enumerate(records, 1):
        if (
            not isinstance(record, dict)
            or record.get("sequence") != sequence
            or record.get("previousReceiptDigest") != prior
            or record.get("receiptDigest") != credential_history_digest(record)
            or not isinstance(record.get("lifecycleId"), str)
            or record["lifecycleId"] in lifecycles
        ):
            raise RuntimeError("GitHub credential history hash chain is invalid")
        lifecycles.add(record["lifecycleId"])
        prior = str(record["receiptDigest"])
    return raw, records


def credential_history_log_digest(
    records: list[dict[str, object]],
) -> str:
    payload = json.dumps(
        records,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def active_projector_credential() -> dict[str, object]:
    _raw, receipt, receipt_sha256 = protected_json_snapshot(
        GITHUB_CREDENTIAL_RECEIPT,
        "GitHub credential receipt",
    )
    projector = receipt.get("projector")
    lifecycle_id = receipt.get("lifecycleId")
    if (
        not isinstance(projector, dict)
        or projector.get("permissions") != PROJECTOR_PERMISSIONS
        or not isinstance(projector.get("mintedAt"), str)
        or not isinstance(projector.get("expiresAt"), str)
        or projector.get("revokedAt") is not None
        or projector.get("expiredAt") is not None
        or not isinstance(projector.get("tokenFingerprint"), str)
        or len(projector["tokenFingerprint"]) != 64
        or any(
            character not in "0123456789abcdef"
            for character in projector["tokenFingerprint"]
        )
        or not isinstance(lifecycle_id, str)
        or not lifecycle_id
    ):
        raise RuntimeError("projector credential receipt is incomplete or over-scoped")
    return {
        "lifecycleId": lifecycle_id,
        "fingerprint": projector["tokenFingerprint"],
        "mintedAt": projector["mintedAt"],
        "expiresAt": projector["expiresAt"],
        "permissions": projector["permissions"],
        "receiptSha256": receipt_sha256,
    }


def repository_content_digest(repository: Path) -> str:
    if (
        run(
            "git",
            "-C",
            str(repository),
            "rev-parse",
            "--is-inside-work-tree",
            check=False,
        ).stdout.strip()
        != "true"
    ):
        raise RuntimeError("exact plugin repository is not an inspectable worktree")
    digest = hashlib.sha256()
    files: list[Path] = []
    for root, directories, names in os.walk(repository):
        directories[:] = sorted(
            name for name in directories if name != ".git"
        )
        files.extend(Path(root) / name for name in sorted(names))
    for path in sorted(files):
        relative = path.relative_to(repository).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        if path.is_symlink():
            digest.update(b"symlink\0")
            digest.update(os.readlink(path).encode("utf-8"))
        elif path.is_file():
            digest.update(b"file\0")
            digest.update(path.read_bytes())
        else:
            digest.update(b"other\0")
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def cleanup_one_use_approvals(paths: Any) -> None:
    approvals = [
        paths.approval,
        *paths.config_dir.glob(
            ".CONTROLLED_SWARM_COMMISSIONING_APPROVED.*",
        ),
    ]
    removed = False
    for approval in approvals:
        try:
            approval.unlink()
            removed = True
        except FileNotFoundError:
            continue
    if removed:
        directory = os.open(paths.config_dir, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def fail_closed_fence(paths: Any, platform: Any) -> dict[str, object]:
    """Attempt both fences, but never persist false before stop is attempted."""

    stop_error: BaseException | None = None
    inactive_check_error: BaseException | None = None
    barrier_error: BaseException | None = None
    inactive_after_stop = False
    try:
        platform.stop_paperclip()
    except BaseException as error:
        stop_error = error
    try:
        inactive_after_stop = not platform.is_active(PAPERCLIP_UNIT)
        if not inactive_after_stop:
            raise RuntimeError("Paperclip remained active after the recovery fence")
    except BaseException as error:
        inactive_check_error = error
    try:
        platform.set_barrier(False)
    except BaseException as error:
        barrier_error = error

    runtime_lines = (
        paths.runtime_env.read_text(encoding="utf-8").splitlines()
        if paths.runtime_env.exists()
        else []
    )
    persisted_false = runtime_lines.count(
        "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
    ) == 1
    effective_check_error: BaseException | None = None
    try:
        effective_false = not platform.is_active(PAPERCLIP_UNIT)
    except BaseException as error:
        effective_check_error = error
        effective_false = False
    if (
        stop_error is not None
        or inactive_check_error is not None
        or barrier_error is not None
        or effective_check_error is not None
        or not inactive_after_stop
        or not persisted_false
        or not effective_false
    ):
        failures = []
        if stop_error is not None:
            failures.append(f"stop failed: {stop_error}")
        if inactive_check_error is not None:
            failures.append(
                f"inactive verification failed: {inactive_check_error}",
            )
        if barrier_error is not None:
            failures.append(f"barrier write failed: {barrier_error}")
        if effective_check_error is not None:
            failures.append(
                f"effective fence verification failed: {effective_check_error}",
            )
        if not inactive_after_stop:
            failures.append("Paperclip was not verified inactive before barrier write")
        if not persisted_false:
            failures.append("persisted barrier is not exactly false")
        if not effective_false:
            failures.append("effective execution remains active")
        raise RuntimeError("; ".join(failures))
    return {
        "paperclipInactiveBeforeBarrierWrite": True,
        "persistedBarrier": "false",
        "effectiveBarrier": "false",
    }


def effective_unit_evidence() -> dict[str, object]:
    loaded_names = [
        "UnitFileState",
        "FragmentPath",
        "DropInPaths",
        "ExecStart",
        "Conditions",
        "TimeoutStartUSec",
        "TimeoutStopUSec",
        "ReadWritePaths",
        *RECOVERY_SECURITY_PROPERTIES.keys(),
    ]
    unit_properties = systemd_properties(
        RECOVERY_UNIT,
        *loaded_names,
    )
    fragment = Path(unit_properties["FragmentPath"])
    if (
        unit_properties["UnitFileState"] != "enabled"
        or fragment != INSTALLED_UNIT
        or unit_properties["DropInPaths"] != ""
        or not fragment.is_file()
        or sha256(fragment) != EXPECTED_RECOVERY_UNIT_SHA256
    ):
        raise RuntimeError(
            f"effective commissioning recovery unit drifted: {unit_properties}",
        )
    directives = unit_directives(fragment)
    disk_exec_commands = [
        shlex.split(value)
        for value in directives.get("Service.ExecStart", [])
    ]
    disk_conditions = sorted(
        f"{key.split('.', 1)[1]}={value}"
        for key, values in directives.items()
        if key.startswith("Unit.Condition")
        for value in values
    )
    disk_security: dict[str, str] = {}
    for name in RECOVERY_SECURITY_PROPERTIES:
        values = directives.get(f"Service.{name}", [])
        if len(values) == 1:
            disk_security[name] = values[0]
    read_write_values = directives.get("Service.ReadWritePaths", [])
    timeout_start_values = directives.get("Service.TimeoutStartSec", [])
    timeout_stop_values = directives.get("Service.TimeoutStopSec", [])
    disk_read_write_paths = (
        sorted(shlex.split(read_write_values[0]))
        if len(read_write_values) == 1
        else []
    )
    if (
        disk_exec_commands != [RECOVERY_EXEC_ARGV]
        or disk_conditions != RECOVERY_CONDITIONS
        or disk_security != RECOVERY_SECURITY_PROPERTIES
        or timeout_start_values != ["180"]
        or timeout_stop_values != ["180"]
        or disk_read_write_paths != RECOVERY_READ_WRITE_PATHS
    ):
        raise RuntimeError(
            "installed commissioning recovery unit does not exactly match "
            "the canonical execution, condition, or security contract",
        )
    loaded_exec_commands = exec_argv_records(unit_properties["ExecStart"])
    loaded_condition_values = loaded_conditions(
        RECOVERY_UNIT,
        unit_properties["Conditions"],
    )
    loaded_security = normalize_loaded_security(unit_properties)
    loaded_read_write_paths = sorted(
        shlex.split(unit_properties["ReadWritePaths"]),
    )
    loaded_timeout_start_usec = normalize_systemd_duration_usec(
        unit_properties["TimeoutStartUSec"],
    )
    loaded_timeout_stop_usec = normalize_systemd_duration_usec(
        unit_properties["TimeoutStopUSec"],
    )
    if (
        loaded_exec_commands != [RECOVERY_EXEC_ARGV]
        or loaded_condition_values != RECOVERY_CONDITIONS
        or loaded_timeout_start_usec != RECOVERY_TIMEOUT_START_USEC
        or loaded_timeout_stop_usec != RECOVERY_TIMEOUT_STOP_USEC
        or loaded_read_write_paths != RECOVERY_READ_WRITE_PATHS
    ):
        raise RuntimeError(
            "systemd manager loaded a non-canonical recovery-unit contract",
        )
    loaded_contract = {
        "execCommands": loaded_exec_commands,
        "conditions": loaded_condition_values,
        "timeoutStartUSec": unit_properties["TimeoutStartUSec"],
        "timeoutStopUSec": unit_properties["TimeoutStopUSec"],
        "timeoutStartMicroseconds": loaded_timeout_start_usec,
        "timeoutStopMicroseconds": loaded_timeout_stop_usec,
        "readWritePaths": loaded_read_write_paths,
        "securityProperties": loaded_security,
    }
    return {
        "unitFileState": unit_properties["UnitFileState"],
        "fragmentPath": str(fragment),
        "dropInPaths": [],
        "diskExecCommands": disk_exec_commands,
        "diskConditions": disk_conditions,
        "diskTimeoutStartSec": 180,
        "diskTimeoutStopSec": 180,
        "diskReadWritePaths": disk_read_write_paths,
        "diskSecurityProperties": disk_security,
        "loadedExecCommands": loaded_exec_commands,
        "loadedConditions": loaded_condition_values,
        "loadedConditionsRaw": unit_properties["Conditions"],
        "loadedTimeoutStartUSec": unit_properties["TimeoutStartUSec"],
        "loadedTimeoutStopUSec": unit_properties["TimeoutStopUSec"],
        "loadedTimeoutStartMicroseconds": loaded_timeout_start_usec,
        "loadedTimeoutStopMicroseconds": loaded_timeout_stop_usec,
        "loadedReadWritePaths": loaded_read_write_paths,
        "loadedSecurityProperties": loaded_security,
        "canonicalExpectedSha256": EXPECTED_RECOVERY_UNIT_SHA256,
        "fragmentSha256": sha256(fragment),
        "loadedRawPropertiesSha256": (
            "sha256:"
            + hashlib.sha256(
                json.dumps(
                    unit_properties,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8"),
            ).hexdigest()
        ),
        "effectivePropertiesSha256": (
            "sha256:"
            + hashlib.sha256(
                json.dumps(
                    loaded_contract,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8"),
            ).hexdigest()
        ),
    }


def paperclip_runtime_evidence(paths: Any) -> dict[str, object]:
    paperclip = systemd_properties(
        PAPERCLIP_UNIT,
        "FragmentPath",
        "DropInPaths",
        "ExecStartPre",
        "ExecStart",
        "ExecStartPost",
        "ExecStop",
        "ExecStopPost",
    )
    fragment = Path(paperclip["FragmentPath"])
    if (
        not fragment.is_file()
        or paperclip["DropInPaths"] != ""
        or str(GITHUB_BROKER) not in paperclip["ExecStartPre"]
        or "refresh-projector" not in paperclip["ExecStartPre"]
        or str(GITHUB_BROKER) not in paperclip["ExecStartPost"]
        or "rotate-projector" not in paperclip["ExecStartPost"]
        or str(GITHUB_BROKER) not in paperclip["ExecStop"]
        or "clear-projector" not in paperclip["ExecStop"]
        or str(GITHUB_BROKER) not in paperclip["ExecStopPost"]
        or "revoke-projector" not in paperclip["ExecStopPost"]
    ):
        raise RuntimeError(f"effective Paperclip credential lifecycle drifted: {paperclip}")
    if not GITHUB_BROKER.is_file() or not GITHUB_APP_CONFIG.is_file():
        raise RuntimeError("installed GitHub credential boundary is incomplete")
    runtime_lines = paths.runtime_env.read_text(encoding="utf-8").splitlines()
    scheduler_disabled = (
        runtime_lines.count("HEARTBEAT_SCHEDULER_ENABLED=false") == 1
        and runtime_lines.count(
            "PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED=false",
        )
        == 1
    )
    if not scheduler_disabled:
        raise RuntimeError("global execution schedulers are not exactly disabled")
    return {
        "approvedImage": paths.image.read_text(encoding="utf-8").strip(),
        "paperclipUnitSha256": sha256(fragment),
        "paperclipEffectivePropertiesSha256": (
            "sha256:"
            + hashlib.sha256(
                json.dumps(
                    paperclip,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8"),
            ).hexdigest()
        ),
        "runtimeEnvSha256": sha256(paths.runtime_env),
        "sidecarConfigSha256": sha256(paths.sidecar_config),
        "sidecarPolicySha256": sha256(paths.sidecar_policy),
        "credentialBrokerSha256": sha256(GITHUB_BROKER),
        "githubAppConfigSha256": sha256(GITHUB_APP_CONFIG),
        "globalSchedulersDisabled": scheduler_disabled,
        "projectorPermissionsExpected": PROJECTOR_PERMISSIONS,
        "credentialLifecycleCommands": {
            "mint": "refresh-projector",
            "project": "rotate-projector",
            "clear": "clear-projector",
            "revoke": "revoke-projector",
        },
    }


def credential_lifecycle_evidence(
    platform: Any,
    prior_transitions: list[dict[str, object]],
) -> dict[str, object]:
    """Close one lifecycle durably, then prove a distinct read-only lifecycle."""

    prior = active_projector_credential()
    pre_history_bytes, pre_history = credential_history_snapshot()
    if any(
        record.get("lifecycleId") == prior["lifecycleId"]
        or (
            isinstance(record.get("projector"), dict)
            and record["projector"].get("tokenFingerprint")
            == prior["fingerprint"]
        )
        for record in pre_history
    ):
        raise RuntimeError(
            "active credential lifecycle already appears in archival history",
        )
    pre_history_digest = credential_history_log_digest(pre_history)
    run("systemctl", "stop", PAPERCLIP_UNIT)
    if platform.is_active(PAPERCLIP_UNIT):
        raise RuntimeError("Paperclip remained active after credential boundary stop")
    stop_post = systemd_properties(PAPERCLIP_UNIT, "ExecStopPost")[
        "ExecStopPost"
    ]
    revoke_argv = [str(GITHUB_BROKER), "revoke-projector"]
    if not exec_status_for_argv(stop_post, revoke_argv):
        raise RuntimeError(
            "command-specific revoke-projector execution did not succeed",
        )

    hermes_unit = "paperclip-hermes-execution.service"
    run("systemctl", "stop", hermes_unit)
    if platform.is_active(hermes_unit):
        raise RuntimeError("Hermes remained active after credential boundary stop")
    post_history_bytes, history = credential_history_snapshot()
    if (
        len(history) != len(pre_history) + 1
        or history[:-1] != pre_history
        or not post_history_bytes.startswith(pre_history_bytes)
    ):
        raise RuntimeError(
            "credential history did not append exactly one archival tail",
        )
    revoked = history[-1]
    appended_bytes = post_history_bytes[len(pre_history_bytes) :]
    try:
        appended_record = strict_json_loads(
            appended_bytes.decode("utf-8").strip(),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(
            "credential history archival tail is not exactly one JSON record",
        ) from error
    if (
        appended_bytes.count(b"\n") != 1
        or not appended_bytes.endswith(b"\n")
        or appended_record != revoked
    ):
        raise RuntimeError(
            "credential history archival tail is not exactly one JSON record",
        )
    revoked_projector = (
        revoked.get("projector") if isinstance(revoked, dict) else None
    )
    if (
        not isinstance(revoked_projector, dict)
        or revoked_projector.get("tokenFingerprint") != prior["fingerprint"]
        or revoked_projector.get("permissions") != PROJECTOR_PERMISSIONS
        or not isinstance(revoked_projector.get("revokedAt"), str)
        or not all(
            isinstance(revoked.get(role), dict)
            and (
                isinstance(revoked[role].get("revokedAt"), str)
                or isinstance(revoked[role].get("expiredAt"), str)
            )
            for role in ("hermes", "projector")
        )
    ):
        raise RuntimeError(
            "prior projector lifecycle is not durably revoked in history",
        )
    if revoked.get("sequence") != len(pre_history) + 1:
        raise RuntimeError("credential archive sequence did not increase exactly")

    run("systemctl", "start", hermes_unit)
    run("systemctl", "start", PAPERCLIP_UNIT)
    if not platform.is_active(hermes_unit) or not platform.is_active(PAPERCLIP_UNIT):
        raise RuntimeError("credential boundary did not restore inert services")
    current = active_projector_credential()
    previously_observed_lifecycles = {
        value
        for transition in prior_transitions
        for value in (
            transition.get("priorLifecycleId"),
            transition.get("newLifecycleId"),
        )
        if isinstance(value, str)
    }
    previously_observed_fingerprints = {
        value
        for transition in prior_transitions
        for value in (
            transition.get("priorProjectorTokenFingerprintSha256"),
            transition.get("newProjectorTokenFingerprintSha256"),
        )
        if isinstance(value, str)
    }
    if (
        current["lifecycleId"] == prior["lifecycleId"]
        or current["fingerprint"] == prior["fingerprint"]
        or any(
            record.get("lifecycleId") == current["lifecycleId"]
            or (
                isinstance(record.get("projector"), dict)
                and record["projector"].get("tokenFingerprint")
                == current["fingerprint"]
            )
            for record in history
        )
        or current["lifecycleId"] in previously_observed_lifecycles
        or (
            "sha256:" + str(current["fingerprint"])
            in previously_observed_fingerprints
        )
    ):
        raise RuntimeError(
            "credential boundary reused a current or historical lifecycle",
        )
    return {
        "priorLifecycleId": prior["lifecycleId"],
        "priorCredentialReceiptSha256": prior["receiptSha256"],
        "priorProjectorTokenFingerprintSha256": (
            "sha256:" + str(prior["fingerprint"])
        ),
        "revokeProjectorArgv": revoke_argv,
        "revokeProjectorCommandSucceeded": True,
        "preHistoryRecordCount": len(pre_history),
        "preHistoryLogSha256": pre_history_digest,
        "preHistoryRawSha256": (
            "sha256:" + hashlib.sha256(pre_history_bytes).hexdigest()
        ),
        "priorAbsentFromPreHistory": True,
        "postHistoryRecordCount": len(history),
        "postHistoryPrefixSha256": credential_history_log_digest(history[:-1]),
        "postHistoryPrefixRawSha256": (
            "sha256:"
            + hashlib.sha256(
                post_history_bytes[: len(pre_history_bytes)],
            ).hexdigest()
        ),
        "postHistoryLogSha256": credential_history_log_digest(history),
        "archiveAppendedExactlyOnce": True,
        "revokedHistorySequence": revoked["sequence"],
        "revokedLifecycleId": revoked["lifecycleId"],
        "revokedHistoryReceiptSha256": (
            "sha256:" + str(revoked["receiptDigest"])
        ),
        "revokedProjectorAt": revoked_projector["revokedAt"],
        "revokedProjectorPermissions": revoked_projector["permissions"],
        "newLifecycleId": current["lifecycleId"],
        "newCredentialReceiptSha256": current["receiptSha256"],
        "newProjectorTokenFingerprintSha256": (
            "sha256:" + str(current["fingerprint"])
        ),
        "newProjectorMintedAt": current["mintedAt"],
        "newProjectorExpiresAt": current["expiresAt"],
        "newProjectorPermissions": current["permissions"],
        "newAbsentFromPostHistory": True,
        "newAbsentFromPriorTransitions": True,
        "durableLifecycleTransition": True,
    }


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
        value = strict_json_loads(
            self.state_path.read_text(encoding="utf-8"),
        )
        if not isinstance(value, dict):
            raise RuntimeError("rehearsal host state is not an object")
        return value

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
        if unit == "paperclip-controlled-swarm.service":
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
    unit = RECOVERY_UNIT
    for required in (
        "paperclip-campaign-deadman.service",
        "paperclip-hermes-execution.service",
        "paperclip-controlled-swarm.service",
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
                    with paths.lock.open("a+", encoding="utf-8") as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX)
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
            if not platform.is_active("paperclip-controlled-swarm.service"):
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
            "outcome": "split_artifact_matrix_passed",
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
            fail_closed_fence(paths, platform)
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
        cleanup_one_use_approvals(paths)


def rehearse_exact_installed_wrapper(module: Any) -> dict[str, object]:
    """SIGKILL the installed commissioner and require wrapper-owned recovery."""

    paths = module.CommissioningPaths()
    platform = module.HostPlatform(paths)
    wrapper = INSTALLED_ROOT / "commission-controlled-swarm.sh"
    unit = RECOVERY_UNIT
    for required in (
        "paperclip-campaign-deadman.service",
        "paperclip-hermes-execution.service",
        "paperclip-controlled-swarm.service",
    ):
        if not platform.is_active(required):
            raise RuntimeError(
                f"exact-host rehearsal requires active inert topology: {required}",
            )
    if not wrapper.is_file():
        raise RuntimeError("exact installed commissioning wrapper is missing")
    if (
        run("systemctl", "is-enabled", unit, check=False).stdout.strip()
        == "masked"
    ):
        raise RuntimeError("installed commissioning recovery unit is masked")
    runtime_lines = paths.runtime_env.read_text(encoding="utf-8").splitlines()
    if runtime_lines.count(
        "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
    ) != 1 or platform.inspect_commissioned():
        raise RuntimeError(
            "exact-host rehearsal requires persisted and effective false barriers",
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
            "exact-host rehearsal refuses existing commissioning or epoch state",
        )

    commissioner = module.Commissioner(paths, platform)
    commissioner._require_protected_file(paths.token, "operator board token")
    token = paths.token.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("exact-host rehearsal board token is empty")
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
    unit_evidence = effective_unit_evidence()
    runtime_evidence = paperclip_runtime_evidence(paths)
    repository_before = repository_content_digest(PROJECT_REPOSITORY)
    invocation_ids: set[str] = set()
    phase_rows: list[dict[str, object]] = []
    try:
        for phase in module.ROLLBACK_JOURNAL_PHASES:
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
                    f"exact-host phase {phase} began with replayable state",
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
                    f"exact-host phase {phase} began with config drift",
                )

            now = dt.datetime.now(UTC)
            approval = {
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
            commissioner._write_protected_json(paths.approval, approval)
            before_unit = systemd_properties(
                unit,
                "InvocationID",
                "ExecMainStartTimestampMonotonic",
            )
            run("systemctl", "reset-failed", unit, check=False)
            wrapper_result = run(
                str(wrapper),
                "--rehearsal-crash-after-phase",
                phase,
                check=False,
            )
            if wrapper_result.returncode != 128 + signal.SIGKILL:
                raise RuntimeError(
                    f"exact installed commissioner did not SIGKILL at {phase}: "
                    f"exit={wrapper_result.returncode}",
                )
            execution = systemd_properties(
                unit,
                "ConditionResult",
                "Result",
                "InvocationID",
                "ExecMainCode",
                "ExecMainStatus",
                "ExecMainStartTimestamp",
                "ExecMainExitTimestamp",
                "ExecMainStartTimestampMonotonic",
                "ExecMainExitTimestampMonotonic",
            )
            condition = execution["ConditionResult"]
            result = execution["Result"]
            invocation_id = execution["InvocationID"]
            after_start = execution["ExecMainStartTimestampMonotonic"]
            if (
                condition != "yes"
                or result != "success"
                or execution["ExecMainCode"] not in {"exited", "1"}
                or execution["ExecMainStatus"] != "0"
                or not execution["ExecMainStartTimestamp"]
                or not execution["ExecMainExitTimestamp"]
                or after_start in ("", "0")
                or after_start == before_unit["ExecMainStartTimestampMonotonic"]
                or execution["ExecMainExitTimestampMonotonic"] in ("", "0")
                or not invocation_id
                or invocation_id == before_unit["InvocationID"]
                or invocation_id in invocation_ids
            ):
                raise RuntimeError(
                    f"installed wrapper did not execute bounded recovery for {phase} "
                    f"(execution={execution})",
                )
            invocation_ids.add(invocation_id)
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
                    f"exact-host recovery left phase {phase} replayable",
                )
            runtime_lines = paths.runtime_env.read_text(
                encoding="utf-8",
            ).splitlines()
            if runtime_lines.count(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
            ) != 1 or platform.inspect_commissioned():
                raise RuntimeError(
                    f"exact-host recovery left phase {phase} commissioned",
                )
            if not platform.is_active("paperclip-controlled-swarm.service"):
                raise RuntimeError(
                    f"exact-host recovery did not restore phase {phase} inert",
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
                    f"exact-host recovery did not restore phase {phase} configs",
                )

            run("systemctl", "reset-failed", unit, check=False)
            run("systemctl", "start", "--wait", unit)
            repeated = systemd_properties(
                unit,
                "ConditionResult",
                "InvocationID",
                "ExecMainStartTimestampMonotonic",
            )
            repeated_condition = repeated["ConditionResult"]
            repeated_start = repeated["ExecMainStartTimestampMonotonic"]
            if (
                repeated_condition != "no"
                or repeated_start != after_start
                or repeated["InvocationID"] != invocation_id
            ):
                raise RuntimeError(
                    f"exact-host recovery replayed phase {phase} without a journal",
                )
            credential = credential_lifecycle_evidence(
                platform,
                [
                    row["credentialLifecycle"]
                    for row in phase_rows
                    if isinstance(row.get("credentialLifecycle"), dict)
                ],
            )
            if paths.epoch.exists():
                raise RuntimeError(
                    f"credential boundary created a campaign epoch at {phase}",
                )
            phase_repository = repository_content_digest(PROJECT_REPOSITORY)
            if phase_repository != repository_before:
                raise RuntimeError(
                    f"exact-host phase {phase} mutated repository content",
                )
            phase_rows.append(
                {
                    "phase": phase,
                    "commissionerCrashSignal": "SIGKILL",
                    "wrapperExitCode": wrapper_result.returncode,
                    "wrapperStartedRecoveryUnit": True,
                    "conditionResult": condition,
                    "result": result,
                    "invocationId": invocation_id,
                    "execMainCode": execution["ExecMainCode"],
                    "execMainStatus": execution["ExecMainStatus"],
                    "execMainStartTimestamp": (
                        execution["ExecMainStartTimestamp"]
                    ),
                    "execMainExitTimestamp": execution["ExecMainExitTimestamp"],
                    "execMainStartTimestampMonotonic": after_start,
                    "execMainExitTimestampMonotonic": (
                        execution["ExecMainExitTimestampMonotonic"]
                    ),
                    "repeatedConditionResult": repeated_condition,
                    "repeatedInvocationId": repeated["InvocationID"],
                    "repeatedRecoveryNoOp": True,
                    "priorConfigsSha256": prior_digest,
                    "restoredConfigsSha256": restored_digest,
                    "persistedBarrier": "false",
                    "effectiveBarrier": "false",
                    "credentialLifecycle": credential,
                    "repositoryContentSha256": phase_repository,
                    "campaignEpochAbsent": not paths.epoch.exists(),
                },
            )
        repository_after = repository_content_digest(PROJECT_REPOSITORY)
        if repository_after != repository_before:
            raise RuntimeError("exact-host rehearsal mutated repository content")
        return {
            "systemdUnitExecuted": True,
            "installedWrapperExecuted": True,
            "realHostCommissionerSigkilled": True,
            "allDurablePhasesSigkilled": True,
            "wrapperStartedRecoveryUnit": True,
            "phaseMatrix": phase_rows,
            "priorConfigsSha256": prior_digest,
            "approvedImage": approved_image,
            "effectiveRecoveryUnit": unit_evidence,
            "paperclipRuntime": runtime_evidence,
            "repositoryContentBeforeSha256": repository_before,
            "repositoryContentAfterSha256": repository_after,
            "persistedBarrier": "false",
            "effectiveBarrier": "false",
            "repeatedRecoveryNoOp": True,
            "providersInvoked": False,
            "repositoriesMutated": False,
            "providerInvocationProof": {
                "campaignEpochAbsent": not paths.epoch.exists(),
                "admittedAgentsRemainPaused": True,
                "globalSchedulersRemainDisabled": runtime_evidence[
                    "globalSchedulersDisabled"
                ],
            },
        }
    except BaseException:
        journal_remains = paths.rollback_journal.exists()
        try:
            fail_closed_fence(paths, platform)
        except BaseException as fence_error:
            journal_status = (
                "the rollback journal remains for operator reconciliation"
                if journal_remains
                else "the recovery unit had already consumed the rollback journal"
            )
            raise RuntimeError(
                "exact-host rehearsal failed and its emergency runtime fence "
                f"also failed; {journal_status}",
            ) from fence_error
        raise
    finally:
        cleanup_one_use_approvals(paths)


def exact_host_proof_passed(
    module: Any,
    systemd_proof: dict[str, object],
    wrapper_proof: dict[str, object],
    *,
    corrupt_journal_refused: bool,
    rollback_failure_remained_dark: bool,
) -> bool:
    expected_phases = list(module.ROLLBACK_JOURNAL_PHASES)
    split_rows = systemd_proof.get("phaseMatrix")
    exact_rows = wrapper_proof.get("phaseMatrix")
    unit = wrapper_proof.get("effectiveRecoveryUnit")
    runtime = wrapper_proof.get("paperclipRuntime")
    provider = wrapper_proof.get("providerInvocationProof")
    invocation_ids = (
        [row.get("invocationId") for row in exact_rows]
        if isinstance(exact_rows, list)
        else []
    )
    credential_transitions = (
        [row.get("credentialLifecycle") for row in exact_rows]
        if isinstance(exact_rows, list)
        else []
    )
    active_lifecycle_chain = (
        [credential_transitions[0].get("priorLifecycleId")]
        + [
            transition.get("newLifecycleId")
            for transition in credential_transitions
        ]
        if credential_transitions
        and all(isinstance(value, dict) for value in credential_transitions)
        else []
    )
    active_fingerprint_chain = (
        [
            credential_transitions[0].get(
                "priorProjectorTokenFingerprintSha256",
            ),
        ]
        + [
            transition.get("newProjectorTokenFingerprintSha256")
            for transition in credential_transitions
        ]
        if credential_transitions
        and all(isinstance(value, dict) for value in credential_transitions)
        else []
    )
    archive_sequences = (
        [
            transition.get("revokedHistorySequence")
            for transition in credential_transitions
        ]
        if all(isinstance(value, dict) for value in credential_transitions)
        else []
    )
    return bool(
        corrupt_journal_refused
        and rollback_failure_remained_dark
        and systemd_proof.get("systemdUnitExecuted") is True
        and systemd_proof.get("outcome") == "split_artifact_matrix_passed"
        and isinstance(split_rows, list)
        and [row.get("phase") for row in split_rows] == expected_phases
        and wrapper_proof.get("systemdUnitExecuted") is True
        and wrapper_proof.get("installedWrapperExecuted") is True
        and wrapper_proof.get("realHostCommissionerSigkilled") is True
        and wrapper_proof.get("allDurablePhasesSigkilled") is True
        and wrapper_proof.get("wrapperStartedRecoveryUnit") is True
        and wrapper_proof.get("repeatedRecoveryNoOp") is True
        and wrapper_proof.get("persistedBarrier") == "false"
        and wrapper_proof.get("effectiveBarrier") == "false"
        and wrapper_proof.get("providersInvoked") is False
        and wrapper_proof.get("repositoriesMutated") is False
        and isinstance(wrapper_proof.get("approvedImage"), str)
        and "@sha256:" in wrapper_proof["approvedImage"]
        and is_sha256(wrapper_proof.get("repositoryContentBeforeSha256"))
        and wrapper_proof.get("repositoryContentBeforeSha256")
        == wrapper_proof.get("repositoryContentAfterSha256")
        and isinstance(unit, dict)
        and unit.get("unitFileState") == "enabled"
        and unit.get("fragmentPath") == str(INSTALLED_UNIT)
        and unit.get("dropInPaths") == []
        and unit.get("diskExecCommands") == [RECOVERY_EXEC_ARGV]
        and unit.get("diskConditions") == RECOVERY_CONDITIONS
        and unit.get("diskTimeoutStartSec") == 180
        and unit.get("diskTimeoutStopSec") == 180
        and unit.get("diskReadWritePaths") == RECOVERY_READ_WRITE_PATHS
        and unit.get("diskSecurityProperties")
        == RECOVERY_SECURITY_PROPERTIES
        and unit.get("loadedExecCommands") == [RECOVERY_EXEC_ARGV]
        and unit.get("loadedConditions") == RECOVERY_CONDITIONS
        and isinstance(unit.get("loadedConditionsRaw"), str)
        and bool(unit.get("loadedConditionsRaw"))
        and isinstance(unit.get("loadedTimeoutStartUSec"), str)
        and isinstance(unit.get("loadedTimeoutStopUSec"), str)
        and systemd_duration_matches(
            unit.get("loadedTimeoutStartUSec"),
            RECOVERY_TIMEOUT_START_USEC,
        )
        and systemd_duration_matches(
            unit.get("loadedTimeoutStopUSec"),
            RECOVERY_TIMEOUT_STOP_USEC,
        )
        and unit.get("loadedTimeoutStartMicroseconds")
        == RECOVERY_TIMEOUT_START_USEC
        and unit.get("loadedTimeoutStopMicroseconds")
        == RECOVERY_TIMEOUT_STOP_USEC
        and unit.get("loadedReadWritePaths") == RECOVERY_READ_WRITE_PATHS
        and unit.get("loadedSecurityProperties")
        == RECOVERY_LOADED_SECURITY_PROPERTIES
        and unit.get("canonicalExpectedSha256")
        == EXPECTED_RECOVERY_UNIT_SHA256
        and unit.get("fragmentSha256") == EXPECTED_RECOVERY_UNIT_SHA256
        and is_sha256(unit.get("loadedRawPropertiesSha256"))
        and unit.get("effectivePropertiesSha256")
        == loaded_unit_contract_digest(unit)
        and isinstance(runtime, dict)
        and runtime.get("approvedImage") == wrapper_proof.get("approvedImage")
        and all(
            is_sha256(runtime.get(field))
            for field in (
                "paperclipUnitSha256",
                "paperclipEffectivePropertiesSha256",
                "runtimeEnvSha256",
                "sidecarConfigSha256",
                "sidecarPolicySha256",
                "credentialBrokerSha256",
                "githubAppConfigSha256",
            )
        )
        and runtime.get("projectorPermissionsExpected")
        == PROJECTOR_PERMISSIONS
        and runtime.get("globalSchedulersDisabled") is True
        and runtime.get("credentialLifecycleCommands")
        == {
            "mint": "refresh-projector",
            "project": "rotate-projector",
            "clear": "clear-projector",
            "revoke": "revoke-projector",
        }
        and provider
        == {
            "campaignEpochAbsent": True,
            "admittedAgentsRemainPaused": True,
            "globalSchedulersRemainDisabled": True,
        }
        and isinstance(exact_rows, list)
        and [row.get("phase") for row in exact_rows] == expected_phases
        and len(active_lifecycle_chain) == len(credential_transitions) + 1
        and all(
            isinstance(value, str) and bool(value)
            for value in active_lifecycle_chain
        )
        and len(active_lifecycle_chain) == len(set(active_lifecycle_chain))
        and len(active_fingerprint_chain) == len(credential_transitions) + 1
        and all(is_sha256(value) for value in active_fingerprint_chain)
        and len(active_fingerprint_chain) == len(set(active_fingerprint_chain))
        and all(type(value) is int for value in archive_sequences)
        and all(
            archive_sequences[index - 1] < archive_sequences[index]
            for index in range(1, len(archive_sequences))
        )
        and len(archive_sequences) == len(set(archive_sequences))
        and all(
            isinstance(credential_transitions[index - 1], dict)
            and isinstance(credential_transitions[index], dict)
            and credential_transitions[index - 1].get("newLifecycleId")
            == credential_transitions[index].get("priorLifecycleId")
            and credential_transitions[index - 1].get(
                "newProjectorTokenFingerprintSha256",
            )
            == credential_transitions[index].get(
                "priorProjectorTokenFingerprintSha256",
            )
            and credential_transitions[index - 1].get(
                "postHistoryRecordCount",
            )
            == credential_transitions[index].get("preHistoryRecordCount")
            and credential_transitions[index - 1].get(
                "postHistoryLogSha256",
            )
            == credential_transitions[index].get("preHistoryLogSha256")
            for index in range(1, len(credential_transitions))
        )
        and all(isinstance(value, str) and value for value in invocation_ids)
        and len(invocation_ids) == len(set(invocation_ids))
        and all(
            row.get("commissionerCrashSignal") == "SIGKILL"
            and row.get("wrapperExitCode") == 128 + signal.SIGKILL
            and row.get("wrapperStartedRecoveryUnit") is True
            and row.get("conditionResult") == "yes"
            and row.get("result") == "success"
            and row.get("execMainCode") in {"exited", "1"}
            and row.get("execMainStatus") == "0"
            and isinstance(row.get("execMainStartTimestamp"), str)
            and bool(row.get("execMainStartTimestamp"))
            and isinstance(row.get("execMainExitTimestamp"), str)
            and bool(row.get("execMainExitTimestamp"))
            and str(row.get("execMainStartTimestampMonotonic")).isdigit()
            and str(row.get("execMainExitTimestampMonotonic")).isdigit()
            and int(str(row.get("execMainExitTimestampMonotonic")))
            >= int(str(row.get("execMainStartTimestampMonotonic")))
            and row.get("repeatedConditionResult") == "no"
            and row.get("repeatedInvocationId") == row.get("invocationId")
            and row.get("repeatedRecoveryNoOp") is True
            and row.get("persistedBarrier") == "false"
            and row.get("effectiveBarrier") == "false"
            and row.get("campaignEpochAbsent") is True
            and is_sha256(row.get("repositoryContentSha256"))
            and row.get("repositoryContentSha256")
            == wrapper_proof.get("repositoryContentBeforeSha256")
            and is_sha256(row.get("priorConfigsSha256"))
            and is_sha256(row.get("restoredConfigsSha256"))
            and row.get("priorConfigsSha256")
            == row.get("restoredConfigsSha256")
            and isinstance(row.get("credentialLifecycle"), dict)
            and is_sha256(
                row["credentialLifecycle"].get(
                    "priorCredentialReceiptSha256",
                ),
            )
            and is_sha256(
                row["credentialLifecycle"].get(
                    "priorProjectorTokenFingerprintSha256",
                ),
            )
            and is_sha256(
                row["credentialLifecycle"].get(
                    "revokedHistoryReceiptSha256",
                ),
            )
            and is_sha256(
                row["credentialLifecycle"].get(
                    "newCredentialReceiptSha256",
                ),
            )
            and is_sha256(
                row["credentialLifecycle"].get(
                    "newProjectorTokenFingerprintSha256",
                ),
            )
            and row["credentialLifecycle"].get("newProjectorPermissions")
            == PROJECTOR_PERMISSIONS
            and row["credentialLifecycle"].get(
                "revokedProjectorPermissions",
            )
            == PROJECTOR_PERMISSIONS
            and row["credentialLifecycle"].get(
                "revokeProjectorArgv",
            )
            == [str(GITHUB_BROKER), "revoke-projector"]
            and row["credentialLifecycle"].get(
                "revokeProjectorCommandSucceeded",
            )
            is True
            and isinstance(
                row["credentialLifecycle"].get("preHistoryRecordCount"),
                int,
            )
            and row["credentialLifecycle"].get("preHistoryRecordCount") >= 0
            and row["credentialLifecycle"].get("postHistoryRecordCount")
            == row["credentialLifecycle"].get("preHistoryRecordCount") + 1
            and row["credentialLifecycle"].get("revokedHistorySequence")
            == row["credentialLifecycle"].get("postHistoryRecordCount")
            and is_sha256(
                row["credentialLifecycle"].get("preHistoryLogSha256"),
            )
            and is_sha256(
                row["credentialLifecycle"].get("preHistoryRawSha256"),
            )
            and row["credentialLifecycle"].get("postHistoryPrefixSha256")
            == row["credentialLifecycle"].get("preHistoryLogSha256")
            and row["credentialLifecycle"].get(
                "postHistoryPrefixRawSha256",
            )
            == row["credentialLifecycle"].get("preHistoryRawSha256")
            and is_sha256(
                row["credentialLifecycle"].get("postHistoryLogSha256"),
            )
            and row["credentialLifecycle"].get(
                "priorAbsentFromPreHistory",
            )
            is True
            and row["credentialLifecycle"].get(
                "archiveAppendedExactlyOnce",
            )
            is True
            and row["credentialLifecycle"].get(
                "newAbsentFromPostHistory",
            )
            is True
            and row["credentialLifecycle"].get(
                "newAbsentFromPriorTransitions",
            )
            is True
            and row["credentialLifecycle"].get(
                "durableLifecycleTransition",
            )
            is True
            and row["credentialLifecycle"].get("priorLifecycleId")
            == row["credentialLifecycle"].get("revokedLifecycleId")
            and isinstance(
                row["credentialLifecycle"].get("revokedHistorySequence"),
                int,
            )
            and row["credentialLifecycle"].get("revokedHistorySequence") > 0
            and isinstance(
                row["credentialLifecycle"].get("revokedProjectorAt"),
                str,
            )
            and bool(row["credentialLifecycle"].get("revokedProjectorAt"))
            and row["credentialLifecycle"].get("priorLifecycleId")
            != row["credentialLifecycle"].get("newLifecycleId")
            and row["credentialLifecycle"].get(
                "priorProjectorTokenFingerprintSha256",
            )
            != row["credentialLifecycle"].get(
                "newProjectorTokenFingerprintSha256",
            )
            for row in exact_rows
        )
    )


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
    wrapper_proof = (
        rehearse_exact_installed_wrapper(module)
        if args.allow_source_root is None
        else {
            "systemdUnitExecuted": False,
            "installedWrapperExecuted": False,
            "realHostCommissionerSigkilled": False,
            "reason": "source-only harness; exact installed wrapper not executed",
        }
    )
    installed_matrix = systemd_proof["systemdUnitExecuted"] is True
    exact_host_proven = exact_host_proof_passed(
        module,
        systemd_proof,
        wrapper_proof,
        corrupt_journal_refused=corrupt_refused,
        rollback_failure_remained_dark=rollback_dark,
    )
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
        "splitArtifactMatrixPassed": installed_matrix,
        "gate2ExactTopologyClaimed": exact_host_proven,
        "phases": phases,
        "corruptJournalRefused": corrupt_refused,
        "rollbackFailureRemainedDark": rollback_dark,
        "installedSystemdProof": systemd_proof,
        "installedWrapperProof": wrapper_proof,
        "approvedImage": wrapper_proof.get("approvedImage"),
        "effectiveHostEvidence": {
            "recoveryUnit": wrapper_proof.get("effectiveRecoveryUnit"),
            "paperclipRuntime": wrapper_proof.get("paperclipRuntime"),
            "projectorPermissions": PROJECTOR_PERMISSIONS,
            "credentialLifecycleExpected": installed_matrix,
            "credentialMintRevokeReceipts": (
                [
                    row.get("credentialLifecycle")
                    for row in wrapper_proof.get("phaseMatrix", [])
                ]
                if isinstance(wrapper_proof.get("phaseMatrix"), list)
                else []
            ),
        },
        "providersInvoked": False,
        "productionStateMutated": installed_matrix,
        "outcome": (
            "exact_host_conjunctive_passed"
            if exact_host_proven
            else "split_artifact_matrix_passed"
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
