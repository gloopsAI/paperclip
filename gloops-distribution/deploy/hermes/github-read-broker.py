#!/usr/bin/env python3
"""Root-owned read-only GitHub evidence broker.

Serves bounded, read-only GitHub issue/PR evidence for the allowlisted
Induct repositories over a peer-authenticated Unix socket.  Uses the existing
root ``gh`` CLI authentication without copying, printing, mounting, or
returning credentials.  A separate socket from the one-run push broker so the
push path is untouched.

Request schema (single JSON object, one per connection)::

    {"operation": "<op>", "repo": "<owner/repo>", ...}

Response schema::

    {"ok": true,  "data": <bounded json>}
    {"ok": false, "error": "<message>"}

No credential, token, header, or secret is ever placed in a response.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CONFIG_DIR = Path(os.environ.get("GLOOPS_GITHUB_BROKER_CONFIG_DIR", "/etc/paperclip-gloops"))
RUNTIME_DIR = Path(os.environ.get("GLOOPS_GITHUB_READ_BROKER_RUNTIME_DIR", "/run/paperclip-github-read-broker"))
SOCKET_PATH = RUNTIME_DIR / "broker.sock"
COMMAND_LOCK = Path(os.environ.get("GLOOPS_GITHUB_READ_BROKER_LOCK", "/var/lib/paperclip-gloops/github-read-broker/command.lock"))
STATE_DIR = Path(os.environ.get("GLOOPS_GITHUB_READ_BROKER_STATE_DIR", "/var/lib/paperclip-gloops/github-read-broker"))

ALLOWED_REPOSITORIES = frozenset({
    "InductAI/induct",
    "InductAI/induct-knowledge",
})

REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
REPOSITORY_SCOPE_QUALIFIER_PATTERN = re.compile(
    r"(?i)(?:^|\s)(?:repo|org|user):"
)

ALLOWED_OPERATIONS = frozenset({
    "search-issues",
    "list-issues",
    "get-issue",
    "search-prs",
    "list-prs",
    "get-pr",
    "get-pr-status",
    "get-pr-checks",
})

MAX_REQUEST_BYTES = 8 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
MAX_GH_OUTPUT_BYTES = 512 * 1024
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
# gh CLI invocation
# ---------------------------------------------------------------------------

def run_gh(args: list[str], env: dict[str, str] | None = None) -> str:
    """Invoke the gh CLI and return stdout.  Raises BrokerError on failure."""
    command = ["gh", *args]
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=GH_TIMEOUT_SECONDS,
            env=env,
        )
    except subprocess.TimeoutExpired:
        raise BrokerError("gh CLI timed out")
    except FileNotFoundError:
        raise BrokerError("gh CLI is not available")
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")[:500]
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


OPERATIONS = {
    "search-issues": op_search_issues,
    "list-issues": op_list_issues,
    "get-issue": op_get_issue,
    "search-prs": op_search_prs,
    "list-prs": op_list_prs,
    "get-pr": op_get_pr,
    "get-pr-status": op_get_pr_status,
    "get-pr-checks": op_get_pr_checks,
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
    data = handler(request)
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
