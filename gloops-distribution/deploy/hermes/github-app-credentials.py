#!/usr/bin/env python3
"""Mint, project, verify, and revoke bounded GitHub App installation tokens.

The App private key never leaves the root-owned host boundary. Hermes receives
one repository-scoped write token through its read-only gh config mount. The
Paperclip trusted projector receives a separately minted read-only token through
Paperclip's encrypted secret store. No token is printed or placed in argv.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from uuid import UUID, uuid4
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


CONFIG = Path("/etc/paperclip-gloops/github-app.json")
RUNTIME = Path("/run/paperclip-gloops")
HERMES_TOKEN = RUNTIME / "hermes-github-token"
PROJECTOR_TOKEN = RUNTIME / "projector-github-token"
PROJECTOR_ROTATED = RUNTIME / "projector-token-rotated"
HERMES_HOSTS = Path("/opt/paperclip/hermes-execution-profile/gh/hosts.yml")
RECEIPT = RUNTIME / "credential-receipt.json"
HISTORY = Path("/var/lib/paperclip-gloops/credential-history.jsonl")
API_BASE = "https://api.github.com"

WRITE_PERMISSIONS = {
    "checks": "read",
    "contents": "write",
    "issues": "read",
    "pull_requests": "write",
    "statuses": "read",
}
READ_PERMISSIONS = {
    "checks": "read",
    "contents": "read",
    "issues": "read",
    "pull_requests": "read",
    "statuses": "read",
}


class CredentialError(RuntimeError):
    pass


class CredentialRetentionError(CredentialError):
    """A minted token could not be validated or revoked; caller must retain it."""

    def __init__(self, token: str):
        super().__init__("GitHub installation token cleanup failed; a root cleanup handle is required")
        self.token = token


def load_config() -> dict[str, object]:
    raw = json.loads(CONFIG.read_text())
    required = {
        "appId",
        "installationId",
        "repositoryId",
        "repository",
        "privateKeyPath",
        "boardTokenPath",
    }
    if set(raw) != required:
        raise CredentialError("GitHub App config keys do not match the allowlist")
    if raw["repository"] != "gloopsAI/gloops-paperclip-plugin":
        raise CredentialError("GitHub App repository boundary has drifted")
    for key in ("appId", "installationId", "repositoryId"):
        if not isinstance(raw[key], int) or raw[key] <= 0:
            raise CredentialError(f"{key} must be a positive integer")
    return raw


def api_base() -> str:
    if os.environ.get("GLOOPS_GITHUB_APP_TEST_MODE") == "1":
        return os.environ.get("GLOOPS_GITHUB_API_BASE", API_BASE).rstrip("/")
    return API_BASE


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def app_jwt(config: dict[str, object]) -> str:
    key_path = Path(str(config["privateKeyPath"]))
    key_stat = key_path.stat()
    mode = stat.S_IMODE(key_stat.st_mode)
    if key_stat.st_uid != 0 or mode not in {0o400, 0o600}:
        raise CredentialError("GitHub App private key must be root-owned mode 0400 or 0600")
    now = int(datetime.now(timezone.utc).timestamp())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"iat": now - 60, "exp": now + 540, "iss": config["appId"]}, separators=(",", ":")).encode())
    unsigned = f"{header}.{payload}"
    signature = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(key_path)],
        input=unsigned.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    ).stdout
    return f"{unsigned}.{b64url(signature)}"


def request_json(method: str, path: str, token: str, body: object | None = None) -> object:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = Request(
        f"{api_base()}{path}",
        data=data,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "gloops-github-app-credential-broker/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            payload = response.read()
            return {} if not payload else json.loads(payload)
    except HTTPError as error:
        raise CredentialError(f"GitHub API {method} {path} returned {error.code}") from error
    except URLError as error:
        raise CredentialError(f"GitHub API {method} {path} was unavailable") from error


def mint(config: dict[str, object], permissions: dict[str, str]) -> tuple[str, str, dict[str, str]]:
    response = request_json(
        "POST",
        f"/app/installations/{config['installationId']}/access_tokens",
        app_jwt(config),
        {"repository_ids": [config["repositoryId"]], "permissions": permissions},
    )
    if not isinstance(response, dict):
        raise CredentialError("GitHub token response is malformed")
    token = response.get("token")
    expires_at = response.get("expires_at")
    actual_permissions = response.get("permissions")
    if not isinstance(token, str) or not token.startswith("ghs_") or any(char.isspace() for char in token):
        raise CredentialError("GitHub installation token is malformed")
    try:
        if not isinstance(expires_at, str) or not isinstance(actual_permissions, dict):
            raise CredentialError("GitHub token metadata is incomplete")
        expected = {**permissions, "metadata": "read"}
        normalized = {str(key): str(value) for key, value in actual_permissions.items()}
        if normalized != expected:
            raise CredentialError("GitHub installation token permissions exceed or miss the requested scope")
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        seconds = (expiry - datetime.now(timezone.utc)).total_seconds()
        if seconds < 2700 or seconds > 3900:
            raise CredentialError("GitHub installation token expiry is outside the one-hour envelope")
        verify_repository(config, token)
        return token, expires_at, normalized
    except Exception:
        try:
            revoke_value(token)
        except Exception as cleanup_error:
            raise CredentialRetentionError(token) from cleanup_error
        raise


def verify_repository(config: dict[str, object], token: str) -> None:
    installation = request_json("GET", "/installation/repositories?per_page=100", token)
    if not isinstance(installation, dict) or installation.get("total_count") != 1:
        raise CredentialError("GitHub App installation is not restricted to exactly one repository")
    repositories = installation.get("repositories")
    if not isinstance(repositories, list) or len(repositories) != 1:
        raise CredentialError("GitHub App repository inventory is malformed")
    repository = repositories[0]
    if not isinstance(repository, dict) or repository.get("id") != config["repositoryId"] or repository.get("full_name") != config["repository"]:
        raise CredentialError("GitHub App token repository does not match the configured boundary")
    detail = request_json("GET", f"/repos/{config['repository']}", token)
    if not isinstance(detail, dict) or detail.get("private") is not True or detail.get("id") != config["repositoryId"]:
        raise CredentialError("GitHub App private repository boundary is unobservable")


def atomic_write(path: Path, value: str, mode: int, uid: int = 0, gid: int = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, uid, gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_root_secret(path: Path, label: str) -> str:
    path_stat = path.stat()
    mode = stat.S_IMODE(path_stat.st_mode)
    if path_stat.st_uid != 0 or mode not in {0o400, 0o600}:
        raise CredentialError(f"{label} must be root-owned mode 0400 or 0600")
    value = path.read_text().strip()
    if not value:
        raise CredentialError(f"{label} is empty")
    return value


def receipt_base(config: dict[str, object]) -> dict[str, object]:
    return {
        "schemaVersion": "gloops.github-app-credential-receipt.v1",
        "appId": config["appId"],
        "installationId": config["installationId"],
        "repositoryId": config["repositoryId"],
        "repository": config["repository"],
    }


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def receipt_complete(receipt: object) -> bool:
    if not isinstance(receipt, dict):
        return False
    for role in ("hermes", "projector"):
        entry = receipt.get(role)
        if not isinstance(entry, dict) or not isinstance(entry.get("revokedAt"), str):
            return False
    return True


def archive_completed_receipt() -> None:
    if not RECEIPT.exists():
        return
    receipt = json.loads(RECEIPT.read_text())
    if not receipt_complete(receipt):
        return
    archived = dict(receipt)
    archived.pop("receiptDigest", None)
    if not isinstance(archived.get("lifecycleId"), str):
        legacy = json.dumps(archived, sort_keys=True, separators=(",", ":"))
        archived["lifecycleId"] = "legacy-" + hashlib.sha256(legacy.encode()).hexdigest()[:24]
        archived["legacyReceipt"] = True
    if not isinstance(archived.get("completedAt"), str):
        archived["completedAt"] = timestamp()
    canonical = json.dumps(archived, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    archived["receiptDigest"] = digest

    existing = HISTORY.read_text() if HISTORY.exists() else ""
    for line in existing.splitlines():
        record = json.loads(line)
        if not isinstance(record, dict):
            raise CredentialError("GitHub credential history is malformed")
        if record.get("receiptDigest") == digest:
            if receipt.get("receiptDigest") != digest:
                receipt["completedAt"] = archived["completedAt"]
                receipt["receiptDigest"] = digest
                receipt["lifecycleId"] = archived["lifecycleId"]
                if archived.get("legacyReceipt") is True:
                    receipt["legacyReceipt"] = True
                atomic_write(RECEIPT, json.dumps(receipt, sort_keys=True) + "\n", 0o600)
            return
    atomic_write(HISTORY, existing + json.dumps(archived, sort_keys=True) + "\n", 0o600)
    receipt["completedAt"] = archived["completedAt"]
    receipt["receiptDigest"] = digest
    receipt["lifecycleId"] = archived["lifecycleId"]
    if archived.get("legacyReceipt") is True:
        receipt["legacyReceipt"] = True
    atomic_write(RECEIPT, json.dumps(receipt, sort_keys=True) + "\n", 0o600)


def record_mint(
    config: dict[str, object],
    role: str,
    token: str,
    expires_at: str,
    permissions: dict[str, str],
) -> None:
    expected = receipt_base(config)
    receipt = expected.copy()
    if RECEIPT.exists():
        existing = json.loads(RECEIPT.read_text())
        if not isinstance(existing, dict) or any(existing.get(key) != value for key, value in expected.items()):
            raise CredentialError("GitHub credential receipt boundary has drifted")
        if receipt_complete(existing):
            archive_completed_receipt()
        else:
            receipt = existing
    if "lifecycleId" not in receipt:
        receipt["lifecycleId"] = str(uuid4())
        receipt["startedAt"] = timestamp()
    receipt[role] = {
        "mintedAt": timestamp(),
        "expiresAt": expires_at,
        "permissions": permissions,
        "revokedAt": None,
        "tokenFingerprint": hashlib.sha256(token.encode()).hexdigest(),
    }
    atomic_write(RECEIPT, json.dumps(receipt, sort_keys=True) + "\n", 0o600)


def refresh_role(config: dict[str, object], role: str) -> None:
    if role not in {"hermes", "projector"}:
        raise CredentialError("unknown GitHub token role")
    archive_completed_receipt()
    token_path = HERMES_TOKEN if role == "hermes" else PROJECTOR_TOKEN
    permissions = WRITE_PERMISSIONS if role == "hermes" else READ_PERMISSIONS
    revoke(token_path)
    if role == "hermes":
        HERMES_HOSTS.unlink(missing_ok=True)
    else:
        PROJECTOR_ROTATED.unlink(missing_ok=True)

    token: str | None = None
    try:
        RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(RUNTIME, 0o700)
        token, expires_at, actual_permissions = mint(config, permissions)
        # Persist the cleanup handle immediately. Any later exception either
        # revokes it successfully or leaves this root-only handle for retry.
        atomic_write(token_path, token + "\n", 0o600)
        if role == "hermes":
            atomic_write(
                HERMES_HOSTS,
                "github.com:\n  git_protocol: https\n  user: x-access-token\n  oauth_token: " + token + "\n",
                0o400,
                10000,
                10000,
            )
        record_mint(config, role, token, expires_at, actual_permissions)
    except CredentialRetentionError as error:
        atomic_write(token_path, error.token + "\n", 0o600)
        raise
    except Exception:
        if token is not None:
            try:
                revoke_value(token)
            except Exception:
                # token_path was written before any projection or receipt work
                # and remains the durable root-only cleanup handle.
                raise
            token_path.unlink(missing_ok=True)
        if role == "hermes":
            HERMES_HOSTS.unlink(missing_ok=True)
        else:
            PROJECTOR_ROTATED.unlink(missing_ok=True)
        raise


def paperclip_request(method: str, path: str, board_token: str, body: object | None = None) -> object:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = Request(
        f"http://127.0.0.1:3100/api{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {board_token}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read())
    except (HTTPError, URLError) as error:
        raise CredentialError("Paperclip projector-token rotation failed") from error


def resolve_bound_projector_secret(config: dict[str, object], board_token: str) -> str:
    plugin_config = paperclip_request(
        "GET",
        "/plugins/gloops.trusted-execution-projector/config",
        board_token,
    )
    config_json = plugin_config.get("configJson") if isinstance(plugin_config, dict) else None
    if not isinstance(config_json, dict):
        raise CredentialError("trusted projector configuration is unavailable")
    company_id = config_json.get("companyId")
    secret_id = config_json.get("githubTokenSecretRef")
    if not isinstance(company_id, str) or not isinstance(secret_id, str):
        raise CredentialError("trusted projector secret binding is incomplete")
    try:
        canonical_company_id = str(UUID(company_id))
        canonical_secret_id = str(UUID(secret_id))
    except ValueError as error:
        raise CredentialError("trusted projector secret binding is malformed") from error
    if canonical_company_id != company_id or canonical_secret_id != secret_id:
        raise CredentialError("trusted projector secret binding is not canonical")

    secret_inventory = paperclip_request(
        "GET",
        f"/companies/{company_id}/secrets",
        board_token,
    )
    if not isinstance(secret_inventory, list):
        raise CredentialError("Paperclip company secret inventory is malformed")
    matches = [entry for entry in secret_inventory if isinstance(entry, dict) and entry.get("id") == secret_id]
    if len(matches) != 1:
        raise CredentialError("trusted projector secret is absent from its configured company")
    secret = matches[0]
    if (
        secret.get("companyId") != company_id
        or secret.get("status") != "active"
        or secret.get("scope", "company") != "company"
    ):
        raise CredentialError("trusted projector secret is not an active company secret")
    return secret_id


def rotate_projector(config: dict[str, object], value: str) -> None:
    board_token = read_root_secret(Path(str(config["boardTokenPath"])), "Paperclip board token")
    if not board_token.startswith("pcp_board_") or len(board_token) != 58:
        raise CredentialError("Paperclip operator credential is malformed")
    secret_id = resolve_bound_projector_secret(config, board_token)
    response = paperclip_request("POST", f"/secrets/{secret_id}/rotate", board_token, {"value": value})
    if not isinstance(response, dict) or response.get("id") != secret_id:
        raise CredentialError("Paperclip projector-token rotation returned the wrong secret")


def revoke_value(token: str) -> None:
    if token.startswith("ghs_"):
        request_json("DELETE", "/installation/token", token)


def record_revocation(token_path: Path, token: str) -> None:
    if not RECEIPT.exists():
        return
    role = "hermes" if token_path == HERMES_TOKEN else "projector" if token_path == PROJECTOR_TOKEN else None
    if role is None:
        raise CredentialError("unknown GitHub token role")
    receipt = json.loads(RECEIPT.read_text())
    entry = receipt.get(role) if isinstance(receipt, dict) else None
    fingerprint = hashlib.sha256(token.encode()).hexdigest()
    if not isinstance(entry, dict) or entry.get("tokenFingerprint") != fingerprint:
        raise CredentialError("GitHub token does not match its credential receipt")
    entry["revokedAt"] = timestamp()
    atomic_write(RECEIPT, json.dumps(receipt, sort_keys=True) + "\n", 0o600)
    archive_completed_receipt()


def revoke(token_path: Path) -> None:
    archive_completed_receipt()
    if not token_path.exists():
        return
    token = token_path.read_text().strip()
    revoke_value(token)
    try:
        record_revocation(token_path, token)
    finally:
        token_path.unlink(missing_ok=True)


def command_refresh_projector(config: dict[str, object]) -> None:
    refresh_role(config, "projector")


def command_refresh_hermes(config: dict[str, object]) -> None:
    refresh_role(config, "hermes")


def command_rotate_projector(config: dict[str, object]) -> None:
    token = PROJECTOR_TOKEN.read_text().strip()
    if not token.startswith("ghs_"):
        raise CredentialError("projector GitHub token is missing or malformed")
    rotate_projector(config, token)
    atomic_write(PROJECTOR_ROTATED, "rotated\n", 0o600)


def command_clear_projector(config: dict[str, object]) -> None:
    rotation_error: Exception | None = None
    try:
        if PROJECTOR_ROTATED.exists():
            rotate_projector(config, f"revoked:{secrets.token_hex(24)}")
    except Exception as error:
        rotation_error = error
    finally:
        try:
            revoke(PROJECTOR_TOKEN)
        finally:
            PROJECTOR_ROTATED.unlink(missing_ok=True)
    if rotation_error is not None:
        raise CredentialError("projector secret could not be cleared before token revocation") from rotation_error


def command_revoke_projector(_config: dict[str, object]) -> None:
    revoke(PROJECTOR_TOKEN)
    PROJECTOR_ROTATED.unlink(missing_ok=True)


def command_revoke_hermes(_config: dict[str, object]) -> None:
    try:
        revoke(HERMES_TOKEN)
    finally:
        HERMES_HOSTS.unlink(missing_ok=True)


def main() -> int:
    if os.geteuid() != 0:
        raise CredentialError("run as root")
    if len(sys.argv) != 2 or sys.argv[1] not in {
        "refresh-projector",
        "refresh-hermes",
        "rotate-projector",
        "clear-projector",
        "revoke-projector",
        "revoke-hermes",
    }:
        raise CredentialError("usage: github-app-credentials.py refresh-projector|refresh-hermes|rotate-projector|clear-projector|revoke-projector|revoke-hermes")
    config = load_config()
    commands = {
        "refresh-projector": command_refresh_projector,
        "refresh-hermes": command_refresh_hermes,
        "rotate-projector": command_rotate_projector,
        "clear-projector": command_clear_projector,
        "revoke-projector": command_revoke_projector,
        "revoke-hermes": command_revoke_hermes,
    }
    commands[sys.argv[1]](config)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CredentialError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"github-app-credentials: {error}", file=sys.stderr)
        raise SystemExit(1)
