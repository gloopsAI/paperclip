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
from uuid import UUID
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


CONFIG = Path("/etc/paperclip-gloops/github-app.json")
RUNTIME = Path("/run/paperclip-gloops")
HERMES_TOKEN = RUNTIME / "hermes-github-token"
PROJECTOR_TOKEN = RUNTIME / "projector-github-token"
PROJECTOR_ROTATED = RUNTIME / "projector-token-rotated"
HERMES_HOSTS = Path("/opt/paperclip/hermes-execution-profile/gh/hosts.yml")
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


def load_config() -> dict[str, object]:
    raw = json.loads(CONFIG.read_text())
    required = {
        "appId",
        "installationId",
        "repositoryId",
        "repository",
        "privateKeyPath",
        "projectorSecretIdPath",
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


def refresh(config: dict[str, object]) -> None:
    minted: list[tuple[str, Path]] = []
    try:
        write_token, write_expiry, write_permissions = mint(config, WRITE_PERMISSIONS)
        minted.append((write_token, HERMES_TOKEN))
        read_token, read_expiry, read_permissions = mint(config, READ_PERMISSIONS)
        minted.append((read_token, PROJECTOR_TOKEN))
        RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(RUNTIME, 0o700)
        atomic_write(HERMES_TOKEN, write_token + "\n", 0o600)
        atomic_write(PROJECTOR_TOKEN, read_token + "\n", 0o600)
        atomic_write(
            HERMES_HOSTS,
            "github.com:\n  git_protocol: https\n  user: x-access-token\n  oauth_token: " + write_token + "\n",
            0o400,
            10000,
            10000,
        )
        receipt = {
            "schemaVersion": "gloops.github-app-credential-receipt.v1",
            "appId": config["appId"],
            "installationId": config["installationId"],
            "repositoryId": config["repositoryId"],
            "repository": config["repository"],
        "hermes": {
            "expiresAt": write_expiry,
            "permissions": write_permissions,
            "revokedAt": None,
            "tokenFingerprint": hashlib.sha256(write_token.encode()).hexdigest(),
        },
        "projector": {
            "expiresAt": read_expiry,
            "permissions": read_permissions,
            "revokedAt": None,
            "tokenFingerprint": hashlib.sha256(read_token.encode()).hexdigest(),
        },
        }
        atomic_write(RUNTIME / "credential-receipt.json", json.dumps(receipt, sort_keys=True) + "\n", 0o600)
    except Exception:
        retained: set[Path] = set()
        for token, token_path in reversed(minted):
            try:
                revoke_value(token)
            except CredentialError:
                atomic_write(token_path, token + "\n", 0o600)
                retained.add(token_path)
        for path in (HERMES_TOKEN, PROJECTOR_TOKEN):
            if path not in retained:
                path.unlink(missing_ok=True)
        for path in (HERMES_HOSTS, RUNTIME / "credential-receipt.json"):
            path.unlink(missing_ok=True)
        raise


def paperclip_request(path: str, board_token: str, body: object) -> object:
    data = json.dumps(body, separators=(",", ":")).encode()
    request = Request(
        f"http://127.0.0.1:3100/api{path}",
        data=data,
        method="POST",
        headers={"Authorization": f"Bearer {board_token}", "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read())
    except (HTTPError, URLError) as error:
        raise CredentialError("Paperclip projector-token rotation failed") from error


def rotate_projector(config: dict[str, object], value: str) -> None:
    board_token = read_root_secret(Path(str(config["boardTokenPath"])), "Paperclip board token")
    secret_id = read_root_secret(Path(str(config["projectorSecretIdPath"])), "projector secret id")
    try:
        canonical_secret_id = str(UUID(secret_id))
    except ValueError as error:
        raise CredentialError("projector secret id is malformed") from error
    if not board_token.startswith("pcp_board_") or len(board_token) != 58 or canonical_secret_id != secret_id:
        raise CredentialError("Paperclip operator credential or projector secret id is malformed")
    response = paperclip_request(f"/secrets/{secret_id}/rotate", board_token, {"value": value})
    if not isinstance(response, dict) or response.get("id") != secret_id:
        raise CredentialError("Paperclip projector-token rotation returned the wrong secret")


def revoke_value(token: str) -> None:
    if token.startswith("ghs_"):
        request_json("DELETE", "/installation/token", token)


def record_revocation(token_path: Path, token: str) -> None:
    receipt_path = RUNTIME / "credential-receipt.json"
    if not receipt_path.exists():
        return
    role = "hermes" if token_path == HERMES_TOKEN else "projector" if token_path == PROJECTOR_TOKEN else None
    if role is None:
        raise CredentialError("unknown GitHub token role")
    receipt = json.loads(receipt_path.read_text())
    entry = receipt.get(role) if isinstance(receipt, dict) else None
    fingerprint = hashlib.sha256(token.encode()).hexdigest()
    if not isinstance(entry, dict) or entry.get("tokenFingerprint") != fingerprint:
        raise CredentialError("GitHub token does not match its credential receipt")
    entry["revokedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    atomic_write(receipt_path, json.dumps(receipt, sort_keys=True) + "\n", 0o600)


def revoke(token_path: Path) -> None:
    if not token_path.exists():
        return
    token = token_path.read_text().strip()
    revoke_value(token)
    try:
        record_revocation(token_path, token)
    finally:
        token_path.unlink(missing_ok=True)


def command_refresh(config: dict[str, object]) -> None:
    revoke_errors: list[CredentialError] = []
    for token_path in (PROJECTOR_TOKEN, HERMES_TOKEN):
        try:
            revoke(token_path)
        except CredentialError as error:
            revoke_errors.append(error)
    PROJECTOR_ROTATED.unlink(missing_ok=True)
    HERMES_HOSTS.unlink(missing_ok=True)
    (RUNTIME / "credential-receipt.json").unlink(missing_ok=True)
    if revoke_errors:
        raise CredentialError("one or more prior GitHub App tokens could not be revoked")
    refresh(config)


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
        "refresh",
        "rotate-projector",
        "clear-projector",
        "revoke-projector",
        "revoke-hermes",
    }:
        raise CredentialError("usage: github-app-credentials.py refresh|rotate-projector|clear-projector|revoke-projector|revoke-hermes")
    config = load_config()
    commands = {
        "refresh": command_refresh,
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
