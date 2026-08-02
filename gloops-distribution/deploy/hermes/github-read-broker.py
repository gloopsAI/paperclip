#!/usr/bin/env python3
"""Root-owned read-only GitHub evidence broker.

Serves bounded, read-only GitHub issue/PR and source-inventory evidence for
the allowlisted Induct repositories over a peer-authenticated Unix socket.
Issue/PR operations use the existing root ``gh`` CLI authentication.  Source-
inventory operations mint a short-lived GitHub App installation token from the
same host credentials as the push broker (``/etc/paperclip-gloops/github-app.json``
+ private key) and pass it to ``gh`` only via process env for that invocation.
No credential is copied, printed, mounted, or returned.  A separate socket from
the one-run push broker so the push path is untouched.

Source-inventory operations (``get-repo-source-metadata``, ``list-source-tree``,
``get-source-file``) inspect repository source at an EXACT immutable 40-char
commit SHA only -- never a mutable ref (branch/tag/HEAD/short/uppercase SHA) --
with path-traversal, binary, oversize, and bounded-entry guards.

``list-source-tree`` walks the repository tree HIERARCHICALLY.  It resolves the
exact commit to its root tree object and then reads one tree object per path
component with NON-recursive ``git/trees/<tree_sha>`` requests (never
``recursive=1``).  A recursive listing of a large repository exceeds the
upstream ~512 KiB ``run_gh`` response ceiling BEFORE any slicing can occur, so
each request returns only a single directory's immediate, bounded entries --
including child tree SHAs and entry types -- and the caller recurses by asking
again with a deeper ``pathPrefix``.  A single directory whose response exceeds
the upstream ceiling fails TYPED rather than being silently truncated.

Request schema (single JSON object, one per connection)::

    {"operation": "<op>", "repo": "<owner/repo>", ...}

Response schema::

    {"ok": true,  "data": <bounded json>}
    {"ok": false, "error": "<message>"}

No credential, token, header, or secret is ever placed in a response.
"""

from __future__ import annotations

import base64
import binascii
import contextvars
import fcntl
import json
import os
import re
import socket
import stat
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CONFIG_DIR = Path(os.environ.get("GLOOPS_GITHUB_BROKER_CONFIG_DIR", "/etc/paperclip-gloops"))
RUNTIME_DIR = Path(os.environ.get("GLOOPS_GITHUB_READ_BROKER_RUNTIME_DIR", "/run/paperclip-github-read-broker"))
SOCKET_PATH = RUNTIME_DIR / "broker.sock"
COMMAND_LOCK = Path(os.environ.get("GLOOPS_GITHUB_READ_BROKER_LOCK", "/var/lib/paperclip-gloops/github-read-broker/command.lock"))
STATE_DIR = Path(os.environ.get("GLOOPS_GITHUB_READ_BROKER_STATE_DIR", "/var/lib/paperclip-gloops/github-read-broker"))
# Same host App credentials as the push broker.  Not the write-credentials path.
APP_CONFIG_PATH = Path(
    os.environ.get(
        "GLOOPS_GITHUB_READ_BROKER_APP_CONFIG",
        str(CONFIG_DIR / "github-app.json"),
    )
)
GITHUB_API_BASE = os.environ.get("GLOOPS_GITHUB_API_BASE", "https://api.github.com").rstrip("/")

ALLOWED_REPOSITORIES = frozenset({
    "InductAI/induct",
    "InductAI/induct-knowledge",
    "gloopsAI/gloops-ui",
    "gloopsAI/paperclip-gym",
})

# Source-inventory ops mint an App installation token; issue/PR ops keep host gh.
SOURCE_INVENTORY_OPERATIONS = frozenset({
    "get-repo-source-metadata",
    "list-source-tree",
    "get-source-file",
})
# Installation-wide contents:read (no single-repo pin).  GitHub always grants
# metadata:read alongside contents.  Matches the push-broker mint permission
# shape without repository_ids so paperclip-gym (and any other repo on the
# installation) is readable once the App can see it.
SOURCE_INVENTORY_PERMISSIONS = {
    "contents": "read",
}
# Active installation token for the current source-inventory request only.
# Never logged or placed in responses; injected into gh env as GH_TOKEN /
# GITHUB_TOKEN for that subprocess invocation alone.
_active_installation_token: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "active_installation_token",
    default=None,
)

REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
REPOSITORY_SCOPE_QUALIFIER_PATTERN = re.compile(
    r"(?i)(?:^|\s)(?:repo|org|user):"
)

# Source-inventory guards.  A commit reference must be an EXACT immutable
# 40-character lowercase hex object name -- never a mutable ref (branch, tag,
# HEAD) nor an abbreviated / uppercase SHA.
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
# Repo-relative source paths are validated STRUCTURALLY, one component at a
# time, rather than against a brittle ASCII allowlist: legitimate Git names use
# brackets (``[slug].astro``), spaces, ``@``/``+``/``(`` and Unicode, all of
# which a character allowlist would falsely reject and strand from the
# inventory.  Every component must be nonempty, byte-bounded, not ``.``/``..``,
# and free of the separators / NUL / control characters that enable traversal
# or request smuggling.  Contents-path components are additionally URL-encoded
# when the GitHub API URL is built.
MAX_PATH_COMPONENT_BYTES = 255
MAX_SOURCE_PATH_BYTES = 4096
# Object types GitHub reports for a tree entry: blob (file), tree (directory),
# commit (submodule gitlink).  Anything else is malformed evidence.
TREE_ENTRY_TYPES = frozenset({"blob", "tree", "commit"})
# Git file modes, bound to entry type.  A mode inconsistent with its type is
# malformed evidence and must not be relabeled as a trusted exact-tree row.
TREE_MODE = "040000"
COMMIT_MODE = "160000"
BLOB_MODES = frozenset({"100644", "100755", "120000"})


def is_safe_path_component(component: str) -> bool:
    """Structurally validate a single repo-relative path component.

    Accepts any otherwise-legitimate Git name (brackets, spaces, Unicode) and
    rejects only what enables traversal or smuggling: an empty component,
    ``.``/``..``, an over-long component, a ``/``/``\\`` separator, NUL, or any
    C0/DEL/C1 control character.
    """
    if not component or component in (".", ".."):
        return False
    if len(component.encode("utf-8")) > MAX_PATH_COMPONENT_BYTES:
        return False
    for ch in component:
        if ch in ("/", "\\", "\x00"):
            return False
        code = ord(ch)
        if code < 0x20 or 0x7F <= code <= 0x9F:
            return False
    return True


def _validate_relative_path(value: str, label: str) -> str:
    """Validate a full repo-relative path (``a/b/c``) component by component."""
    if len(value.encode("utf-8")) > MAX_SOURCE_PATH_BYTES:
        raise BrokerError(f"{label} is too long")
    if value.startswith("/"):
        raise BrokerError(f"{label} must be repo-relative, not absolute")
    for component in value.split("/"):
        if not is_safe_path_component(component):
            raise BrokerError(
                f"{label} contains an empty, '.'/'..', separator, NUL, or "
                "control component"
            )
    return value

ALLOWED_OPERATIONS = frozenset({
    "search-issues",
    "list-issues",
    "get-issue",
    "search-prs",
    "list-prs",
    "get-pr",
    "get-pr-status",
    "get-pr-checks",
    "get-repo-source-metadata",
    "list-source-tree",
    "get-source-file",
})

MAX_REQUEST_BYTES = 8 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
MAX_GH_OUTPUT_BYTES = 512 * 1024
# Source-inventory bounds: cap tree listings and reject oversize source files
# before decoding.  These are independent of the response byte cap above.
MAX_TREE_ENTRIES = 1000
MAX_SOURCE_FILE_BYTES = 256 * 1024
GH_TIMEOUT_SECONDS = 30
EXPECTED_HERMES_UID = 10_000
HERMES_GID = 10_000
# Linux SO_PEERCRED. The fallback keeps deterministic tests portable; the
# production service runs on Linux.
SO_PEERCRED = getattr(socket, "SO_PEERCRED", 17)
TEST_MODE = os.environ.get("GLOOPS_GITHUB_READ_BROKER_TEST_MODE") == "1"

# Fields stripped from every GitHub API response to avoid leaking credentials
# or sensitive metadata.  Applied recursively to all nested objects/arrays.
CREDENTIAL_KEYS = frozenset({
    "token", "access_token", "refresh_token", "authorization",
    "auth_header", "credentials", "secret", "private_key",
    "password", "otp_secret", "signed_jwt",
})

# Fields allowed in the response; any extra top-level keys in the GitHub
# response are trimmed by the field selector per operation.
ISSUE_FIELDS = (
    "number", "title", "state", "body", "labels", "assignees",
    "createdAt", "updatedAt", "closedAt", "author", "url",
    "comments", "milestone", "repository",
)
PR_FIELDS = (
    "number", "title", "state", "body", "labels", "assignees",
    "reviewers", "createdAt", "updatedAt", "closedAt", "mergedAt",
    "author", "url", "headRefName", "baseRefName",
    "isDraft", "mergeable", "additions", "deletions",
    "comments", "reviewDecision", "repository",
)
PR_STATUS_FIELDS = (
    "number", "title", "state", "statusCheckRollup",
)
PR_CHECKS_FIELDS = (
    "number", "title", "statusCheckRollup",
)
LIST_ISSUE_FIELDS = (
    "number", "title", "state", "labels", "createdAt", "updatedAt", "author", "url",
)
LIST_PR_FIELDS = (
    "number", "title", "state", "isDraft", "createdAt", "updatedAt", "author", "url",
    "headRefName", "baseRefName",
)
SEARCH_PR_FIELDS = (
    "number", "title", "state", "isDraft", "createdAt", "updatedAt", "author", "url",
    "repository",
)
# Per-entry fields returned by list-source-tree; never raw blob content.
TREE_ENTRY_FIELDS = ("path", "type", "mode", "sha", "size")

SEARCH_RESULT_LIMIT = 30
LIST_LIMIT = 30


class BrokerError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def timestamp() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


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
    # Truncate lists to fit
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
            {**data, "data": items[:lo], "truncated": True, "totalReturned": lo, "totalAvailable": len(items)},
            sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")
        if len(raw) <= max_bytes:
            return raw
    return json.dumps(
        {
            "ok": False,
            "error": "GitHub response exceeds the bounded-response ceiling",
            "truncated": True,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


# ---------------------------------------------------------------------------
# GitHub App installation token mint (source-inventory only)
# ---------------------------------------------------------------------------

def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def load_app_config() -> dict[str, object]:
    """Load the host GitHub App config used by the push broker.

    Same credential material as ``/etc/paperclip-gloops/github-app.json``.  Does
    not widen the repository allowlist and does not touch the write-credentials
    lifecycle path.
    """
    try:
        raw = json.loads(APP_CONFIG_PATH.read_text())
    except FileNotFoundError as error:
        raise BrokerError("GitHub App config is missing") from error
    except OSError as error:
        raise BrokerError("GitHub App config is unreadable") from error
    except json.JSONDecodeError as error:
        raise BrokerError("GitHub App config is malformed JSON") from error
    if not isinstance(raw, dict):
        raise BrokerError("GitHub App config must be a JSON object")
    required = {
        "appId",
        "installationId",
        "repositoryId",
        "repository",
        "privateKeyPath",
        "boardTokenPath",
    }
    if set(raw) != required:
        raise BrokerError("GitHub App config keys do not match the allowlist")
    for key in ("appId", "installationId", "repositoryId"):
        if not isinstance(raw[key], int) or raw[key] <= 0:
            raise BrokerError(f"GitHub App config {key} must be a positive integer")
    for key in ("repository", "privateKeyPath", "boardTokenPath"):
        if not isinstance(raw[key], str) or not raw[key]:
            raise BrokerError(f"GitHub App config {key} must be a non-empty string")
    return raw


def _app_jwt(config: dict[str, object]) -> str:
    """Mint a short-lived App JWT from the root-owned private key (push pattern)."""
    key_path = Path(str(config["privateKeyPath"]))
    try:
        key_stat = key_path.stat()
    except OSError as error:
        raise BrokerError("GitHub App private key is unreadable") from error
    mode = stat.S_IMODE(key_stat.st_mode)
    if key_stat.st_uid != 0 or mode not in {0o400, 0o600}:
        raise BrokerError("GitHub App private key must be root-owned mode 0400 or 0600")
    now = int(datetime.now(timezone.utc).timestamp())
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64url(
        json.dumps(
            {"iat": now - 60, "exp": now + 540, "iss": config["appId"]},
            separators=(",", ":"),
        ).encode()
    )
    unsigned = f"{header}.{payload}"
    try:
        signature = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", str(key_path)],
            input=unsigned.encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        ).stdout
    except FileNotFoundError as error:
        raise BrokerError("openssl is not available for GitHub App JWT signing") from error
    except subprocess.CalledProcessError as error:
        raise BrokerError("GitHub App JWT signing failed") from error
    return f"{unsigned}.{_b64url(signature)}"


def _request_json(method: str, path: str, token: str, body: object | None = None) -> object:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = Request(
        f"{GITHUB_API_BASE}{path}",
        data=data,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "gloops-github-read-broker/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            payload = response.read()
            return {} if not payload else json.loads(payload)
    except HTTPError as error:
        raise BrokerError(
            f"GitHub App API {method} {path} returned {error.code}"
        ) from error
    except URLError as error:
        raise BrokerError(f"GitHub App API {method} {path} was unavailable") from error
    except json.JSONDecodeError as error:
        raise BrokerError("GitHub App API returned malformed JSON") from error


def mint_installation_token() -> str:
    """Mint a short-lived installation token for source-inventory ``gh`` calls.

    Uses the same host App credentials as the push broker.  Fails closed with a
    typed ``BrokerError`` on any mint failure.  Never logs or returns the token
    outside the active request context.
    """
    if TEST_MODE:
        # Deterministic unit tests inject via env or accept the synthetic token.
        # Production never takes this branch.
        injected = os.environ.get("GLOOPS_GITHUB_READ_BROKER_TEST_TOKEN")
        if injected is not None:
            if not injected:
                raise BrokerError("GitHub App installation token mint failed")
            return injected
        return "ghs_test_mode_read_token"
    try:
        config = load_app_config()
        jwt = _app_jwt(config)
        # Installation-wide contents:read — no repository_ids pin so every repo
        # on the App installation (e.g. paperclip-gym) is reachable.  Single-repo
        # push mint remains on the write path and is untouched here.
        response = _request_json(
            "POST",
            f"/app/installations/{config['installationId']}/access_tokens",
            jwt,
            {"permissions": dict(SOURCE_INVENTORY_PERMISSIONS)},
        )
    except BrokerError:
        raise
    except Exception as error:
        raise BrokerError(
            f"GitHub App installation token mint failed: {type(error).__name__}"
        ) from error
    if not isinstance(response, dict):
        raise BrokerError("GitHub App installation token response is malformed")
    token = response.get("token")
    expires_at = response.get("expires_at")
    actual_permissions = response.get("permissions")
    if (
        not isinstance(token, str)
        or not token.startswith("ghs_")
        or any(char.isspace() for char in token)
    ):
        raise BrokerError("GitHub App installation token is malformed")
    if not isinstance(expires_at, str) or not isinstance(actual_permissions, dict):
        raise BrokerError("GitHub App installation token metadata is incomplete")
    expected = {**SOURCE_INVENTORY_PERMISSIONS, "metadata": "read"}
    normalized = {str(key): str(value) for key, value in actual_permissions.items()}
    if normalized != expected:
        raise BrokerError(
            "GitHub App installation token permissions exceed or miss the requested scope"
        )
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise BrokerError("GitHub App installation token expiry is malformed") from error
    seconds = (expiry - datetime.now(timezone.utc)).total_seconds()
    if seconds < 2700 or seconds > 3900:
        raise BrokerError(
            "GitHub App installation token expiry is outside the one-hour envelope"
        )
    return token


def revoke_installation_token(token: str) -> None:
    """Best-effort revoke of a short-lived installation token. Never raises."""
    if TEST_MODE or not token:
        return
    try:
        _request_json("DELETE", "/installation/token", token)
    except Exception:
        # Token expires within the one-hour envelope; do not fail the read path.
        return


def _gh_env_with_token(token: str, base: dict[str, str] | None = None) -> dict[str, str]:
    """Build a subprocess env that authenticates gh with the installation token.

    Copies the process environment (or an explicit base) and sets GH_TOKEN and
    GITHUB_TOKEN for this invocation only.  Never logs the token.
    """
    env = dict(os.environ if base is None else base)
    env["GH_TOKEN"] = token
    env["GITHUB_TOKEN"] = token
    return env


def _redact_token(text: str, token: str | None) -> str:
    if token and token in text:
        return text.replace(token, "[redacted]")
    return text


# ---------------------------------------------------------------------------
# gh CLI invocation
# ---------------------------------------------------------------------------

def run_gh(args: list[str], env: dict[str, str] | None = None) -> str:
    """Invoke the gh CLI and return stdout.  Raises BrokerError on failure.

    When a source-inventory installation token is active for the request, it is
    injected via GH_TOKEN / GITHUB_TOKEN for this subprocess only.
    """
    command = ["gh", *args]
    token = _active_installation_token.get()
    effective_env = env
    if token is not None:
        effective_env = _gh_env_with_token(token, env)
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=GH_TIMEOUT_SECONDS,
            env=effective_env,
        )
    except subprocess.TimeoutExpired:
        raise BrokerError("gh CLI timed out")
    except FileNotFoundError:
        raise BrokerError("gh CLI is not available")
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")[:500]
        stderr = _redact_token(stderr, token)
        raise BrokerError(f"gh CLI failed: {stderr}")
    output = result.stdout
    if len(output) > MAX_GH_OUTPUT_BYTES:
        raise BrokerError("gh CLI output exceeds the bounded-response ceiling")
    return output.decode("utf-8", errors="replace")


def gh_api(repo: str, path: str, fields: str, jq_filter: str | None = None) -> Any:
    """Call ``gh api`` for a single REST endpoint and return parsed JSON."""
    args = ["api", f"/repos/{repo}/{path}", "--paginate"]
    if fields:
        args.extend(["--field", f"fields={fields}"])
    raw = run_gh(args)
    if not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise BrokerError("gh API returned malformed JSON")
    if jq_filter:
        # We don't use jq from gh; we do field selection in Python
        pass
    return parsed


def gh_graphql(query: str) -> Any:
    """Call ``gh api graphql`` with the given query string."""
    raw = run_gh(["api", "graphql", "--field", f"query={query}"])
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise BrokerError("gh GraphQL returned malformed JSON")
    if isinstance(parsed, dict) and "errors" in parsed:
        errors = parsed["errors"]
        msg = errors[0].get("message", "unknown") if isinstance(errors, list) and errors else "unknown"
        raise BrokerError(f"GitHub GraphQL error: {str(msg)[:200]}")
    return parsed


# ---------------------------------------------------------------------------
# Operation handlers
# ---------------------------------------------------------------------------

def select_fields(items: Any, fields: tuple[str, ...]) -> Any:
    """Pick only the allowed fields from a dict or list of dicts."""
    if isinstance(items, list):
        return [select_fields(item, fields) for item in items]
    if isinstance(items, dict):
        return {k: items.get(k) for k in fields if k in items}
    return items


def validate_search_query(query: str) -> None:
    """Keep repository scope solely under the broker's allowlisted repo field."""
    if REPOSITORY_SCOPE_QUALIFIER_PATTERN.search(query):
        raise BrokerError("query may not contain repository-scope qualifiers")


def op_search_issues(params: dict[str, Any]) -> Any:
    q = params.get("query")
    if not isinstance(q, str) or not q.strip():
        raise BrokerError("query is required for search-issues")
    validate_search_query(q)
    repo = params.get("repo")
    if not isinstance(repo, str) or not REPOSITORY_PATTERN.match(repo):
        raise BrokerError("repo is required and must be owner/repo")
    limit = min(int(params.get("limit", SEARCH_RESULT_LIMIT)), SEARCH_RESULT_LIMIT)
    # Use gh search issues with JSON output
    args = [
        "search", "issues",
        q,
        "--repo", repo,
        "--json", ",".join(LIST_ISSUE_FIELDS),
        "--limit", str(limit),
    ]
    raw = run_gh(args)
    try:
        data = json.loads(raw) if raw.strip() else []
    except json.JSONDecodeError:
        raise BrokerError("gh search returned malformed JSON")
    return select_fields(data, LIST_ISSUE_FIELDS)


def op_list_issues(params: dict[str, Any]) -> Any:
    repo = params.get("repo")
    if not isinstance(repo, str) or not REPOSITORY_PATTERN.match(repo):
        raise BrokerError("repo is required and must be owner/repo")
    state = params.get("state", "open")
    if state not in ("open", "closed", "all"):
        raise BrokerError("state must be open, closed, or all")
    limit = min(int(params.get("limit", LIST_LIMIT)), LIST_LIMIT)
    args = [
        "issue", "list",
        "--repo", repo,
        "--state", state,
        "--json", ",".join(LIST_ISSUE_FIELDS),
        "--limit", str(limit),
    ]
    # Optional sort/label
    if "label" in params:
        label = params["label"]
        if not isinstance(label, str) or len(label) > 100:
            raise BrokerError("label must be a short string")
        args.extend(["--label", label])
    raw = run_gh(args)
    try:
        data = json.loads(raw) if raw.strip() else []
    except json.JSONDecodeError:
        raise BrokerError("gh issue list returned malformed JSON")
    return select_fields(data, LIST_ISSUE_FIELDS)


def op_get_issue(params: dict[str, Any]) -> Any:
    repo = params.get("repo")
    if not isinstance(repo, str) or not REPOSITORY_PATTERN.match(repo):
        raise BrokerError("repo is required and must be owner/repo")
    number = params.get("number")
    if not isinstance(number, int) or number < 1:
        raise BrokerError("number is required and must be a positive integer")
    args = [
        "issue", "view", str(number),
        "--repo", repo,
        "--json", ",".join(ISSUE_FIELDS),
    ]
    raw = run_gh(args)
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        raise BrokerError("gh issue view returned malformed JSON")
    return select_fields(data, ISSUE_FIELDS)


def op_search_prs(params: dict[str, Any]) -> Any:
    q = params.get("query")
    if not isinstance(q, str) or not q.strip():
        raise BrokerError("query is required for search-prs")
    validate_search_query(q)
    repo = params.get("repo")
    if not isinstance(repo, str) or not REPOSITORY_PATTERN.match(repo):
        raise BrokerError("repo is required and must be owner/repo")
    limit = min(int(params.get("limit", SEARCH_RESULT_LIMIT)), SEARCH_RESULT_LIMIT)
    args = [
        "search", "prs",
        q,
        "--repo", repo,
        "--json", ",".join(SEARCH_PR_FIELDS),
        "--limit", str(limit),
    ]
    raw = run_gh(args)
    try:
        data = json.loads(raw) if raw.strip() else []
    except json.JSONDecodeError:
        raise BrokerError("gh search returned malformed JSON")
    return select_fields(data, SEARCH_PR_FIELDS)


def op_list_prs(params: dict[str, Any]) -> Any:
    repo = params.get("repo")
    if not isinstance(repo, str) or not REPOSITORY_PATTERN.match(repo):
        raise BrokerError("repo is required and must be owner/repo")
    state = params.get("state", "open")
    if state not in ("open", "closed", "merged", "all"):
        raise BrokerError("state must be open, closed, merged, or all")
    limit = min(int(params.get("limit", LIST_LIMIT)), LIST_LIMIT)
    args = [
        "pr", "list",
        "--repo", repo,
        "--state", state,
        "--json", ",".join(LIST_PR_FIELDS),
        "--limit", str(limit),
    ]
    if "label" in params:
        label = params["label"]
        if not isinstance(label, str) or len(label) > 100:
            raise BrokerError("label must be a short string")
        args.extend(["--label", label])
    raw = run_gh(args)
    try:
        data = json.loads(raw) if raw.strip() else []
    except json.JSONDecodeError:
        raise BrokerError("gh pr list returned malformed JSON")
    return select_fields(data, LIST_PR_FIELDS)


def op_get_pr(params: dict[str, Any]) -> Any:
    repo = params.get("repo")
    if not isinstance(repo, str) or not REPOSITORY_PATTERN.match(repo):
        raise BrokerError("repo is required and must be owner/repo")
    number = params.get("number")
    if not isinstance(number, int) or number < 1:
        raise BrokerError("number is required and must be a positive integer")
    args = [
        "pr", "view", str(number),
        "--repo", repo,
        "--json", ",".join(PR_FIELDS),
    ]
    raw = run_gh(args)
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        raise BrokerError("gh pr view returned malformed JSON")
    return select_fields(data, PR_FIELDS)


def op_get_pr_status(params: dict[str, Any]) -> Any:
    repo = params.get("repo")
    if not isinstance(repo, str) or not REPOSITORY_PATTERN.match(repo):
        raise BrokerError("repo is required and must be owner/repo")
    number = params.get("number")
    if not isinstance(number, int) or number < 1:
        raise BrokerError("number is required and must be a positive integer")
    args = [
        "pr", "view", str(number),
        "--repo", repo,
        "--json", ",".join(PR_STATUS_FIELDS),
    ]
    raw = run_gh(args)
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        raise BrokerError("gh pr view returned malformed JSON")
    return select_fields(data, PR_STATUS_FIELDS)


def op_get_pr_checks(params: dict[str, Any]) -> Any:
    repo = params.get("repo")
    if not isinstance(repo, str) or not REPOSITORY_PATTERN.match(repo):
        raise BrokerError("repo is required and must be owner/repo")
    number = params.get("number")
    if not isinstance(number, int) or number < 1:
        raise BrokerError("number is required and must be a positive integer")
    args = [
        "pr", "checks", str(number),
        "--repo", repo,
        "--json", "name,state,startedAt,completedAt,link,bucket",
    ]
    raw = run_gh(args)
    try:
        data = json.loads(raw) if raw.strip() else []
    except json.JSONDecodeError:
        raise BrokerError("gh pr checks returned malformed JSON")
    return data


# ---------------------------------------------------------------------------
# Source-inventory operations (read-only, EXACT immutable commit only)
# ---------------------------------------------------------------------------

def _require_allowlisted_repo(params: dict[str, Any]) -> str:
    """Re-check the repo allowlist inside the handler (defense in depth).

    ``validate_request`` already gates the allowlist, but each source-inventory
    handler independently re-enforces it so no operation can be reached for a
    non-allowlisted repository even if request wiring changes.
    """
    repo = params.get("repo")
    if not isinstance(repo, str) or not REPOSITORY_PATTERN.match(repo):
        raise BrokerError("repo is required and must be owner/repo")
    if repo not in ALLOWED_REPOSITORIES:
        raise BrokerError(f"repository {repo} is not in the allowlist")
    return repo


def _require_exact_commit(params: dict[str, Any]) -> str:
    """Reject mutable/inexact refs; require an EXACT 40-char lowercase hex SHA."""
    commit = params.get("commit")
    if not isinstance(commit, str) or not COMMIT_SHA_PATTERN.fullmatch(commit):
        raise BrokerError(
            "commit must be an exact 40-character lowercase hex SHA; mutable "
            "refs (branch, tag, HEAD) and short/uppercase SHAs are rejected"
        )
    return commit


def _require_source_path(params: dict[str, Any]) -> str:
    """Reject path traversal / absolute paths BEFORE any gh call."""
    path = params.get("path")
    if not isinstance(path, str) or not path:
        raise BrokerError("path is required")
    return _validate_relative_path(path, "path")


def _require_source_path_prefix(params: dict[str, Any]) -> str:
    """Validate the optional directory prefix for hierarchical tree traversal.

    Unlike ``_require_source_path`` an absent/empty prefix is allowed and means
    the repository root.  A non-empty prefix is validated with the identical
    traversal / absolute-path / illegal-character guards so no ``..`` component,
    leading ``/``, backslash, or NUL can reach a ``gh`` call.
    """
    prefix = params.get("pathPrefix")
    if prefix is None or prefix == "":
        return ""
    if not isinstance(prefix, str):
        raise BrokerError("pathPrefix must be a repo-relative directory string")
    return _validate_relative_path(prefix, "pathPrefix")


def _resolve_commit_tree(repo: str, commit: str) -> str:
    """Resolve an EXACT commit to its root tree SHA, verifying the commit exists.

    Confirms the resolved object name equals the requested commit (defeats a
    server-side redirect to a different object) and returns the root tree SHA.
    """
    raw = run_gh(["api", f"/repos/{repo}/commits/{commit}"])
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        raise BrokerError("gh API returned malformed JSON")
    if not isinstance(data, dict):
        raise BrokerError("gh API returned an unexpected commit payload")
    if data.get("sha") != commit:
        raise BrokerError(
            "commit SHA verification failed: resolved object does not equal "
            "the requested commit"
        )
    commit_obj = data.get("commit")
    tree_sha = None
    if isinstance(commit_obj, dict):
        tree = commit_obj.get("tree")
        if isinstance(tree, dict):
            tree_sha = tree.get("sha")
    if not isinstance(tree_sha, str) or not COMMIT_SHA_PATTERN.fullmatch(tree_sha):
        raise BrokerError("commit does not resolve to an exact root tree SHA")
    return tree_sha


def _validate_tree_entry(entry: Any) -> dict[str, Any]:
    """Fail CLOSED on any malformed tree row.

    Every entry must be an object carrying a known type, an exact 40-hex object
    SHA, and a bounded immediate name with no separators/traversal.  A malformed
    row is NEVER silently dropped -- dropping it would present a partial
    directory as exact evidence.
    """
    if not isinstance(entry, dict):
        raise BrokerError("tree entry is not an object; refusing partial inventory")
    entry_type = entry.get("type")
    if entry_type not in TREE_ENTRY_TYPES:
        raise BrokerError("tree entry has an unknown or missing type")
    sha = entry.get("sha")
    if not isinstance(sha, str) or not COMMIT_SHA_PATTERN.fullmatch(sha):
        raise BrokerError("tree entry is missing an exact 40-hex object SHA")
    name = entry.get("path")
    if not isinstance(name, str) or not is_safe_path_component(name):
        raise BrokerError(
            "tree entry name is missing, empty, a '.'/'..', separator, NUL, or "
            "control component"
        )
    # Mode must be type-consistent; a mismatch is malformed exact-tree evidence.
    mode = entry.get("mode")
    mode_ok = (
        (entry_type == "tree" and mode == TREE_MODE)
        or (entry_type == "commit" and mode == COMMIT_MODE)
        or (entry_type == "blob" and mode in BLOB_MODES)
    )
    if not mode_ok:
        raise BrokerError("tree entry mode is missing or inconsistent with its type")
    # Size: any value present must be a nonnegative int (never bool/float/neg);
    # a blob MUST carry one, while trees/commits legitimately omit it.
    size = entry.get("size")
    if entry_type == "blob":
        if type(size) is not int or size < 0:
            raise BrokerError("tree entry blob is missing a valid nonnegative size")
    elif size is not None and (type(size) is not int or size < 0):
        raise BrokerError("tree entry has an invalid size")
    return entry


def _read_tree_object(repo: str, tree_sha: str) -> list[dict[str, Any]]:
    """Read ONE tree object NON-recursively (never ``recursive=1``), FAIL CLOSED.

    Returns the directory's immediate entries.  Every integrity failure raises a
    TYPED ``BrokerError`` instead of returning a partial/empty directory as exact
    evidence: an over-ceiling response, a missing/mismatched response SHA, an
    upstream ``truncated`` flag, a non-list ``tree``, more than
    ``MAX_TREE_ENTRIES`` immediate entries, or any malformed entry row.  The
    over-limit and truncation checks live HERE so both intermediate prefix-walk
    directories and the final target directory are covered identically.
    """
    if not COMMIT_SHA_PATTERN.fullmatch(tree_sha):
        raise BrokerError("tree object name must be an exact 40-character hex SHA")
    try:
        raw = run_gh(["api", f"/repos/{repo}/git/trees/{tree_sha}"])
    except BrokerError as error:
        if "exceeds the bounded-response ceiling" in str(error):
            raise BrokerError(
                "single directory tree object exceeds the upstream response "
                "ceiling; narrow the pathPrefix to a smaller subtree"
            )
        raise
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        raise BrokerError("gh API returned malformed JSON")
    if not isinstance(data, dict):
        raise BrokerError("gh API returned an unexpected tree payload")
    if data.get("sha") != tree_sha:
        raise BrokerError("tree object SHA verification failed")
    if bool(data.get("truncated")):
        raise BrokerError(
            "upstream truncated this directory listing; the inventory would be "
            "incomplete"
        )
    tree = data.get("tree")
    if not isinstance(tree, list):
        raise BrokerError("tree object is missing a well-formed entry list")
    if len(tree) > MAX_TREE_ENTRIES:
        raise BrokerError(
            "single directory exceeds the bounded immediate-entry limit; a Git "
            "tree object has no continuation cursor so the listing fails closed "
            "rather than dropping entries"
        )
    return [_validate_tree_entry(entry) for entry in tree]


def op_get_repo_source_metadata(params: dict[str, Any]) -> Any:
    repo = _require_allowlisted_repo(params)
    commit = _require_exact_commit(params)
    tree_sha = _resolve_commit_tree(repo, commit)
    repo_raw = run_gh(["api", f"/repos/{repo}"])
    try:
        repo_data = json.loads(repo_raw) if repo_raw.strip() else None
    except json.JSONDecodeError:
        raise BrokerError("gh API returned malformed JSON")
    # FAIL CLOSED: a malformed or mismatched repository payload must never be
    # synthesized into a trusted answer.
    if not isinstance(repo_data, dict):
        raise BrokerError("gh API returned an unexpected repository payload")
    full_name = repo_data.get("full_name")
    # EXACT equality: GitHub's canonical full_name and the allowlist entries are
    # canonical, so a case-only variant (gloopsAI/Gloops-UI) must FAIL closed.
    if not isinstance(full_name, str) or full_name != repo:
        raise BrokerError(
            "repository identity verification failed: resolved full_name does "
            "not equal the requested owner/repo"
        )
    default_branch = repo_data.get("default_branch")
    if not isinstance(default_branch, str) or not default_branch:
        raise BrokerError("repository metadata is missing a default branch")
    return {
        "repo": repo,
        "commit": commit,
        "tree": tree_sha,
        "default_branch": default_branch,
    }


def op_list_source_tree(params: dict[str, Any]) -> Any:
    """Return ONE directory's immediate entries via non-recursive tree walking.

    Resolves the exact commit to its root tree, walks the requested ``pathPrefix``
    one component at a time through non-recursive ``git/trees`` reads, and returns
    the immediate entries (with child tree SHAs and types) of the target
    directory.  A single directory that reports more than ``MAX_TREE_ENTRIES``
    immediate entries -- or that the upstream marks ``truncated`` -- FAILS TYPED
    and CLOSED: a Git tree object has no in-object continuation cursor, so any
    silent slice would drop entries and recreate the incomplete-inventory defect.
    """
    repo = _require_allowlisted_repo(params)
    commit = _require_exact_commit(params)
    prefix = _require_source_path_prefix(params)

    root_tree_sha = _resolve_commit_tree(repo, commit)
    current_tree_sha = root_tree_sha
    walked: list[str] = []

    if prefix:
        for component in prefix.split("/"):
            # Each intermediate directory read is fully integrity-checked and
            # fails closed on truncation / over-limit / malformed rows here.
            entries = _read_tree_object(repo, current_tree_sha)
            match = next(
                (
                    entry
                    for entry in entries
                    if entry.get("path") == component and entry.get("type") == "tree"
                ),
                None,
            )
            if match is None:
                raise BrokerError(
                    "pathPrefix does not resolve to a directory at component "
                    f"'{component}'"
                )
            # sha was already validated to be an exact 40-hex object name.
            current_tree_sha = match["sha"]
            walked.append(component)

    entries = _read_tree_object(repo, current_tree_sha)

    # Deterministic sort by immediate entry name.
    ordered = sorted(entries, key=lambda entry: str(entry.get("path") or ""))
    bounded = select_fields(ordered, TREE_ENTRY_FIELDS)
    return {
        "repo": repo,
        "commit": commit,
        "rootTree": root_tree_sha,
        "pathPrefix": prefix,
        "treeSha": current_tree_sha,
        "truncated": False,
        "totalReturned": len(bounded),
        "entries": bounded,
    }


def op_get_source_file(params: dict[str, Any]) -> Any:
    repo = _require_allowlisted_repo(params)
    commit = _require_exact_commit(params)
    path = _require_source_path(params)
    # URL-encode each reserved character in the contents path (``[``, ``]``,
    # space, ...) while preserving the ``/`` directory separators.  The commit is
    # already an exact 40-hex SHA and is safe to interpolate as the ref.
    encoded_path = quote(path, safe="/")
    raw = run_gh(["api", f"/repos/{repo}/contents/{encoded_path}?ref={commit}"])
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        raise BrokerError("gh API returned malformed JSON")
    if isinstance(data, list) or not isinstance(data, dict) or data.get("type") != "file":
        raise BrokerError("path does not reference a single file")
    # FAIL CLOSED on identity: the upstream object must be the exact path we
    # asked for, carry an exact blob SHA, and later reconcile its reported size
    # to the decoded byte count.  Otherwise the broker would echo the REQUESTED
    # coordinates as if verified against unrelated content.
    if data.get("path") != path:
        raise BrokerError(
            "source path verification failed: resolved path does not equal the "
            "requested path"
        )
    blob_sha = data.get("sha")
    if not isinstance(blob_sha, str) or not COMMIT_SHA_PATTERN.fullmatch(blob_sha):
        raise BrokerError("source file is missing an exact blob SHA")
    reported_size = data.get("size")
    if not isinstance(reported_size, int) or isinstance(reported_size, bool) or reported_size < 0:
        raise BrokerError("source file has a missing or invalid size")
    if reported_size > MAX_SOURCE_FILE_BYTES:
        raise BrokerError("source file exceeds the maximum size")
    if data.get("encoding") != "base64" or not isinstance(data.get("content"), str):
        raise BrokerError("gh API returned an unexpected file encoding")
    # GitHub documents base64 content wrapped with embedded newlines.  Normalize
    # ONLY that documented whitespace, then decode with STRICT validation so any
    # non-base64 / malformed content FAILS CLOSED instead of being silently
    # repaired by discarding out-of-alphabet bytes (the validate=False defect).
    normalized = data["content"].replace("\n", "").replace("\r", "")
    try:
        raw_bytes = base64.b64decode(normalized, validate=True)
    except (binascii.Error, ValueError):
        raise BrokerError("source file content is not valid base64")
    if len(raw_bytes) > MAX_SOURCE_FILE_BYTES:
        raise BrokerError("source file exceeds the maximum size")
    # Reconcile the upstream-declared blob size with what we actually decoded.
    if reported_size != len(raw_bytes):
        raise BrokerError(
            "source file size does not match the decoded byte count"
        )
    if b"\x00" in raw_bytes:
        raise BrokerError("source file is not UTF-8 text")
    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise BrokerError("source file is not UTF-8 text")
    return {
        "repo": repo,
        "commit": commit,
        "path": path,
        "sha": blob_sha,
        "encoding": "utf-8",
        "content": text,
        "size": len(raw_bytes),
    }


OPERATIONS = {
    "search-issues": op_search_issues,
    "list-issues": op_list_issues,
    "get-issue": op_get_issue,
    "search-prs": op_search_prs,
    "list-prs": op_list_prs,
    "get-pr": op_get_pr,
    "get-pr-status": op_get_pr_status,
    "get-pr-checks": op_get_pr_checks,
    "get-repo-source-metadata": op_get_repo_source_metadata,
    "list-source-tree": op_list_source_tree,
    "get-source-file": op_get_source_file,
}


# ---------------------------------------------------------------------------
# Request validation and processing
# ---------------------------------------------------------------------------

def validate_request(request: dict[str, Any]) -> None:
    operation = request.get("operation")
    if not isinstance(operation, str) or operation not in ALLOWED_OPERATIONS:
        raise BrokerError(f"operation must be one of: {', '.join(sorted(ALLOWED_OPERATIONS))}")

    repo = request.get("repo")
    if isinstance(repo, str):
        if not REPOSITORY_PATTERN.match(repo):
            raise BrokerError("repo must be in owner/repo format")
        if repo not in ALLOWED_REPOSITORIES:
            raise BrokerError(f"repository {repo} is not in the allowlist")


def process_request(request: dict[str, Any]) -> dict[str, Any]:
    validate_request(request)
    operation = request["operation"]
    handler = OPERATIONS[operation]
    token: str | None = None
    token_handle: contextvars.Token[str | None] | None = None
    try:
        if operation in SOURCE_INVENTORY_OPERATIONS:
            # Fail closed before any gh call when App mint cannot complete.
            token = mint_installation_token()
            token_handle = _active_installation_token.set(token)
        data = handler(request)
        data = strip_credentials(data)
        # Defense in depth: never echo a minted token even if upstream mirrored it.
        if token:
            serialized = canonical_json(data)
            if token in serialized:
                raise BrokerError("response would leak a credential")
        return {"ok": True, "data": data}
    finally:
        if token_handle is not None:
            _active_installation_token.reset(token_handle)
        if token is not None:
            revoke_installation_token(token)


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


def handle_connection(client: socket.socket) -> None:
    response: dict[str, Any]
    try:
        verify_peer(client)
        request = read_request(client)
        response = process_request(request)
    except BrokerError as error:
        response = {"ok": False, "error": str(error)[:500]}
    except Exception as error:
        response = {"ok": False, "error": f"internal error: {type(error).__name__}"}
    payload = bound_output(response)
    client.sendall(payload + b"\n")


def serve() -> None:
    if os.geteuid() != 0 and not TEST_MODE:
        raise BrokerError("run as root")
    ensure_dirs()
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(SOCKET_PATH))
    if not TEST_MODE:
        os.chown(SOCKET_PATH, 0, HERMES_GID)
        os.chmod(SOCKET_PATH, 0o660)
    listener.listen(8)
    try:
        while True:
            client, _address = listener.accept()
            with client:
                handle_connection(client)
    finally:
        listener.close()
        try:
            SOCKET_PATH.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"serve", "check"}:
        raise BrokerError("usage: github-read-broker.py serve|check")
    if sys.argv[1] == "check":
        # Verify gh is available
        try:
            run_gh(["auth", "status"], env={**os.environ, "GH_FORCE_TTY": "0"})
            print("github-read-broker: gh authentication is available")
        except BrokerError:
            print("github-read-broker: gh authentication is not available", file=sys.stderr)
            raise SystemExit(1)
        return 0
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
        print(f"github-read-broker: {error}", file=sys.stderr)
        raise SystemExit(1)
