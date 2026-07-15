#!/usr/bin/env python3
"""Mint, project, verify, and revoke bounded GitHub App installation tokens.

The App private key never leaves the root-owned host boundary. Hermes receives
one repository-scoped write token through its read-only gh config mount. The
Paperclip trusted projector receives a separately minted read-only token through
Paperclip's encrypted secret store. No token is printed or placed in argv.
"""

from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


CONFIG = Path("/etc/paperclip-gloops/github-app.json")
LEGACY_RUNTIME = Path("/run/paperclip-gloops")
RUNTIME = Path("/var/lib/paperclip-gloops/credential-runtime")
HERMES_TOKEN = RUNTIME / "hermes-github-token"
PROJECTOR_TOKEN = RUNTIME / "projector-github-token"
PROJECTOR_ROTATED = RUNTIME / "projector-token-rotated"
HERMES_HOSTS = Path("/opt/paperclip/hermes-execution-profile/gh/hosts.yml")
RECEIPT = RUNTIME / "credential-receipt.json"
HISTORY = Path("/var/lib/paperclip-gloops/credential-history.jsonl")
HISTORY_LOCK = Path("/var/lib/paperclip-gloops/credential-history.lock")
COMMAND_LOCK = RUNTIME / "credential-lifecycle.lock"
MINT_INTENTS = RUNTIME / "mint-intents.json"
API_BASE = "https://api.github.com"
MAX_TOKEN_LIFETIME_SECONDS = 3900

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


class GitHubAPIError(CredentialError):
    def __init__(self, method: str, path: str, status: int):
        super().__init__(f"GitHub API {method} {path} returned {status}")
        self.status = status


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
        raise GitHubAPIError(method, path, error.code) from error
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


def fsync_directory(path: Path) -> None:
    directory_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def atomic_write(path: Path, value: str, mode: int, uid: int = 0, gid: int = 0) -> None:
    parent_created = not path.parent.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    if parent_created:
        fsync_directory(path.parent.parent)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, uid, gid)
        os.replace(temporary, path)
        fsync_directory(path.parent)
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


def durable_unlink(path: Path) -> None:
    if not path.exists():
        return
    path.unlink()
    fsync_directory(path.parent)


def load_mint_intents() -> dict[str, dict[str, object]]:
    if not MINT_INTENTS.exists():
        return {}
    raw = json.loads(MINT_INTENTS.read_text())
    if not isinstance(raw, dict) or raw.get("schemaVersion") != "gloops.github-app-mint-intents.v1":
        raise CredentialError("GitHub mint-intent ledger is malformed")
    intents = raw.get("intents")
    if not isinstance(intents, dict) or not set(intents).issubset({"hermes", "projector"}):
        raise CredentialError("GitHub mint-intent roles are malformed")
    for role, intent in intents.items():
        if not isinstance(intent, dict) or set(intent) != {"attemptId", "startedAt", "safeAfter"}:
            raise CredentialError(f"GitHub mint intent is malformed: {role}")
        if not all(isinstance(intent[key], str) and intent[key] for key in intent):
            raise CredentialError(f"GitHub mint intent values are malformed: {role}")
    return intents


def write_mint_intents(intents: dict[str, dict[str, object]]) -> None:
    if intents:
        atomic_write(
            MINT_INTENTS,
            json.dumps({"schemaVersion": "gloops.github-app-mint-intents.v1", "intents": intents}, sort_keys=True) + "\n",
            0o600,
        )
    else:
        durable_unlink(MINT_INTENTS)


def begin_mint_intent(role: str) -> None:
    intents = load_mint_intents()
    if role in intents:
        raise CredentialError(f"unreconciled GitHub mint intent exists: {role}")
    started = datetime.now(timezone.utc)
    intents[role] = {
        "attemptId": str(uuid4()),
        "startedAt": started.isoformat().replace("+00:00", "Z"),
        "safeAfter": (started + timedelta(seconds=MAX_TOKEN_LIFETIME_SECONDS)).isoformat().replace("+00:00", "Z"),
    }
    write_mint_intents(intents)


def clear_mint_intent(role: str) -> None:
    intents = load_mint_intents()
    if role in intents:
        del intents[role]
        write_mint_intents(intents)


def reconcile_expired_mint_intents() -> None:
    intents = load_mint_intents()
    now = datetime.now(timezone.utc)
    retained: dict[str, dict[str, object]] = {}
    for role, intent in intents.items():
        token_path = HERMES_TOKEN if role == "hermes" else PROJECTOR_TOKEN
        try:
            safe_after = datetime.fromisoformat(str(intent["safeAfter"]).replace("Z", "+00:00"))
        except ValueError as error:
            raise CredentialError(f"GitHub mint intent expiry is malformed: {role}") from error
        if token_path.exists() or now < safe_after:
            retained[role] = intent
    write_mint_intents(retained)


def migrate_persistent_state() -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(RUNTIME, 0o700)
    legacy_artifacts = {
        LEGACY_RUNTIME / "hermes-github-token": HERMES_TOKEN,
        LEGACY_RUNTIME / "projector-github-token": PROJECTOR_TOKEN,
        LEGACY_RUNTIME / "projector-token-rotated": PROJECTOR_ROTATED,
        LEGACY_RUNTIME / "credential-receipt.json": RECEIPT,
    }
    for source, destination in legacy_artifacts.items():
        if not source.exists():
            continue
        if destination.exists():
            raise CredentialError(f"both legacy and durable credential artifacts exist: {destination.name}")
        atomic_write(destination, source.read_text(), 0o600)
        source.unlink()
    if not RECEIPT.exists() and HISTORY.exists() and HISTORY.stat().st_size > 0:
        records = [json.loads(line) for line in HISTORY.read_text().splitlines()]
        if not all(isinstance(record, dict) for record in records):
            raise CredentialError("GitHub credential history is malformed")
        validate_history(records)
        # A missing legacy /run receipt may mean reboot erased an in-flight
        # lifecycle. Quarantine both roles for a full maximum token lifetime
        # before the completed history tail may become the durable baseline.
        for role in ("hermes", "projector"):
            if role not in load_mint_intents():
                begin_mint_intent(role)
        atomic_write(RECEIPT, json.dumps(records[-1], sort_keys=True) + "\n", 0o600)


def receipt_complete(receipt: object) -> bool:
    if not isinstance(receipt, dict):
        return False
    for role in ("hermes", "projector"):
        entry = receipt.get(role)
        if not isinstance(entry, dict) or not isinstance(entry.get("revokedAt"), str):
            return False
    return True


def history_digest(record: dict[str, object]) -> str:
    payload = dict(record)
    payload.pop("receiptDigest", None)
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def validate_history(records: list[dict[str, object]]) -> None:
    prior: str | None = None
    lifecycles: set[str] = set()
    for sequence, record in enumerate(records, 1):
        if record.get("sequence") != sequence or record.get("previousReceiptDigest") != prior:
            raise CredentialError("GitHub credential history sequence or hash chain is malformed")
        if record.get("receiptDigest") != history_digest(record):
            raise CredentialError("GitHub credential history digest is malformed")
        lifecycle = record.get("lifecycleId")
        if not isinstance(lifecycle, str) or lifecycle in lifecycles:
            raise CredentialError("GitHub credential history lifecycle identity is malformed")
        lifecycles.add(lifecycle)
        prior = str(record["receiptDigest"])


def append_credential_history(archived: dict[str, object]) -> dict[str, object]:
    lifecycle_id = archived.get("lifecycleId")
    if not isinstance(lifecycle_id, str) or not lifecycle_id:
        raise CredentialError("GitHub credential receipt has no lifecycle identity")
    HISTORY_LOCK.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = os.open(HISTORY_LOCK, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        os.chmod(HISTORY_LOCK, 0o600)
        os.chown(HISTORY_LOCK, 0, 0)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        records = [json.loads(line) for line in HISTORY.read_text().splitlines()] if HISTORY.exists() else []
        if not all(isinstance(record, dict) for record in records):
            raise CredentialError("GitHub credential history is malformed")
        validate_history(records)
        for record in records:
            if record.get("lifecycleId") == lifecycle_id:
                return record
        record = {
            **archived,
            "sequence": len(records) + 1,
            "previousReceiptDigest": records[-1]["receiptDigest"] if records else None,
        }
        record["receiptDigest"] = history_digest(record)
        history_parent_created = not HISTORY.parent.exists()
        HISTORY.parent.mkdir(parents=True, exist_ok=True)
        if history_parent_created:
            fsync_directory(HISTORY.parent.parent)
        history_created = not HISTORY.exists()
        history_fd = os.open(HISTORY, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
        try:
            os.chmod(HISTORY, 0o600)
            os.chown(HISTORY, 0, 0)
            payload = (json.dumps(record, sort_keys=True) + "\n").encode()
            if os.write(history_fd, payload) != len(payload):
                raise CredentialError("GitHub credential history append was incomplete")
            os.fsync(history_fd)
        finally:
            os.close(history_fd)
        if history_created:
            fsync_directory(HISTORY.parent)
        return record
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


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
    record = append_credential_history(archived)
    receipt["completedAt"] = record["completedAt"]
    receipt["receiptDigest"] = record["receiptDigest"]
    receipt["lifecycleId"] = record["lifecycleId"]
    receipt["sequence"] = record["sequence"]
    receipt["previousReceiptDigest"] = record["previousReceiptDigest"]
    if record.get("legacyReceipt") is True:
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

    token: str | None = None
    begin_mint_intent(role)
    try:
        RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(RUNTIME, 0o700)
        token, expires_at, actual_permissions = mint(config, permissions)
        # The pre-mint intent closes the response-before-fsync crash window.
        # Once this protected cleanup handle is durable, the intent can clear.
        atomic_write(token_path, token + "\n", 0o600)
        clear_mint_intent(role)
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
        clear_mint_intent(role)
        raise
    except Exception:
        if token is not None:
            try:
                revoke_value(token)
            except Exception:
                # token_path is durable before projection or receipt work and
                # remains the root-only cleanup handle.
                raise
            durable_unlink(token_path)
            clear_mint_intent(role)
        if role == "hermes":
            HERMES_HOSTS.unlink(missing_ok=True)
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
        try:
            request_json("DELETE", "/installation/token", token)
        except GitHubAPIError as error:
            if error.status not in {401, 404}:
                raise


def token_revocation_is_recorded(token_path: Path, token: str) -> bool:
    if not RECEIPT.exists():
        return False
    role = "hermes" if token_path == HERMES_TOKEN else "projector" if token_path == PROJECTOR_TOKEN else None
    if role is None:
        raise CredentialError("unknown GitHub token role")
    receipt = json.loads(RECEIPT.read_text())
    entry = receipt.get(role) if isinstance(receipt, dict) else None
    return bool(
        isinstance(entry, dict)
        and entry.get("tokenFingerprint") == hashlib.sha256(token.encode()).hexdigest()
        and isinstance(entry.get("revokedAt"), str)
    )


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
    if token_revocation_is_recorded(token_path, token):
        durable_unlink(token_path)
        clear_mint_intent("hermes" if token_path == HERMES_TOKEN else "projector")
        return
    revoke_value(token)
    try:
        record_revocation(token_path, token)
    finally:
        durable_unlink(token_path)
        clear_mint_intent("hermes" if token_path == HERMES_TOKEN else "projector")


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
            durable_unlink(PROJECTOR_ROTATED)
    if rotation_error is not None:
        raise CredentialError("projector secret could not be cleared before token revocation") from rotation_error


def command_revoke_projector(_config: dict[str, object]) -> None:
    revoke(PROJECTOR_TOKEN)
    if PROJECTOR_ROTATED.exists():
        raise CredentialError("projector secret remains rotated to a token and must be cleared while Paperclip is available")


def command_revoke_hermes(_config: dict[str, object]) -> None:
    try:
        revoke(HERMES_TOKEN)
    finally:
        HERMES_HOSTS.unlink(missing_ok=True)


def command_migrate(_config: dict[str, object]) -> None:
    migrate_persistent_state()


def command_reconcile_expired_intents(_config: dict[str, object]) -> None:
    reconcile_expired_mint_intents()


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
        "migrate-persistent-state",
        "reconcile-expired-mint-intents",
    }:
        raise CredentialError("usage: github-app-credentials.py refresh-projector|refresh-hermes|rotate-projector|clear-projector|revoke-projector|revoke-hermes|migrate-persistent-state|reconcile-expired-mint-intents")
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(RUNTIME, 0o700)
    os.chown(RUNTIME, 0, 0)
    command_fd = os.open(COMMAND_LOCK, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        os.chmod(COMMAND_LOCK, 0o600)
        os.chown(COMMAND_LOCK, 0, 0)
        fcntl.flock(command_fd, fcntl.LOCK_EX)
        config = load_config()
        commands = {
            "refresh-projector": command_refresh_projector,
            "refresh-hermes": command_refresh_hermes,
            "rotate-projector": command_rotate_projector,
            "clear-projector": command_clear_projector,
            "revoke-projector": command_revoke_projector,
            "revoke-hermes": command_revoke_hermes,
            "migrate-persistent-state": command_migrate,
            "reconcile-expired-mint-intents": command_reconcile_expired_intents,
        }
        commands[sys.argv[1]](config)
    finally:
        fcntl.flock(command_fd, fcntl.LOCK_UN)
        os.close(command_fd)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CredentialError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"github-app-credentials: {error}", file=sys.stderr)
        raise SystemExit(1)
