#!/usr/bin/env python3
"""Failure-atomic activation and rollback for the writable Git transport."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import time
from typing import Any


SCHEMA = "gloops.github-push-transport-activation.v1"
TRANSACTION_ROOT = Path("/var/lib/paperclip-gloops/github-push-transport-transactions")
SERVICE = "paperclip-github-push-broker.service"
HERMES_SERVICE = "paperclip-hermes-execution.service"
SOCKET = Path("/run/paperclip-github-broker/broker.sock")
INSTALL_ROOT = Path("/usr/local/lib/paperclip-gloops")
WORKSPACE_ROOT = Path("/opt/paperclip/hermes-execution-state/workspace")
WORKSPACE_ROOT_POLICY = {"uid": 0, "gid": 985, "mode": 0o3770}
ACTIVE_LINEAGE_FILENAME = "active-release.json"
ARTIFACTS = {
    "github-push-broker.py": INSTALL_ROOT / "github-push-broker.py",
    "github-app-credentials.py": INSTALL_ROOT / "github-app-credentials.py",
    "github-push-tool.bundle.cjs": INSTALL_ROOT / "tools/github-push-tool.bundle.cjs",
    "reconcile-governed-workspace.py": INSTALL_ROOT / "tools/reconcile-governed-workspace.py",
    "restore-hermes-workspace-observer.sh": INSTALL_ROOT / "restore-hermes-workspace-observer.sh",
}
ARTIFACT_MODES = {
    "github-push-broker.py": 0o555,
    "github-app-credentials.py": 0o755,
    "github-push-tool.bundle.cjs": 0o555,
    "reconcile-governed-workspace.py": 0o555,
    "restore-hermes-workspace-observer.sh": 0o755,
}


class ActivationError(RuntimeError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_digest(value: dict[str, Any]) -> str:
    unsigned = {key: item for key, item in value.items() if key != "receiptDigest"}
    return sha256_bytes(json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode())


def fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_write(path: Path, value: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp_fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        os.fchmod(tmp_fd, mode)
        os.fchown(tmp_fd, 0, 0)
        offset = 0
        while offset < len(value):
            written = os.write(tmp_fd, value[offset:])
            if written <= 0:
                raise OSError("short durable write")
            offset += written
        os.fsync(tmp_fd)
        os.close(tmp_fd)
        tmp_fd = -1
        os.replace(tmp, path)
        fsync_dir(path.parent)
    finally:
        if tmp_fd >= 0:
            os.close(tmp_fd)
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def read_regular(path: Path) -> tuple[bytes, os.stat_result]:
    flags = os.O_RDONLY | os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ActivationError(f"not a regular file: {path}")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(fd)
        identity = lambda item: (
            item.st_dev, item.st_ino, item.st_size, item.st_mode,
            item.st_uid, item.st_gid, item.st_mtime_ns, item.st_ctime_ns,
        )
        if identity(before) != identity(after):
            raise ActivationError(f"file changed while read: {path}")
        current = os.lstat(path)
        if stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) != (after.st_dev, after.st_ino):
            raise ActivationError(f"path changed while read: {path}")
        return b"".join(chunks), after
    finally:
        os.close(fd)


class Operations:
    def command(self, *argv: str) -> str:
        result = subprocess.run(argv, text=True, capture_output=True)
        if result.returncode != 0:
            raise ActivationError(f"command failed ({argv[0]}): {result.stderr.strip()}")
        return result.stdout.strip()

    def _unit_state(self, service: str) -> dict[str, str]:
        output = self.command(
            "systemctl", "show", service,
            "-p", "ActiveState", "-p", "SubState", "-p", "UnitFileState",
        )
        return dict(line.split("=", 1) for line in output.splitlines() if "=" in line)

    def service_state(self) -> dict[str, str]:
        broker = self._unit_state(SERVICE)
        hermes = self._unit_state(HERMES_SERVICE)
        return {
            **broker,
            "HermesActiveState": hermes.get("ActiveState", ""),
            "HermesSubState": hermes.get("SubState", ""),
            "HermesUnitFileState": hermes.get("UnitFileState", ""),
        }

    def stop(self, _prior: dict[str, str]) -> None:
        # Hermes Requires= the broker. Stop the dependent first so systemd
        # cannot cancel the broker job while activation is quiescing it.
        self.command("systemctl", "stop", HERMES_SERVICE)
        self.command("systemctl", "stop", SERVICE)

    def start(self, prior: dict[str, str]) -> None:
        if prior.get("ActiveState") == "active":
            self.command("systemctl", "reset-failed", SERVICE)
            self.command("systemctl", "start", SERVICE)
        if prior.get("HermesActiveState") == "active":
            self.command("systemctl", "reset-failed", HERMES_SERVICE)
            self.command("systemctl", "start", HERMES_SERVICE)

    def quiescent(self, broker: Path) -> None:
        self.command(str(broker), "verify-journal")
        self.command(str(broker), "assert-quiescent")

    def healthy(self, broker: Path, expected: dict[str, str]) -> None:
        state = self.service_state()
        if state.get("ActiveState") != "active" or state.get("SubState") != "running":
            raise ActivationError(f"broker is not active/running: {state}")
        if expected.get("HermesActiveState") == "active" and (
            state.get("HermesActiveState") != "active"
            or state.get("HermesSubState") != "running"
        ):
            raise ActivationError(f"Hermes is not active/running: {state}")
        for _ in range(30):
            if SOCKET.is_socket():
                break
            time.sleep(0.1)
        else:
            raise ActivationError("broker socket is not ready")


def verify_service_prestate(prior: dict[str, str], ops: Operations) -> None:
    current = ops.service_state()
    for key in (
        "ActiveState", "SubState", "UnitFileState",
        "HermesActiveState", "HermesSubState", "HermesUnitFileState",
    ):
        if current.get(key) != prior.get(key):
            raise ActivationError(f"service state was not restored for {key}: {current}")


def validate_transaction_dir(path: Path, root: Path) -> Path:
    root = root.resolve(strict=True)
    if path.parent.resolve(strict=True) != root or path.name in {"", ".", ".."}:
        raise ActivationError(f"transaction dir must be one direct child of {root}")
    if path.exists() or path.is_symlink():
        raise ActivationError(f"transaction dir already exists: {path}")
    path.mkdir(mode=0o700)
    fsync_dir(root)
    return path


def prepare_transaction_root(root: Path, *, test_mode: bool) -> Path:
    if not test_mode and root != TRANSACTION_ROOT:
        raise ActivationError(f"production transaction root must be {TRANSACTION_ROOT}")
    if test_mode:
        return root.resolve(strict=True)
    parent = root.parent
    for component in (Path("/"), Path("/var"), Path("/var/lib"), parent):
        metadata = os.lstat(component)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise ActivationError(f"unsafe transaction-root ancestor: {component}")
        if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) & 0o022:
            raise ActivationError(f"untrusted transaction-root ancestor: {component}")
    if root.is_symlink():
        raise ActivationError("transaction root is a symlink")
    if not root.exists():
        root.mkdir(mode=0o700)
        fsync_dir(parent)
    metadata = os.lstat(root)
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise ActivationError("transaction root must be root-owned mode 0700")
    return root.resolve(strict=True)


def source_packet(source_dir: Path, expected: dict[str, str]) -> dict[str, dict[str, Any]]:
    packet: dict[str, dict[str, Any]] = {}
    for name in ARTIFACTS:
        source = source_dir / name
        value, metadata = read_regular(source)
        digest = sha256_bytes(value)
        if digest != expected.get(name):
            raise ActivationError(f"reviewed sha256 mismatch for {name}")
        packet[name] = {"bytes": value, "sha256": digest, "mode": ARTIFACT_MODES[name], "uid": 0, "gid": 0}
    return packet


def snapshot_workspace_root(path: Path) -> dict[str, Any]:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        current = os.lstat(path)
        if stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ActivationError("workspace root path identity changed")
        return {
            "path": str(path), "device": metadata.st_dev, "inode": metadata.st_ino,
            "uid": metadata.st_uid, "gid": metadata.st_gid, "mode": stat.S_IMODE(metadata.st_mode),
        }
    finally:
        os.close(descriptor)


def set_workspace_root_metadata(snapshot: dict[str, Any], target: dict[str, int]) -> dict[str, Any]:
    path = Path(snapshot["path"])
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        current = os.lstat(path)
        expected_identity = (snapshot["device"], snapshot["inode"])
        if stat.S_ISLNK(current.st_mode) or (before.st_dev, before.st_ino) != expected_identity or (
            current.st_dev, current.st_ino
        ) != expected_identity:
            raise ActivationError("workspace root identity differs from activation snapshot")
        mutation_attempted = True
        try:
            os.fchown(descriptor, target["uid"], target["gid"])
            os.fchmod(descriptor, target["mode"])
            observed = os.fstat(descriptor)
            if (observed.st_uid, observed.st_gid, stat.S_IMODE(observed.st_mode)) != (
                target["uid"], target["gid"], target["mode"],
            ):
                raise ActivationError("workspace root metadata could not be proved")
            final = os.lstat(path)
            if stat.S_ISLNK(final.st_mode) or (final.st_dev, final.st_ino) != expected_identity:
                raise ActivationError("workspace root identity changed during metadata activation")
            return {
                "path": str(path), "device": observed.st_dev, "inode": observed.st_ino,
                "uid": observed.st_uid, "gid": observed.st_gid, "mode": stat.S_IMODE(observed.st_mode),
            }
        except BaseException:
            if mutation_attempted:
                os.fchown(descriptor, before.st_uid, before.st_gid)
                os.fchmod(descriptor, stat.S_IMODE(before.st_mode))
            raise
    finally:
        os.close(descriptor)


def snapshot_installed(
    transaction: Path,
    artifacts: dict[str, Path],
    workspace_root: Path,
    prior_active_lineage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    snapshots: dict[str, Any] = {}
    backup = transaction / "backup"
    backup.mkdir(mode=0o700)
    fsync_dir(transaction)
    for name, target in artifacts.items():
        if target.is_symlink():
            raise ActivationError(f"installed target is a symlink: {target}")
        if not target.exists():
            snapshots[name] = {"target": str(target), "existed": False}
            continue
        value, metadata = read_regular(target)
        backup_path = backup / name
        durable_write(backup_path, value, 0o600)
        snapshots[name] = {
            "target": str(target), "existed": True, "backup": str(backup_path),
            "sha256": sha256_bytes(value), "mode": stat.S_IMODE(metadata.st_mode),
            "uid": metadata.st_uid, "gid": metadata.st_gid,
        }
    manifest = {
        "schema": SCHEMA,
        "artifacts": snapshots,
        "workspaceRoot": snapshot_workspace_root(workspace_root),
        "priorActiveLineage": prior_active_lineage,
    }
    manifest["receiptDigest"] = canonical_digest(manifest)
    durable_write(transaction / "backup.json", json.dumps(manifest, sort_keys=True).encode() + b"\n")
    return manifest


def install_packet(packet: dict[str, dict[str, Any]], artifacts: dict[str, Path]) -> None:
    for name, target in artifacts.items():
        target.parent.mkdir(mode=0o555, parents=True, exist_ok=True)
        durable_write(target, packet[name]["bytes"], packet[name]["mode"])
        os.chown(target, packet[name]["uid"], packet[name]["gid"])
        os.chmod(target, packet[name]["mode"])
        fsync_file(target)
        fsync_dir(target.parent)
        if sha256_bytes(read_regular(target)[0]) != packet[name]["sha256"]:
            raise ActivationError(f"installed sha256 mismatch for {name}")


def restore(manifest: dict[str, Any]) -> None:
    for name in reversed(list(ARTIFACTS)):
        item = manifest["artifacts"][name]
        target = Path(item["target"])
        if item["existed"]:
            value, _metadata = read_regular(Path(item["backup"]))
            if sha256_bytes(value) != item["sha256"]:
                raise ActivationError(f"backup sha256 mismatch for {name}")
            durable_write(target, value, item["mode"])
            os.chown(target, item["uid"], item["gid"])
            os.chmod(target, item["mode"])
            fsync_file(target)
            fsync_dir(target.parent)
        else:
            if target.is_symlink():
                raise ActivationError(f"refusing to remove symlink target for {name}")
            try:
                target.unlink()
                fsync_dir(target.parent)
            except FileNotFoundError:
                pass
    set_workspace_root_metadata(manifest["workspaceRoot"], {
        "uid": manifest["workspaceRoot"]["uid"],
        "gid": manifest["workspaceRoot"]["gid"],
        "mode": manifest["workspaceRoot"]["mode"],
    })


def verify_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("schema") != SCHEMA or manifest.get("receiptDigest") != canonical_digest(manifest):
        raise ActivationError("backup manifest digest is invalid")
    for name in ARTIFACTS:
        item = manifest["artifacts"].get(name)
        if not isinstance(item, dict) or item.get("target") != str(ARTIFACTS[name]):
            raise ActivationError(f"backup target mismatch for {name}")
    workspace = manifest.get("workspaceRoot")
    if not isinstance(workspace, dict) or workspace.get("path") != str(WORKSPACE_ROOT):
        raise ActivationError("backup workspace-root binding is invalid")
    prior_lineage = manifest.get("priorActiveLineage")
    if prior_lineage is not None and (
        not isinstance(prior_lineage, dict)
        or prior_lineage.get("schema") != SCHEMA
        or prior_lineage.get("receiptDigest") != canonical_digest(prior_lineage)
    ):
        raise ActivationError("backup prior active-lineage binding is invalid")


def verify_restored(manifest: dict[str, Any]) -> None:
    for name in ARTIFACTS:
        item = manifest["artifacts"][name]
        target = Path(item["target"])
        if not item["existed"]:
            if target.exists() or target.is_symlink():
                raise ActivationError(f"absent target was not restored for {name}")
            continue
        value, metadata = read_regular(target)
        observed = (sha256_bytes(value), stat.S_IMODE(metadata.st_mode), metadata.st_uid, metadata.st_gid)
        expected = (item["sha256"], item["mode"], item["uid"], item["gid"])
        if observed != expected:
            raise ActivationError(f"restored metadata mismatch for {name}")
    workspace = snapshot_workspace_root(Path(manifest["workspaceRoot"]["path"]))
    for key in ("path", "device", "inode", "uid", "gid", "mode"):
        if workspace[key] != manifest["workspaceRoot"][key]:
            raise ActivationError("restored workspace-root metadata mismatch")


def installed_artifact_evidence(artifacts: dict[str, Path]) -> dict[str, dict[str, Any]]:
    evidence: dict[str, dict[str, Any]] = {}
    for name, target in artifacts.items():
        value, metadata = read_regular(target)
        evidence[name] = {
            "target": str(target),
            "sha256": sha256_bytes(value),
            "mode": stat.S_IMODE(metadata.st_mode),
            "uid": metadata.st_uid,
            "gid": metadata.st_gid,
        }
    return evidence


def restored_artifact_evidence(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    evidence: dict[str, dict[str, Any]] = {}
    for name in ARTIFACTS:
        item = manifest["artifacts"][name]
        if not item["existed"]:
            evidence[name] = {"target": item["target"], "existed": False}
            continue
        current = installed_artifact_evidence({name: Path(item["target"])})[name]
        evidence[name] = {**current, "existed": True}
    return evidence


def verify_workspace_evidence(expected: dict[str, Any]) -> dict[str, Any]:
    observed = snapshot_workspace_root(Path(expected["path"]))
    for key in ("path", "device", "inode", "uid", "gid", "mode"):
        if observed.get(key) != expected.get(key):
            raise ActivationError("workspace-root terminal evidence has drifted")
    return observed


def active_lineage_path(root: Path) -> Path:
    return root / ACTIVE_LINEAGE_FILENAME


def read_active_lineage(root: Path, *, required: bool = True) -> dict[str, Any] | None:
    path = active_lineage_path(root)
    try:
        value, metadata = read_regular(path)
    except FileNotFoundError:
        if required:
            raise ActivationError("active release lineage is unavailable")
        return None
    if root == TRANSACTION_ROOT and (
        metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise ActivationError("active release lineage is not root-owned mode 0600")
    try:
        lineage = json.loads(value)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ActivationError("active release lineage is invalid") from error
    if lineage.get("schema") != SCHEMA or lineage.get("receiptDigest") != canonical_digest(lineage):
        raise ActivationError("active release lineage digest is invalid")
    return lineage


def write_active_lineage(root: Path, transaction: Path, activation: dict[str, Any]) -> dict[str, Any]:
    lineage = {
        "schema": SCHEMA,
        "transactionDir": str(transaction.resolve(strict=True)),
        "activationReceiptDigest": activation["receiptDigest"],
        "reviewedHead": activation["reviewedHead"],
        "installedArtifacts": activation["installedArtifacts"],
        "workspaceRoot": activation["workspaceRoot"],
    }
    lineage["receiptDigest"] = canonical_digest(lineage)
    durable_write(
        active_lineage_path(root),
        json.dumps(lineage, sort_keys=True).encode() + b"\n",
    )
    return lineage


def clear_active_lineage_if_matches(root: Path, transaction: Path) -> bool:
    lineage = read_active_lineage(root, required=False)
    if lineage is None or lineage.get("transactionDir") != str(transaction.resolve(strict=True)):
        return False
    path = active_lineage_path(root)
    path.unlink()
    fsync_dir(root)
    return True


def restore_prior_active_lineage(root: Path, transaction: Path, manifest: dict[str, Any]) -> None:
    prior = manifest.get("priorActiveLineage")
    current = read_active_lineage(root, required=False)
    transaction_dir = str(transaction.resolve(strict=True))
    if current is not None and current.get("transactionDir") == transaction_dir:
        active_lineage_path(root).unlink()
        fsync_dir(root)
        current = None
    if current is not None:
        if prior is None or current != prior:
            raise ActivationError("active release lineage changed during rollback")
        return
    if prior is not None:
        durable_write(
            active_lineage_path(root),
            json.dumps(prior, sort_keys=True).encode() + b"\n",
        )


def verify_current_activation(
    root: Path,
    transaction: Path,
    activation: dict[str, Any],
    ops: Operations,
) -> dict[str, Any]:
    lineage = read_active_lineage(root)
    expected_lineage = {
        "transactionDir": str(transaction.resolve(strict=True)),
        "activationReceiptDigest": activation["receiptDigest"],
        "reviewedHead": activation["reviewedHead"],
        "installedArtifacts": activation["installedArtifacts"],
        "workspaceRoot": activation["workspaceRoot"],
    }
    for key, expected in expected_lineage.items():
        if lineage.get(key) != expected:
            raise ActivationError("selected transaction is not the active release lineage")
    active_artifacts = activation["installedArtifacts"]
    if not isinstance(active_artifacts, dict) or not active_artifacts:
        raise ActivationError("active release artifact evidence is invalid")
    if set(active_artifacts) - set(ARTIFACTS):
        raise ActivationError("active release contains an unknown artifact")
    active_contract: dict[str, Path] = {}
    for name, evidence in active_artifacts.items():
        if not isinstance(evidence, dict) or evidence.get("target") != str(ARTIFACTS[name]):
            raise ActivationError("active release artifact target has drifted")
        active_contract[name] = ARTIFACTS[name]
    if installed_artifact_evidence(active_contract) != active_artifacts:
        raise ActivationError("active release artifact evidence has drifted")
    if snapshot_workspace_root(WORKSPACE_ROOT) != activation["workspaceRoot"]:
        raise ActivationError("active release workspace-root evidence has drifted")
    current_service = ops.service_state()
    if current_service != activation["priorServiceState"]:
        raise ActivationError("active release service state has drifted")
    return lineage


def verify_existing_active_lineage(root: Path, lineage: dict[str, Any], ops: Operations) -> None:
    transaction = Path(str(lineage.get("transactionDir", "")))
    if (
        transaction.parent.resolve(strict=True) != root
        or not transaction.is_dir()
        or transaction.is_symlink()
    ):
        raise ActivationError("active release transaction binding is invalid")
    activation_path = transaction / "activation-receipt.json"
    if not activation_path.is_file():
        raise ActivationError("active release activation receipt is unavailable")
    activation = json.loads(activation_path.read_text())
    if (
        activation.get("receiptDigest") != canonical_digest(activation)
        or lineage.get("activationReceiptDigest") != activation["receiptDigest"]
    ):
        raise ActivationError("active release activation receipt binding is invalid")
    verify_current_activation(root, transaction, activation, ops)


def write_receipt(transaction: Path, disposition: str, payload: dict[str, Any], filename: str) -> dict[str, Any]:
    receipt = {"schema": SCHEMA, "disposition": disposition, **payload}
    receipt["receiptDigest"] = canonical_digest(receipt)
    durable_write(transaction / filename, json.dumps(receipt, sort_keys=True).encode() + b"\n")
    return receipt


def write_state(transaction: Path, phase: str, payload: dict[str, Any]) -> dict[str, Any]:
    state = {"schema": SCHEMA, "phase": phase, **payload}
    state["receiptDigest"] = canonical_digest(state)
    durable_write(transaction / "activation-state.json", json.dumps(state, sort_keys=True).encode() + b"\n")
    return state


def read_state(transaction: Path) -> dict[str, Any]:
    state = json.loads((transaction / "activation-state.json").read_text())
    if state.get("schema") != SCHEMA or state.get("receiptDigest") != canonical_digest(state):
        raise ActivationError(f"invalid activation state: {transaction}")
    return state


def rollback_transaction(
    transaction: Path,
    manifest: dict[str, Any],
    prior: dict[str, str],
    ops: Operations,
    *,
    automatic: bool,
    claim_digest: str | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    candidate_quiescent = False
    restored_artifacts: dict[str, dict[str, Any]] | None = None
    restored_workspace: dict[str, Any] | None = None
    try:
        ops.stop(prior)
        # Once candidate admission has opened, rollback must prove that its
        # durable journal has no work before restoring potentially older code.
        ops.quiescent(ARTIFACTS["github-push-broker.py"])
        candidate_quiescent = True
        restore(manifest)
        verify_restored(manifest)
        if prior.get("ActiveState") == "active":
            ops.start(prior)
            ops.healthy(ARTIFACTS["github-push-broker.py"], prior)
        verify_service_prestate(prior, ops)
        # Hermes ExecStartPost is allowed to enforce workspace policy. The
        # terminal proof must therefore be observed after both units start.
        verify_restored(manifest)
        restored_artifacts = restored_artifact_evidence(manifest)
        restored_workspace = verify_workspace_evidence(manifest["workspaceRoot"])
        restore_prior_active_lineage(transaction.parent, transaction, manifest)
        disposition = "rolled_back"
    except BaseException as error:
        errors.append(type(error).__name__)
        disposition = "rollback_failed"
    receipt = write_receipt(transaction, disposition, {
        "automatic": automatic, "backupDigest": manifest["receiptDigest"],
        "priorServiceState": prior, "rollbackErrors": errors,
        "candidateQuiescent": candidate_quiescent,
        "restoredArtifacts": restored_artifacts,
        "workspaceRoot": restored_workspace,
        **({"claimDigest": claim_digest} if claim_digest else {}),
    }, "rollback-receipt.json")
    if errors:
        write_state(transaction, "reconciliation_required", {
            "backupDigest": manifest["receiptDigest"], "priorServiceState": prior,
            "rollbackReceiptDigest": receipt["receiptDigest"],
        })
        raise ActivationError("rollback failed; reconciliation required")
    write_state(transaction, "rolled_back", {
        "backupDigest": manifest["receiptDigest"], "priorServiceState": prior,
        "rollbackReceiptDigest": receipt["receiptDigest"],
    })
    return receipt


def recover_incomplete_transactions(root: Path, ops: Operations) -> list[str]:
    recovered: list[str] = []
    for transaction in sorted(path for path in root.iterdir() if path.is_dir() and not path.is_symlink()):
        state_path = transaction / "activation-state.json"
        if not state_path.exists():
            continue
        state = read_state(transaction)
        phase = state.get("phase")
        if phase in {"activated", "rolled_back"}:
            continue
        if phase == "reconciliation_required":
            raise ActivationError(f"unresolved activation transaction: {transaction}")
        if phase not in {"mutation_started", "rollback_started"}:
            raise ActivationError(f"unknown nonterminal activation phase: {transaction}")
        manifest = json.loads((transaction / "backup.json").read_text())
        verify_manifest(manifest)
        if state.get("backupDigest") != manifest["receiptDigest"]:
            raise ActivationError(f"activation state backup binding is invalid: {transaction}")
        if phase == "rollback_started":
            activation_path = transaction / "activation-receipt.json"
            if not activation_path.is_file():
                raise ActivationError(f"explicit rollback activation receipt is unavailable: {transaction}")
            activation = json.loads(activation_path.read_text())
            if (
                activation.get("receiptDigest") != canonical_digest(activation)
                or activation.get("backupDigest") != manifest["receiptDigest"]
                or state.get("activationReceiptDigest") != activation["receiptDigest"]
            ):
                raise ActivationError(f"explicit rollback activation binding is invalid: {transaction}")
            claim_path = transaction / "rollback-claim.json"
            claim_digest = state.get("rollbackClaimDigest")
            if claim_path.exists():
                claim = json.loads(claim_path.read_text())
                if (
                    claim.get("receiptDigest") != canonical_digest(claim)
                    or claim.get("backupDigest") != manifest["receiptDigest"]
                    or claim.get("activationDigest") != activation["receiptDigest"]
                    or (claim_digest is not None and claim_digest != claim["receiptDigest"])
                ):
                    raise ActivationError(f"explicit rollback claim binding is invalid: {transaction}")
            else:
                if claim_digest is not None:
                    raise ActivationError(f"explicit rollback claim is unavailable: {transaction}")
                claim = write_receipt(transaction, "rollback_claimed", {
                    "backupDigest": manifest["receiptDigest"],
                    "activationDigest": activation["receiptDigest"],
                }, "rollback-claim.json")
            claim_digest = claim["receiptDigest"]
            if state.get("rollbackClaimDigest") != claim_digest:
                write_state(transaction, "rollback_started", {
                    "backupDigest": manifest["receiptDigest"],
                    "priorServiceState": state["priorServiceState"],
                    "activationReceiptDigest": activation["receiptDigest"],
                    "rollbackClaimDigest": claim_digest,
                })
            rollback_transaction(
                transaction, manifest, state["priorServiceState"], ops,
                automatic=False, claim_digest=claim_digest,
            )
        else:
            rollback_transaction(
                transaction, manifest, state["priorServiceState"], ops, automatic=True,
            )
        recovered.append(str(transaction))
    return recovered


def activate(args: argparse.Namespace, ops: Operations | None = None) -> dict[str, Any]:
    if os.geteuid() != 0 and not getattr(args, "test_mode", False):
        raise ActivationError("activation must run as root")
    ops = ops or Operations()
    if not isinstance(args.reviewed_head, str) or len(args.reviewed_head) != 40 or any(
        character not in "0123456789abcdef" for character in args.reviewed_head
    ):
        raise ActivationError("reviewed head must be exact lowercase 40-hex")
    test_mode = getattr(args, "test_mode", False)
    workspace_root = Path(getattr(args, "workspace_root", WORKSPACE_ROOT)) if test_mode else WORKSPACE_ROOT
    workspace_policy = getattr(args, "workspace_root_policy", WORKSPACE_ROOT_POLICY) if test_mode else WORKSPACE_ROOT_POLICY
    packet = source_packet(Path(args.source_dir), args.expected)
    transaction_root = prepare_transaction_root(Path(args.transaction_root), test_mode=test_mode)
    lock_path = transaction_root / ".activation.lock"
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        recovered_transactions = recover_incomplete_transactions(transaction_root, ops)
        prior = ops.service_state()
        if prior.get("ActiveState") != "active" or prior.get("SubState") != "running":
            raise ActivationError("broker must be active/running before activation")
        prior_active_lineage = read_active_lineage(transaction_root, required=False)
        if prior_active_lineage is not None:
            verify_existing_active_lineage(transaction_root, prior_active_lineage, ops)
        transaction = validate_transaction_dir(Path(args.transaction_dir), transaction_root)
        manifest = snapshot_installed(
            transaction, ARTIFACTS, workspace_root, prior_active_lineage,
        )
        write_state(transaction, "mutation_started", {
            "backupDigest": manifest["receiptDigest"], "priorServiceState": prior,
            "reviewedHead": args.reviewed_head, "recoveredTransactions": recovered_transactions,
        })
        try:
            ops.stop(prior)
            # Stop closes admission; this second proof establishes no prepared
            # or leased publication remains before any installed byte changes.
            ops.quiescent(ARTIFACTS["github-push-broker.py"])
            activated_workspace_root = set_workspace_root_metadata(manifest["workspaceRoot"], workspace_policy)
            install_packet(packet, ARTIFACTS)
            ops.start(prior)
            ops.healthy(ARTIFACTS["github-push-broker.py"], prior)
            verify_service_prestate(prior, ops)
            observed = installed_artifact_evidence(ARTIFACTS)
            final_workspace_root = verify_workspace_evidence(activated_workspace_root)
            receipt = write_receipt(transaction, "activated", {
                "backupDigest": manifest["receiptDigest"], "priorServiceState": prior,
                "reviewedHead": args.reviewed_head, "installedArtifacts": observed,
                "workspaceRoot": final_workspace_root,
                "recoveredTransactions": recovered_transactions,
            }, "activation-receipt.json")
            write_active_lineage(transaction_root, transaction, receipt)
            write_state(transaction, "activated", {
                "backupDigest": manifest["receiptDigest"], "priorServiceState": prior,
                "activationReceiptDigest": receipt["receiptDigest"],
            })
            return receipt
        except BaseException:
            rollback_transaction(transaction, manifest, prior, ops, automatic=True)
            raise
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


def explicit_rollback(args: argparse.Namespace, ops: Operations | None = None) -> dict[str, Any]:
    if os.geteuid() != 0 and not getattr(args, "test_mode", False):
        raise ActivationError("rollback must run as root")
    ops = ops or Operations()
    root = prepare_transaction_root(
        Path(args.transaction_root), test_mode=getattr(args, "test_mode", False)
    )
    lock_path = root / ".activation.lock"
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return explicit_rollback_locked(args, ops, root)
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


def reconcile_rollback(args: argparse.Namespace, ops: Operations | None = None) -> dict[str, Any]:
    if os.geteuid() != 0 and not getattr(args, "test_mode", False):
        raise ActivationError("reconciliation must run as root")
    ops = ops or Operations()
    root = prepare_transaction_root(
        Path(args.transaction_root), test_mode=getattr(args, "test_mode", False)
    )
    lock_path = root / ".activation.lock"
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        transaction = Path(args.transaction_dir)
        if (
            transaction.parent.resolve(strict=True) != root
            or not transaction.is_dir()
            or transaction.is_symlink()
        ):
            raise ActivationError("invalid transaction dir")
        state = read_state(transaction)
        if state.get("phase") != "reconciliation_required":
            raise ActivationError("transaction does not require reconciliation")
        manifest = json.loads((transaction / "backup.json").read_text())
        verify_manifest(manifest)
        if state.get("backupDigest") != manifest["receiptDigest"]:
            raise ActivationError("reconciliation backup binding is invalid")
        rollback = json.loads((transaction / "rollback-receipt.json").read_text())
        if (
            rollback.get("receiptDigest") != canonical_digest(rollback)
            or rollback.get("disposition") != "rollback_failed"
            or rollback.get("backupDigest") != manifest["receiptDigest"]
            or state.get("rollbackReceiptDigest") != rollback["receiptDigest"]
        ):
            raise ActivationError("failed rollback receipt binding is invalid")
        prior = state["priorServiceState"]
        verify_restored(manifest)
        verify_service_prestate(prior, ops)
        restored_artifacts = restored_artifact_evidence(manifest)
        restored_workspace = verify_workspace_evidence(manifest["workspaceRoot"])
        restore_prior_active_lineage(root, transaction, manifest)
        receipt = write_receipt(transaction, "reconciled_rolled_back", {
            "backupDigest": manifest["receiptDigest"],
            "failedRollbackDigest": rollback["receiptDigest"],
            "priorServiceState": prior,
            "restoredArtifacts": restored_artifacts,
            "workspaceRoot": restored_workspace,
        }, "reconciliation-receipt.json")
        write_state(transaction, "rolled_back", {
            "backupDigest": manifest["receiptDigest"],
            "priorServiceState": prior,
            "rollbackReceiptDigest": rollback["receiptDigest"],
            "reconciliationReceiptDigest": receipt["receiptDigest"],
        })
        return receipt
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


def explicit_rollback_locked(
    args: argparse.Namespace,
    ops: Operations,
    root: Path,
) -> dict[str, Any]:
    transaction = Path(args.transaction_dir)
    if transaction.parent.resolve(strict=True) != root or not transaction.is_dir() or transaction.is_symlink():
        raise ActivationError("invalid transaction dir")
    activation_path = transaction / "activation-receipt.json"
    if not activation_path.is_file():
        raise ActivationError("activation receipt is unavailable")
    if (transaction / "rollback-claim.json").exists() or (transaction / "rollback-receipt.json").exists():
        raise ActivationError("rollback already claimed or completed")
    manifest = json.loads((transaction / "backup.json").read_text())
    verify_manifest(manifest)
    activation = json.loads(activation_path.read_text())
    if (
        activation.get("receiptDigest") != canonical_digest(activation)
        or activation.get("backupDigest") != manifest["receiptDigest"]
        or not isinstance(activation.get("installedArtifacts"), dict)
        or not isinstance(activation.get("workspaceRoot"), dict)
    ):
        raise ActivationError("activation receipt binding is invalid")
    verify_current_activation(root, transaction, activation, ops)
    prior = activation["priorServiceState"]
    write_state(transaction, "rollback_started", {
        "backupDigest": manifest["receiptDigest"], "priorServiceState": prior,
        "activationReceiptDigest": activation["receiptDigest"],
        "rollbackClaimDigest": None,
    })
    claim = write_receipt(transaction, "rollback_claimed", {
        "backupDigest": manifest["receiptDigest"], "activationDigest": activation["receiptDigest"],
    }, "rollback-claim.json")
    write_state(transaction, "rollback_started", {
        "backupDigest": manifest["receiptDigest"], "priorServiceState": prior,
        "activationReceiptDigest": activation["receiptDigest"],
        "rollbackClaimDigest": claim["receiptDigest"],
    })
    return rollback_transaction(
        transaction,
        manifest,
        prior,
        ops,
        automatic=False,
        claim_digest=claim["receiptDigest"],
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("command", choices=("activate", "rollback", "reconcile"))
    result.add_argument("--transaction-dir", required=True)
    result.add_argument("--transaction-root", default=str(TRANSACTION_ROOT))
    result.add_argument("--source-dir")
    result.add_argument("--reviewed-head")
    for name in ARTIFACTS:
        result.add_argument(f"--expected-{name.replace('.', '-').replace('_', '-')}-sha256")
    return result


def main() -> int:
    args = parser().parse_args()
    args.expected = {
        name: getattr(args, f"expected_{name.replace('.', '_').replace('-', '_')}_sha256")
        for name in ARTIFACTS
    }
    try:
        if args.command == "activate":
            receipt = activate(args)
        elif args.command == "rollback":
            receipt = explicit_rollback(args)
        else:
            receipt = reconcile_rollback(args)
        print(json.dumps(receipt, sort_keys=True))
        return 0
    except (ActivationError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"github-push-transport-activation: {error}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
