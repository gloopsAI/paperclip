#!/usr/bin/env python3
"""Fail-closed install/rollback for the narrow public webhook receiver."""

from __future__ import annotations

import argparse
import base64
import errno
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = pathlib.Path("/var/lib/paperclip-gloops/webhook-receiver-transactions")
RECEIVER = pathlib.Path("/usr/local/lib/paperclip-gloops/github-webhook-receiver.py")
UNIT = pathlib.Path("/etc/systemd/system/paperclip-github-webhook-receiver.service")
SECRET = pathlib.Path("/etc/paperclip-gloops/github-webhook-hmac")
CADDY = pathlib.Path("/etc/caddy/Caddyfile")
ALLOWED_CADDY_CONFIGS = frozenset(
    {
        pathlib.Path("/etc/caddy/Caddyfile"),
        pathlib.Path("/etc/caddy/Caddyfile.tailnet"),
    }
)
SERVICE = "paperclip-github-webhook-receiver.service"
CADDY_SERVICE = "caddy.service"
MARKER = "# BEGIN GLOOPS PAPERCLIP GITHUB WEBHOOK"
MAX_FILE_BYTES = 8 * 1024 * 1024
HEALTH_MAX_ATTEMPTS = 30
HEALTH_INTERVAL_SECONDS = 0.25
HMAC_SECRET_RE = re.compile(rb"^[A-Za-z0-9._~+/=-]{32,256}$")
PLUGIN_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PLUGIN_ID_PLACEHOLDER = b"__PAPERCLIP_PLUGIN_ID__"


class ReadinessError(RuntimeError):
    def __init__(self, summary: dict[str, object]):
        super().__init__("receiver readiness exhausted")
        self.summary = summary


class RollbackPhaseError(RuntimeError):
    def __init__(self, phase: str):
        super().__init__(f"rollback failed during {phase}")
        self.phase = phase


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def fsync_dir(path: pathlib.Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def trusted_root_directory(path: pathlib.Path, *, exact_mode: int | None = None) -> os.stat_result:
    """Require a canonical root-owned, non-writable directory chain."""
    resolved = path.resolve(strict=True)
    if resolved != path:
        raise RuntimeError(f"directory is not canonical: {path}")
    current = pathlib.Path("/")
    for component in path.parts[1:]:
        current /= component
        metadata = os.lstat(current)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError(f"unsafe directory: {current}")
        if metadata.st_uid != 0 or metadata.st_gid != 0:
            raise RuntimeError(f"directory is not root-owned: {current}")
        if stat.S_IMODE(metadata.st_mode) & 0o022:
            raise RuntimeError(f"directory is writable outside root: {current}")
    metadata = os.lstat(path)
    if exact_mode is not None and stat.S_IMODE(metadata.st_mode) != exact_mode:
        raise RuntimeError(f"directory mode is not {oct(exact_mode)}: {path}")
    return metadata


def ensure_private_directory(path: pathlib.Path) -> None:
    trusted_root_directory(path.parent)
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        os.mkdir(path, 0o700)
        fsync_dir(path.parent)
    else:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError(f"unsafe private directory: {path}")
    trusted_root_directory(path, exact_mode=0o700)


def read_regular_with_metadata(path: pathlib.Path) -> tuple[bytes, os.stat_result]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError(f"not a regular file: {path}")
        value = b""
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            value += chunk
            if len(value) > MAX_FILE_BYTES:
                raise RuntimeError(f"file too large: {path}")
        after = os.fstat(fd)
        identity = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mode,
            before.st_uid,
            before.st_gid,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        if identity != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mode,
            after.st_uid,
            after.st_gid,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise RuntimeError(f"file changed while reading: {path}")
        leaf = os.lstat(path)
        if stat.S_ISLNK(leaf.st_mode) or (
            leaf.st_dev,
            leaf.st_ino,
            leaf.st_mode,
            leaf.st_uid,
            leaf.st_gid,
            leaf.st_size,
            leaf.st_mtime_ns,
            leaf.st_ctime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_mode,
            after.st_uid,
            after.st_gid,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise RuntimeError(f"path changed while reading: {path}")
        return value, after
    finally:
        os.close(fd)


def read_regular(path: pathlib.Path) -> bytes:
    return read_regular_with_metadata(path)[0]


def snapshot(path: pathlib.Path) -> dict[str, object]:
    try:
        value, metadata = read_regular_with_metadata(path)
    except FileNotFoundError:
        return {"path": str(path), "existed": False}
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise RuntimeError(f"unsafe snapshot target: {path}") from error
        raise
    return {
        "path": str(path),
        "existed": True,
        "bytesBase64": base64.b64encode(value).decode(),
        "sha256": sha256(value),
        "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
    }


def atomic_write(path: pathlib.Path, value: bytes, mode: int, uid: int = 0, gid: int = 0) -> None:
    trusted_root_directory(path.parent)
    try:
        current = os.lstat(path)
    except FileNotFoundError:
        current = None
    if current is not None and (stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode)):
        raise RuntimeError(f"unsafe write target: {path}")
    temporary = path.parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        try:
            offset = 0
            while offset < len(value):
                offset += os.write(fd, value[offset:])
            os.fchmod(fd, mode)
            os.fchown(fd, uid, gid)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, path)
        fsync_dir(path.parent)
    except Exception:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def restore(entry: dict[str, object]) -> None:
    path = pathlib.Path(str(entry["path"]))
    if entry["existed"]:
        atomic_write(
            path,
            base64.b64decode(str(entry["bytesBase64"]), validate=True),
            int(entry["mode"]),
            int(entry["uid"]),
            int(entry["gid"]),
        )
    else:
        try:
            current = os.lstat(path)
            if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode):
                raise RuntimeError(f"refusing unsafe removal: {path}")
            path.unlink()
            fsync_dir(path.parent)
        except FileNotFoundError:
            pass


def patch_caddy(current: bytes, route: bytes) -> bytes:
    text = current.decode("utf-8")
    route_text = route.decode("utf-8").strip("\n")
    if MARKER in text:
        raise RuntimeError("managed webhook route already exists")
    site_start = text.find("hermes.gloops.ai {")
    if site_start < 0:
        raise RuntimeError("public Hermes site not found")
    opening = text.find("{", site_start)
    depth = 0
    closing = -1
    for index in range(opening, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                closing = index
                break
    if closing < 0:
        raise RuntimeError("public Hermes site is malformed")
    site_body = text[opening + 1:closing]
    auth = site_body.find("\n\tbasicauth /* {")
    if auth < 0:
        raise RuntimeError("public Hermes protection block not found")
    prefix = site_body[:auth].rstrip("\n")
    protected = site_body[auth:].strip("\n")
    if "reverse_proxy 127.0.0.1:3100" not in protected:
        raise RuntimeError("public Hermes upstream not found")
    indented = "\n".join("\t" + line if line else line for line in protected.splitlines())
    replacement = (
        prefix
        + "\n\n"
        + route_text
        + "\n\n\thandle {\n"
        + indented
        + "\n\t}\n"
    )
    return (text[:opening + 1] + replacement + text[closing:]).encode()


def render_unit(template: bytes, plugin_id: str) -> bytes:
    if PLUGIN_ID_RE.fullmatch(plugin_id) is None:
        raise RuntimeError("Paperclip plugin id is invalid")
    if template.count(PLUGIN_ID_PLACEHOLDER) != 1:
        raise RuntimeError("receiver unit must contain exactly one plugin id placeholder")
    return template.replace(PLUGIN_ID_PLACEHOLDER, plugin_id.encode("ascii"))


def run(*command: str) -> None:
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {command[0]} ({result.returncode})")


def resolve_effective_caddy_config() -> pathlib.Path:
    result = subprocess.run(
        ["systemctl", "show", CADDY_SERVICE, "-p", "ExecStart", "--value"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("effective Caddy command is unavailable")
    matches = re.findall(r"(?:^|\s)--config(?:=|\s+)(/[^\s;]+)", result.stdout)
    if len(matches) != 1:
        raise RuntimeError("effective Caddy command must contain exactly one absolute config")
    config = pathlib.Path(matches[0])
    if config not in ALLOWED_CADDY_CONFIGS:
        raise RuntimeError("effective Caddy config is outside the allowlist")
    return config


def caddy_uses_admin_off(value: bytes) -> bool:
    return re.search(rb"(?m)^\s*admin\s+off\s*(?:#.*)?$", value) is not None


def activate_caddy(value: bytes) -> str:
    action = "restart" if caddy_uses_admin_off(value) else "reload"
    run("systemctl", action, CADDY_SERVICE)
    run("systemctl", "is-active", "--quiet", CADDY_SERVICE)
    return action


def service_state() -> dict[str, bool]:
    active = subprocess.run(["systemctl", "is-active", "--quiet", SERVICE]).returncode == 0
    enabled = subprocess.run(["systemctl", "is-enabled", "--quiet", SERVICE]).returncode == 0
    return {"active": active, "enabled": enabled}


def write_json(path: pathlib.Path, value: dict[str, object]) -> None:
    atomic_write(path, (json.dumps(value, sort_keys=True, indent=2) + "\n").encode(), 0o600)


def validate_caddy(value: bytes) -> None:
    with tempfile.NamedTemporaryFile(prefix="gloops-caddy-", dir=ROOT, delete=False) as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
        candidate = handle.name
    try:
        run("caddy", "validate", "--adapter", "caddyfile", "--config", candidate)
    finally:
        os.unlink(candidate)
        fsync_dir(ROOT)


def health() -> None:
    with urllib.request.urlopen("http://127.0.0.1:8766/healthz", timeout=5) as response:
        if response.status != 200 or json.load(response) != {"status": "ready"}:
            raise RuntimeError("receiver health failed")


def wait_for_health(
    *,
    max_attempts: int = HEALTH_MAX_ATTEMPTS,
    interval_seconds: float = HEALTH_INTERVAL_SECONDS,
) -> dict[str, object]:
    started = time.monotonic()
    for attempt in range(1, max_attempts + 1):
        try:
            health()
            return {
                "attempts": attempt,
                "elapsedMs": max(0, round((time.monotonic() - started) * 1000)),
                "outcome": "ready",
            }
        except Exception:
            if attempt < max_attempts:
                time.sleep(interval_seconds)
    summary = {
        "attempts": max_attempts,
        "elapsedMs": max(0, round((time.monotonic() - started) * 1000)),
        "outcome": "exhausted",
    }
    raise ReadinessError(summary)


def ensure_root() -> None:
    if os.geteuid() != 0:
        raise SystemExit("root required")
    ensure_private_directory(ROOT)
    for parent in {RECEIVER.parent, UNIT.parent, SECRET.parent, CADDY.parent}:
        trusted_root_directory(parent)


def install(args: argparse.Namespace) -> None:
    ensure_root()
    caddy = resolve_effective_caddy_config()
    trusted_root_directory(caddy.parent)
    receiver = read_regular(pathlib.Path(args.receiver_source))
    unit_template = read_regular(pathlib.Path(args.unit_source))
    unit = render_unit(unit_template, args.plugin_id)
    route = read_regular(pathlib.Path(args.route_source))
    secret = sys.stdin.buffer.read(4097)
    if secret.endswith(b"\n"):
        secret = secret[:-1]
    if HMAC_SECRET_RE.fullmatch(secret) is None:
        raise RuntimeError("candidate secret length invalid")
    compile(receiver, str(RECEIVER), "exec")
    current_caddy = read_regular(caddy)
    candidate_caddy = patch_caddy(current_caddy, route)
    validate_caddy(candidate_caddy)
    tx = ROOT / args.transaction_id
    tx.mkdir(mode=0o700)
    fsync_dir(ROOT)
    backup = {
        "schema": "gloops.github-webhook-receiver-backup.v1",
        "transactionId": args.transaction_id,
        "caddyConfigPath": str(caddy),
        "priorService": service_state(),
        "artifacts": [snapshot(path) for path in (RECEIVER, UNIT, SECRET, caddy)],
        "candidate": {
            "receiverSha256": sha256(receiver),
            "unitSha256": sha256(unit),
            "caddySha256": sha256(candidate_caddy),
            "secretSha256": sha256(secret),
            "pluginId": args.plugin_id,
        },
    }
    write_json(tx / "backup.json", backup)
    phase = "write_receiver"
    readiness: dict[str, object] | None = None
    try:
        atomic_write(RECEIVER, receiver, 0o555)
        phase = "write_unit"
        atomic_write(UNIT, unit, 0o444)
        phase = "write_secret"
        atomic_write(SECRET, secret, 0o400)
        phase = "write_caddy"
        caddy_entry = next(entry for entry in backup["artifacts"] if entry["path"] == str(caddy))
        atomic_write(
            caddy,
            candidate_caddy,
            int(caddy_entry["mode"]),
            int(caddy_entry["uid"]),
            int(caddy_entry["gid"]),
        )
        phase = "systemd_reload"
        run("systemctl", "daemon-reload")
        phase = "receiver_start"
        run("systemctl", "enable", "--now", SERVICE)
        phase = "receiver_readiness"
        readiness = wait_for_health()
        phase = "caddy_activation"
        caddy_action = activate_caddy(candidate_caddy)
        receipt = {
            "schema": "gloops.github-webhook-receiver-deployment-receipt.v1",
            "status": "activated",
            "transactionId": args.transaction_id,
            "caddyConfigPath": str(caddy),
            "caddyAction": caddy_action,
            "receiverReadiness": readiness,
            **backup["candidate"],
        }
        phase = "receipt_write"
        write_json(tx / "receipt.json", receipt)
        print(json.dumps({"status": "activated", "transactionDir": str(tx)}, sort_keys=True))
    except Exception as error:
        rollback_failed_phase = None
        try:
            rollback_backup(backup)
            status = "rolled_back"
            rollback_error_class = None
        except Exception as rollback_error:
            status = "rollback_failed"
            rollback_error_class = type(rollback_error).__name__
            if isinstance(rollback_error, RollbackPhaseError):
                rollback_failed_phase = rollback_error.phase
        receipt = {
            "schema": "gloops.github-webhook-receiver-deployment-receipt.v1",
            "status": status,
            "transactionId": args.transaction_id,
            "errorClass": type(error).__name__,
            "failedPhase": phase,
        }
        if isinstance(error, ReadinessError):
            receipt["receiverReadiness"] = error.summary
        if rollback_error_class is not None:
            receipt["rollbackErrorClass"] = rollback_error_class
            if rollback_failed_phase is not None:
                receipt["rollbackFailedPhase"] = rollback_failed_phase
        write_json(tx / "receipt.json", receipt)
        raise RuntimeError(f"receiver deployment {status}") from error


def rollback_backup(backup: dict[str, object]) -> None:
    phase = "receiver_stop"
    try:
        subprocess.run(["systemctl", "stop", SERVICE], check=False, stdout=subprocess.DEVNULL)
        if subprocess.run(["systemctl", "is-active", "--quiet", SERVICE]).returncode == 0:
            raise RuntimeError("candidate receiver did not stop")
        subprocess.run(["systemctl", "disable", SERVICE], check=False, stdout=subprocess.DEVNULL)
        phase = "artifact_restore"
        for artifact in reversed(list(backup["artifacts"])):
            restore(artifact)
        phase = "systemd_reload"
        run("systemctl", "daemon-reload")
        phase = "caddy_restore_activation"
        caddy_path = pathlib.Path(str(backup["caddyConfigPath"]))
        caddy_entry = next(entry for entry in backup["artifacts"] if entry["path"] == str(caddy_path))
        prior_caddy = base64.b64decode(str(caddy_entry["bytesBase64"]), validate=True)
        activate_caddy(prior_caddy)
        phase = "prior_service_restore"
        prior = backup["priorService"]
        if prior["enabled"]:
            run("systemctl", "enable", SERVICE)
        if prior["active"]:
            run("systemctl", "start", SERVICE)
        if service_state() != prior:
            raise RuntimeError("prior receiver service state was not restored")
        phase = "restoration_proof"
        for expected in backup["artifacts"]:
            actual = snapshot(pathlib.Path(str(expected["path"])))
            for key in ("existed", "sha256", "mode", "uid", "gid"):
                if expected.get(key) != actual.get(key):
                    raise RuntimeError(f"restoration proof failed: {expected['path']}")
    except Exception as error:
        raise RollbackPhaseError(phase) from error


def rollback(args: argparse.Namespace) -> None:
    ensure_root()
    tx = ROOT / args.transaction_id
    if tx.parent != ROOT:
        raise RuntimeError("transaction directory invalid")
    trusted_root_directory(tx, exact_mode=0o700)
    if (tx / "rollback-receipt.json").exists() or (tx / "rollback-failure-receipt.json").exists():
        raise RuntimeError("transaction already rolled back")
    claim = tx / "rollback-claim.json"
    fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.write(fd, b'{"status":"claimed"}\n')
    os.fsync(fd)
    os.close(fd)
    fsync_dir(tx)
    try:
        backup = json.loads(read_regular(tx / "backup.json"))
        if not isinstance(backup, dict):
            raise RuntimeError("backup receipt is not an object")
        rollback_backup(backup)
        receipt = {
            "schema": "gloops.github-webhook-receiver-rollback-receipt.v1",
            "status": "restored",
            "transactionId": args.transaction_id,
        }
        write_json(tx / "rollback-receipt.json", receipt)
        print(json.dumps({"status": "restored", "transactionDir": str(tx)}, sort_keys=True))
    except Exception as error:
        failure = {
            "schema": "gloops.github-webhook-receiver-rollback-receipt.v1",
            "status": "rollback_failed",
            "transactionId": args.transaction_id,
            "errorClass": type(error).__name__,
        }
        if isinstance(error, RollbackPhaseError):
            failure["failedPhase"] = error.phase
        write_json(tx / "rollback-failure-receipt.json", failure)
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    install_parser = sub.add_parser("install")
    install_parser.add_argument("--transaction-id", required=True)
    install_parser.add_argument("--receiver-source", required=True)
    install_parser.add_argument("--unit-source", required=True)
    install_parser.add_argument("--route-source", required=True)
    install_parser.add_argument("--plugin-id", required=True)
    rollback_parser = sub.add_parser("rollback")
    rollback_parser.add_argument("--transaction-id", required=True)
    args = parser.parse_args()
    if not re_full_transaction(args.transaction_id):
        raise SystemExit("transaction id invalid")
    install(args) if args.command == "install" else rollback(args)


def re_full_transaction(value: str) -> bool:
    return re.fullmatch(r"tx-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,48}", value) is not None


if __name__ == "__main__":
    main()
