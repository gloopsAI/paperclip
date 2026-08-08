#!/usr/bin/env python3
"""Root-owned, non-renewing execution epoch broker for bounded campaigns."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import signal
import socket
import stat
import subprocess
import threading
import time
from typing import Any, Callable


SCHEMA_VERSION = "gloops.campaign-deadman.v1"
MAX_REQUEST_BYTES = 16 * 1024
UTC = dt.timezone.utc

# The campaign duration is how long the control plane is permitted to run
# unsupervised: `paperclip-gloops` and `paperclip-hermes-execution` are BindsTo
# this unit, so the plane stops when the epoch lapses. The duration is therefore
# an enforced invariant, not a tuning knob, and it stays bounded on both ends.
#
# The floor keeps an epoch long enough to be an execution window rather than a
# restart loop. The ceiling is the load-bearing half: it is what guarantees a
# human must re-authorize the plane periodically. An unbounded (or absent)
# maximum would let the dead-man be configured so that it never fires, which is
# the same as having no dead-man at all.
MIN_CAMPAIGN_DURATION_SECONDS = 1 * 60 * 60  # 1 hour
MAX_CAMPAIGN_DURATION_SECONDS = 30 * 24 * 60 * 60  # 30 days
DEFAULT_CAMPAIGN_DURATION_SECONDS = 24 * 60 * 60  # 24 hours


def utc_iso(value: dt.datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_utc(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return parsed.astimezone(UTC)


def canonical_json(value: dict[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


class DeadmanError(RuntimeError):
    pass


def validate_duration_seconds(value: object) -> int:
    """Return the campaign duration, or refuse anything outside the bounded range."""
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not MIN_CAMPAIGN_DURATION_SECONDS <= value <= MAX_CAMPAIGN_DURATION_SECONDS
    ):
        raise DeadmanError(
            "campaign duration must be a whole number of seconds between "
            f"{MIN_CAMPAIGN_DURATION_SECONDS} and {MAX_CAMPAIGN_DURATION_SECONDS} "
            f"inclusive, received {value!r}",
        )
    return value


class CampaignEpochStore:
    def __init__(
        self,
        *,
        state_dir: pathlib.Path,
        campaign_id: str,
        duration_seconds: int,
        require_immutable: bool,
        now: Callable[[], dt.datetime] = lambda: dt.datetime.now(UTC),
    ) -> None:
        duration_seconds = validate_duration_seconds(duration_seconds)
        self.state_dir = state_dir
        self.campaign_id = campaign_id
        self.duration_seconds = duration_seconds
        self.require_immutable = require_immutable
        self.now = now
        self.campaign_dir = self.state_dir / self.campaign_id
        self.epoch_path = self.campaign_dir / "epoch.json"
        self.stop_receipt_path = self.campaign_dir / "stop-invoked.json"
        self._lock = threading.Lock()

    def _validate_path(self, path: pathlib.Path) -> None:
        file_stat = path.stat()
        if file_stat.st_uid != 0 and self.require_immutable:
            raise DeadmanError(f"{path} is not root-owned")
        if stat.S_IMODE(file_stat.st_mode) != 0o600:
            raise DeadmanError(f"{path} is not mode 0600")

    def _is_immutable(self, path: pathlib.Path) -> bool:
        result = subprocess.run(
            ["/usr/bin/lsattr", "-d", str(path)],
            check=False,
            capture_output=True,
            text=True,
        )
        return result.returncode == 0 and "i" in result.stdout.split(maxsplit=1)[0]

    def _load(self) -> dict[str, Any] | None:
        if not self.epoch_path.exists():
            return None
        self._validate_path(self.epoch_path)
        if self.require_immutable and not self._is_immutable(self.epoch_path):
            raise DeadmanError("campaign epoch is not immutable")
        try:
            epoch = json.loads(self.epoch_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise DeadmanError(f"campaign epoch is unreadable: {error}") from error
        required = {
            "schemaVersion",
            "campaignId",
            "companyId",
            "firstRunId",
            "firstAdmittedAt",
            "deadlineAt",
            "durationSeconds",
            "epochSha256",
        }
        if not isinstance(epoch, dict) or set(epoch) != required:
            raise DeadmanError("campaign epoch has an invalid schema")
        digest_input = {key: value for key, value in epoch.items() if key != "epochSha256"}
        expected_digest = f"sha256:{hashlib.sha256(canonical_json(digest_input)).hexdigest()}"
        if (
            epoch["schemaVersion"] != SCHEMA_VERSION
            or epoch["campaignId"] != self.campaign_id
            or epoch["durationSeconds"] != self.duration_seconds
            or epoch["epochSha256"] != expected_digest
        ):
            raise DeadmanError("campaign epoch failed integrity validation")
        admitted_at = parse_utc(epoch["firstAdmittedAt"])
        deadline = parse_utc(epoch["deadlineAt"])
        if deadline - admitted_at != dt.timedelta(seconds=self.duration_seconds):
            raise DeadmanError("campaign epoch duration has drifted")
        return epoch

    def _create(self, *, company_id: str, run_id: str) -> dict[str, Any]:
        self.campaign_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.require_immutable:
            os.chown(self.campaign_dir, 0, 0)
        os.chmod(self.campaign_dir, 0o700)
        admitted_at = self.now().astimezone(UTC)
        epoch: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "campaignId": self.campaign_id,
            "companyId": company_id,
            "firstRunId": run_id,
            "firstAdmittedAt": utc_iso(admitted_at),
            "deadlineAt": utc_iso(
                admitted_at + dt.timedelta(seconds=self.duration_seconds),
            ),
            "durationSeconds": self.duration_seconds,
        }
        epoch["epochSha256"] = f"sha256:{hashlib.sha256(canonical_json(epoch)).hexdigest()}"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
        fd = os.open(self.epoch_path, flags, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as handle:
                handle.write(canonical_json(epoch) + b"\n")
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            os.close(fd)
        if self.require_immutable:
            os.chown(self.epoch_path, 0, 0)
        os.chmod(self.epoch_path, 0o600)
        dir_fd = os.open(self.campaign_dir, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
        if self.require_immutable:
            subprocess.run(
                ["/usr/bin/chattr", "+i", str(self.epoch_path)],
                check=True,
            )
        return self._load() or epoch

    def status(self) -> dict[str, Any]:
        with self._lock:
            epoch = self._load()
            if epoch is None:
                return {
                    "schemaVersion": SCHEMA_VERSION,
                    "allowed": True,
                    "status": "unarmed",
                    "campaignId": self.campaign_id,
                    "durationSeconds": self.duration_seconds,
                }
            expired = self.now() >= parse_utc(epoch["deadlineAt"])
            return {
                **epoch,
                "allowed": not expired,
                "status": "expired" if expired else "active",
            }

    def admit(self, *, company_id: str, run_id: str) -> dict[str, Any]:
        with self._lock:
            epoch = self._load()
            if epoch is None:
                epoch = self._create(company_id=company_id, run_id=run_id)
                status = "armed"
            else:
                status = "active"
            if epoch["companyId"] != company_id:
                raise DeadmanError("campaign is bound to a different company")
            if self.now() >= parse_utc(epoch["deadlineAt"]):
                raise DeadmanError("campaign epoch has expired")
            return {**epoch, "allowed": True, "status": status}

    def record_stop_invocation(self, *, reason: str) -> bool:
        with self._lock:
            if self.stop_receipt_path.exists():
                self._validate_path(self.stop_receipt_path)
                return False
            receipt = {
                "schemaVersion": SCHEMA_VERSION,
                "campaignId": self.campaign_id,
                "reason": reason,
                "invokedAt": utc_iso(self.now()),
            }
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
            fd = os.open(self.stop_receipt_path, flags, 0o600)
            try:
                os.write(fd, canonical_json(receipt) + b"\n")
                os.fsync(fd)
            finally:
                os.close(fd)
            if self.require_immutable:
                os.chown(self.stop_receipt_path, 0, 0)
            os.chmod(self.stop_receipt_path, 0o600)
            return True


class DeadmanServer:
    def __init__(
        self,
        *,
        store: CampaignEpochStore,
        socket_path: pathlib.Path,
        socket_uid: int = 0,
        socket_gid: int,
        stop_command: str,
    ) -> None:
        self.store = store
        self.socket_path = socket_path
        self.socket_uid = socket_uid
        self.socket_gid = socket_gid
        self.stop_command = stop_command
        self.stopping = threading.Event()
        self.stop_lock = threading.Lock()
        self.server_socket: socket.socket | None = None

    def _invoke_stop_if_expired(self) -> None:
        with self.stop_lock:
            try:
                status = self.store.status()
                if status["status"] != "expired" or self.store.stop_receipt_path.exists():
                    return
                result = subprocess.run(
                    [self.stop_command, "campaign_epoch_expired"],
                    check=False,
                )
                if result.returncode == 0:
                    self.store.record_stop_invocation(reason="campaign_epoch_expired")
                else:
                    print(
                        f"campaign deadman stop actuator returned {result.returncode}",
                        flush=True,
                    )
            except Exception as error:  # fail closed and keep retrying the actuator
                print(f"campaign deadman stop check failed: {error}", flush=True)

    def _monitor(self) -> None:
        while not self.stopping.wait(1):
            self._invoke_stop_if_expired()

    def _respond(self, connection: socket.socket, response: dict[str, Any]) -> None:
        connection.sendall(canonical_json(response) + b"\n")

    def _handle(self, connection: socket.socket) -> None:
        payload = b""
        while b"\n" not in payload and len(payload) <= MAX_REQUEST_BYTES:
            chunk = connection.recv(4096)
            if not chunk:
                break
            payload += chunk
        if len(payload) > MAX_REQUEST_BYTES:
            raise DeadmanError("request exceeded the size limit")
        try:
            request = json.loads(payload.split(b"\n", 1)[0])
            if not isinstance(request, dict):
                raise DeadmanError("request must be an object")
            if (
                request.get("schemaVersion") != SCHEMA_VERSION
                or request.get("campaignId") != self.store.campaign_id
            ):
                raise DeadmanError("request does not match the configured campaign")
            operation = request.get("operation")
            if operation == "status":
                response = self.store.status()
            elif operation == "admit":
                company_id = request.get("companyId")
                run_id = request.get("runId")
                if not isinstance(company_id, str) or not company_id:
                    raise DeadmanError("companyId is required")
                if not isinstance(run_id, str) or not run_id:
                    raise DeadmanError("runId is required")
                response = self.store.admit(company_id=company_id, run_id=run_id)
            else:
                raise DeadmanError("operation is unsupported")
        except (DeadmanError, ValueError, json.JSONDecodeError) as error:
            response = {
                "schemaVersion": SCHEMA_VERSION,
                "allowed": False,
                "status": "denied",
                "campaignId": self.store.campaign_id,
                "reason": str(error),
            }
        self._respond(connection, response)

    def serve(self) -> None:
        self.socket_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        if self.socket_path.exists() or self.socket_path.is_socket():
            self.socket_path.unlink()
        server_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server_socket = server_socket
        server_socket.bind(str(self.socket_path))
        os.chown(self.socket_path, self.socket_uid, self.socket_gid)
        os.chmod(self.socket_path, 0o660)
        server_socket.listen(16)
        server_socket.settimeout(1)
        monitor = threading.Thread(target=self._monitor, daemon=True)
        monitor.start()
        self._invoke_stop_if_expired()
        while not self.stopping.is_set():
            try:
                connection, _ = server_socket.accept()
            except TimeoutError:
                continue
            with connection:
                try:
                    self._handle(connection)
                except Exception as error:
                    self._respond(connection, {
                        "schemaVersion": SCHEMA_VERSION,
                        "allowed": False,
                        "status": "denied",
                        "campaignId": self.store.campaign_id,
                        "reason": f"broker failure: {error}",
                    })
        monitor.join(timeout=2)
        server_socket.close()
        self.socket_path.unlink(missing_ok=True)

    def stop(self, *_args: object) -> None:
        self.stopping.set()


def duration_seconds_argument(raw: str) -> int:
    """argparse adapter so the CLI refuses exactly what CampaignEpochStore refuses."""
    try:
        parsed = int(raw, 10)
    except ValueError:
        parsed = raw  # type: ignore[assignment]  # reported verbatim below
    try:
        return validate_duration_seconds(parsed)
    except DeadmanError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=pathlib.Path, required=True)
    parser.add_argument("--socket", type=pathlib.Path, required=True)
    parser.add_argument("--socket-gid", type=int, required=True)
    parser.add_argument("--campaign-id", required=True)
    parser.add_argument(
        "--duration-seconds",
        type=duration_seconds_argument,
        default=DEFAULT_CAMPAIGN_DURATION_SECONDS,
    )
    parser.add_argument("--stop-command", required=True)
    parser.add_argument("--allow-non-immutable-for-test", action="store_true")
    args = parser.parse_args()
    store = CampaignEpochStore(
        state_dir=args.state_dir,
        campaign_id=args.campaign_id,
        duration_seconds=args.duration_seconds,
        require_immutable=not args.allow_non_immutable_for_test,
    )
    server = DeadmanServer(
        store=store,
        socket_path=args.socket,
        socket_gid=args.socket_gid,
        stop_command=args.stop_command,
    )
    signal.signal(signal.SIGTERM, server.stop)
    signal.signal(signal.SIGINT, server.stop)
    server.serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
