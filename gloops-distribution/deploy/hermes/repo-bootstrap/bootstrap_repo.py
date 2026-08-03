#!/usr/bin/env python3
"""Materialize an allowlisted repo at an exact 40-char SHA into a managed path (C6).

Hermes-side bootstrap so operators do not rsync from a Mac. Auth reuses the
GitHub App credential pattern from github-read-broker / github-app-credentials
(``/etc/paperclip-gloops/github-app.json`` + private key).

Fail closed when:
  - SHA is not full 40-char lowercase hex
  - repo is not allowlisted
  - dest is outside allowlisted roots

Dry-run is the default for the CLI; library callers pass dry_run explicitly.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

ALLOWED_REPOSITORIES = frozenset(
    {
        "gloopsAI/gloops-ui",
        "gloopsAI/paperclip",
        "gloopsAI/paperclip-gym",
        "InductAI/induct",
        "InductAI/induct-knowledge",
    }
)

DEFAULT_DEST_ROOTS = (
    "/opt/data/workspace/",
    "/opt/paperclip/hermes-execution-state/workspace/",
)

CONFIG_DIR = Path(os.environ.get("GLOOPS_GITHUB_BROKER_CONFIG_DIR", "/etc/paperclip-gloops"))
APP_CONFIG_PATH = Path(
    os.environ.get(
        "GLOOPS_REPO_BOOTSTRAP_APP_CONFIG",
        str(CONFIG_DIR / "github-app.json"),
    )
)
GITHUB_API_BASE = os.environ.get("GLOOPS_GITHUB_API_BASE", "https://api.github.com").rstrip("/")
ENV_DEST_ROOTS = "REPO_BOOTSTRAP_DEST_ROOTS"
ENV_TEST_MODE = "REPO_BOOTSTRAP_TEST_MODE"
ENV_TEST_TOKEN = "REPO_BOOTSTRAP_TEST_TOKEN"
ENV_GIT_BIN = "REPO_BOOTSTRAP_GIT"


def test_mode() -> bool:
    """Runtime check so tests can enable after import."""
    return os.environ.get(ENV_TEST_MODE) == "1"


class BootstrapError(RuntimeError):
    """Typed fail-closed bootstrap error."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_dict(self) -> dict[str, Any]:
        return {"ok": False, "errorCode": self.code, "error": self.message}


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def require_sha40(value: str) -> str:
    if not isinstance(value, str):
        raise BootstrapError("invalid_sha", "sha must be a string")
    normalized = value.strip().lower()
    if not SHA40_RE.fullmatch(normalized):
        raise BootstrapError(
            "invalid_sha",
            f"sha must be full 40-char lowercase hex (got {value!r}); branch names forbidden",
        )
    return normalized


def require_repo(value: str) -> str:
    if not isinstance(value, str) or not REPO_RE.fullmatch(value):
        raise BootstrapError("invalid_repo", f"repo must be owner/name, got {value!r}")
    if value not in ALLOWED_REPOSITORIES:
        raise BootstrapError(
            "repo_not_allowlisted",
            f"repo {value!r} not in allowlist: {sorted(ALLOWED_REPOSITORIES)}",
        )
    return value


def dest_roots() -> list[Path]:
    raw = os.environ.get(ENV_DEST_ROOTS)
    parts = [p.strip() for p in raw.split(":") if p.strip()] if raw else list(DEFAULT_DEST_ROOTS)
    return [Path(p).resolve() for p in parts]


def require_dest(dest: str | Path) -> Path:
    path = Path(dest).expanduser()
    # Resolve parent if dest does not exist yet
    try:
        resolved = path.resolve() if path.exists() else (path.parent.resolve() / path.name)
    except OSError as error:
        raise BootstrapError("invalid_dest", f"dest unresolvable: {error}") from error
    roots = dest_roots()
    for root in roots:
        try:
            resolved.relative_to(root)
            return resolved
        except ValueError:
            continue
    raise BootstrapError(
        "dest_not_allowlisted",
        f"dest {resolved} outside allowlist roots: {', '.join(str(r) for r in roots)}",
    )


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def load_app_config(path: Path = APP_CONFIG_PATH) -> dict[str, object]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise BootstrapError("app_config_unreadable", f"GitHub App config unreadable: {error}") from error
    except json.JSONDecodeError as error:
        raise BootstrapError("app_config_malformed", "GitHub App config is malformed JSON") from error
    if not isinstance(raw, dict):
        raise BootstrapError("app_config_malformed", "GitHub App config must be an object")
    required = {
        "appId",
        "installationId",
        "repositoryId",
        "repository",
        "privateKeyPath",
        "boardTokenPath",
    }
    if set(raw) != required:
        raise BootstrapError("app_config_keys", "GitHub App config keys do not match the allowlist")
    return raw


def app_jwt(config: dict[str, object]) -> str:
    key_path = Path(str(config["privateKeyPath"]))
    try:
        key_stat = key_path.stat()
    except OSError as error:
        raise BootstrapError("private_key_unreadable", "GitHub App private key unreadable") from error
    mode = stat.S_IMODE(key_stat.st_mode)
    if not test_mode() and (key_stat.st_uid != 0 or mode not in {0o400, 0o600}):
        raise BootstrapError(
            "private_key_mode",
            "GitHub App private key must be root-owned mode 0400 or 0600",
        )
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
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        raise BootstrapError("jwt_sign_failed", "GitHub App JWT signing failed") from error
    return f"{unsigned}.{_b64url(signature)}"


def request_json(method: str, path: str, token: str, body: object | None = None) -> object:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = Request(
        f"{GITHUB_API_BASE}{path}",
        data=data,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "gloops-repo-bootstrap/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            payload = response.read()
            return {} if not payload else json.loads(payload)
    except HTTPError as error:
        raise BootstrapError(
            "github_api_http",
            f"GitHub API {method} {path} returned {error.code}",
        ) from error
    except URLError as error:
        raise BootstrapError("github_api_unavailable", f"GitHub API unavailable: {error}") from error


def mint_installation_token(
    config: dict[str, object] | None = None,
    *,
    mint_fn: Callable[[], str] | None = None,
) -> str:
    """Mint short-lived installation token with contents:read (clone/fetch)."""
    if mint_fn is not None:
        return mint_fn()
    if test_mode():
        injected = os.environ.get(ENV_TEST_TOKEN)
        if injected is not None:
            if not injected:
                raise BootstrapError("token_mint_failed", "test token empty")
            return injected
        return "ghs_test_mode_bootstrap_token"
    cfg = config or load_app_config()
    jwt = app_jwt(cfg)
    response = request_json(
        "POST",
        f"/app/installations/{cfg['installationId']}/access_tokens",
        jwt,
        {"permissions": {"contents": "read"}},
    )
    if not isinstance(response, dict):
        raise BootstrapError("token_mint_failed", "installation token response malformed")
    token = response.get("token")
    if not isinstance(token, str) or not token.startswith("ghs_"):
        raise BootstrapError("token_mint_failed", "installation token malformed")
    return token


def revoke_installation_token(token: str) -> None:
    if test_mode() or not token or token.startswith("ghs_test_"):
        return
    try:
        request_json("DELETE", "/installation/token", token)
    except BootstrapError:
        return


def git_bin() -> str:
    return os.environ.get(ENV_GIT_BIN, "git")


def run_git(
    args: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [git_bin(), *args],
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        capture_output=True,
        check=check,
    )


def clone_url(repo: str, token: str | None) -> str:
    """HTTPS clone URL. Token embedded only for authenticated clone (never logged)."""
    if token:
        return f"https://x-access-token:{token}@github.com/{repo}.git"
    return f"https://github.com/{repo}.git"


def public_clone_url(repo: str) -> str:
    return f"https://github.com/{repo}.git"


def redact(text: str, token: str | None) -> str:
    if token and token in text:
        return text.replace(token, "[redacted]")
    return text


def materialize(
    *,
    repo: str,
    sha: str,
    dest: str | Path,
    dry_run: bool = True,
    token: str | None = None,
    mint_fn: Callable[[], str] | None = None,
    fetch_if_exists: bool = True,
) -> dict[str, Any]:
    """Materialize repo@sha into dest. Returns JSON-able report."""
    repo_name = require_repo(repo)
    full_sha = require_sha40(sha)
    dest_path = require_dest(dest)

    planned = [
        f"allowlist repo={repo_name}",
        f"allowlist dest={dest_path}",
        f"exact sha={full_sha}",
        "mint installation token (contents:read)" if token is None else "use provided token",
        "git clone or fetch",
        f"git checkout --detach {full_sha}",
        "verify HEAD",
        "set remote url without embedded token",
    ]

    if dry_run:
        return {
            "ok": True,
            "dryRun": True,
            "ts": timestamp(),
            "repo": repo_name,
            "sha": full_sha,
            "dest": str(dest_path),
            "exists": dest_path.exists(),
            "planned": planned,
        }

    owned_token = False
    active_token = token
    try:
        if active_token is None:
            active_token = mint_installation_token(mint_fn=mint_fn)
            owned_token = True

        env = dict(os.environ)
        # Prefer header auth via extraheader to avoid token in remote URL persistence
        # but clone URL with token is most portable; we scrub remotes after.
        auth_url = clone_url(repo_name, active_token)
        executed: list[str] = []

        if dest_path.exists() and (dest_path / ".git").exists():
            if not fetch_if_exists:
                raise BootstrapError("dest_exists", f"dest already exists: {dest_path}")
            # Fetch into existing worktree
            run_git(["remote", "set-url", "origin", auth_url], cwd=dest_path, check=False)
            fetch = run_git(
                ["fetch", "--no-tags", "--depth=1", "origin", full_sha],
                cwd=dest_path,
                env=env,
                check=False,
            )
            if fetch.returncode != 0:
                # deepen / unshallow fallback
                fetch = run_git(
                    ["fetch", "--no-tags", "origin", full_sha],
                    cwd=dest_path,
                    env=env,
                    check=False,
                )
            if fetch.returncode != 0:
                raise BootstrapError(
                    "git_fetch_failed",
                    redact(fetch.stderr or fetch.stdout or "fetch failed", active_token),
                )
            executed.append("git fetch origin <sha>")
            co = run_git(["checkout", "--detach", full_sha], cwd=dest_path, check=False)
            if co.returncode != 0:
                raise BootstrapError(
                    "git_checkout_failed",
                    redact(co.stderr or "checkout failed", active_token),
                )
            executed.append(f"git checkout --detach {full_sha}")
        else:
            if dest_path.exists() and any(dest_path.iterdir()):
                raise BootstrapError(
                    "dest_not_empty",
                    f"dest exists and is not a git worktree: {dest_path}",
                )
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            # Clone with blob filter optional; pin to sha via fetch after
            # Use temporary clone dir then move for atomicity
            with tempfile.TemporaryDirectory(dir=str(dest_path.parent)) as tmp:
                tmp_path = Path(tmp) / "repo"
                clone = run_git(
                    [
                        "clone",
                        "--no-checkout",
                        auth_url,
                        str(tmp_path),
                    ],
                    env=env,
                    check=False,
                )
                if clone.returncode != 0:
                    raise BootstrapError(
                        "git_clone_failed",
                        redact(clone.stderr or clone.stdout or "clone failed", active_token),
                    )
                executed.append("git clone --no-checkout")
                fetch = run_git(
                    ["fetch", "--no-tags", "origin", full_sha],
                    cwd=tmp_path,
                    env=env,
                    check=False,
                )
                if fetch.returncode != 0:
                    # full fetch fallback
                    fetch = run_git(["fetch", "--no-tags", "origin"], cwd=tmp_path, env=env, check=False)
                if fetch.returncode != 0:
                    raise BootstrapError(
                        "git_fetch_failed",
                        redact(fetch.stderr or "fetch failed", active_token),
                    )
                executed.append("git fetch origin <sha>")
                co = run_git(["checkout", "--detach", full_sha], cwd=tmp_path, check=False)
                if co.returncode != 0:
                    raise BootstrapError(
                        "git_checkout_failed",
                        redact(co.stderr or "checkout failed", active_token),
                    )
                executed.append(f"git checkout --detach {full_sha}")
                if dest_path.exists():
                    shutil.rmtree(dest_path)
                shutil.move(str(tmp_path), str(dest_path))
                executed.append(f"move → {dest_path}")

        # Scrub token from remote URL
        run_git(["remote", "set-url", "origin", public_clone_url(repo_name)], cwd=dest_path, check=False)
        executed.append("remote set-url origin (token scrubbed)")

        head = run_git(["rev-parse", "HEAD"], cwd=dest_path, check=True).stdout.strip().lower()
        executed.append("git rev-parse HEAD")
        if head != full_sha:
            raise BootstrapError(
                "head_mismatch",
                f"HEAD {head} != expected {full_sha}",
            )

        return {
            "ok": True,
            "dryRun": False,
            "ts": timestamp(),
            "repo": repo_name,
            "sha": full_sha,
            "dest": str(dest_path),
            "head": head,
            "executed": executed,
        }
    finally:
        if owned_token and active_token:
            revoke_installation_token(active_token)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", required=True, help="owner/name (allowlisted)")
    p.add_argument("--sha", required=True, help="exact 40-char commit SHA")
    p.add_argument("--dest", required=True, help="destination path under allowlist roots")
    p.add_argument(
        "--apply",
        action="store_true",
        help="Actually clone/checkout (default dry-run)",
    )
    p.add_argument(
        "--no-fetch-if-exists",
        action="store_true",
        help="Fail if dest already exists as git worktree",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = materialize(
            repo=args.repo,
            sha=args.sha,
            dest=args.dest,
            dry_run=not args.apply,
            fetch_if_exists=not args.no_fetch_if_exists,
        )
        print(json.dumps(report, sort_keys=True, indent=2))
        return 0
    except BootstrapError as error:
        print(json.dumps({**error.as_dict(), "ts": timestamp()}, sort_keys=True, indent=2), file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError) as error:
        print(
            json.dumps(
                {"ok": False, "errorCode": "internal", "error": str(error), "ts": timestamp()},
                sort_keys=True,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
