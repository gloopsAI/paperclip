#!/usr/bin/env python3
"""Induct-only GitHub App token mint (Option A — separate from paperclip write App).

Config (root-owned): /etc/paperclip-gloops/github-app-induct.json
  {
    "appId": <int>,
    "installationId": <int>,
    "repositoryId": <int>,   # InductAI/induct numeric id
    "repository": "InductAI/induct",
    "privateKeyPath": "/etc/paperclip-gloops/github-app-induct/private-key.pem"
  }

Never prints the token to stdout unless --print-token (operator debug only).
Default: mint and write to a sealed temp path or export via fd.

CLI:
  induct-github-app.py status
  induct-github-app.py mint --permissions read|write
  induct-github-app.py clone --sha <40hex> --dest <path>   # uses contents:read
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CONFIG = Path(os.environ.get("INDUCT_GITHUB_APP_CONFIG", "/etc/paperclip-gloops/github-app-induct.json"))
ALLOWED_REPOS = frozenset({"InductAI/induct", "InductAI/induct-knowledge"})
SHA40 = re.compile(r"^[0-9a-f]{40}$")
GITHUB_API = os.environ.get("GLOOPS_GITHUB_API_BASE", "https://api.github.com").rstrip("/")


class InductAppError(RuntimeError):
    pass


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def load_config() -> dict:
    if not CONFIG.is_file():
        raise InductAppError(
            f"missing config {CONFIG}; install the repository-scoped Induct GitHub App configuration"
        )
    raw = json.loads(CONFIG.read_text())
    required = {"appId", "installationId", "repositoryId", "repository", "privateKeyPath"}
    if set(raw) != required:
        raise InductAppError(f"config keys must be exactly {sorted(required)}")
    if raw["repository"] not in ALLOWED_REPOS:
        raise InductAppError(f"repository must be one of {sorted(ALLOWED_REPOS)}")
    for k in ("appId", "installationId", "repositoryId"):
        if not isinstance(raw[k], int) or raw[k] <= 0:
            raise InductAppError(f"{k} must be positive int")
    return raw


def app_jwt(cfg: dict) -> str:
    key_path = Path(str(cfg["privateKeyPath"]))
    st = key_path.stat()
    mode = stat.S_IMODE(st.st_mode)
    if st.st_uid != 0 or mode not in {0o400, 0o600}:
        raise InductAppError("private key must be root-owned 0400/0600")
    now = int(datetime.now(timezone.utc).timestamp())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(
        json.dumps({"iat": now - 60, "exp": now + 540, "iss": cfg["appId"]}, separators=(",", ":")).encode()
    )
    unsigned = f"{header}.{payload}"
    sig = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(key_path)],
        input=unsigned.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    ).stdout
    return f"{unsigned}.{b64url(sig)}"


def request_json(method: str, path: str, token: str, body: object | None = None) -> object:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    req = urllib.request.Request(
        f"{GITHUB_API}{path}",
        data=data,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "gloops-induct-github-app/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read()
            return {} if not raw else json.loads(raw)
    except urllib.error.HTTPError as e:
        raise InductAppError(f"GitHub API {method} {path} -> {e.code}: {e.read()[:200]!r}") from e


def mint(cfg: dict, *, write: bool) -> str:
    perms = {"contents": "write", "pull_requests": "write", "metadata": "read"} if write else {
        "contents": "read",
        "metadata": "read",
    }
    jwt = app_jwt(cfg)
    resp = request_json(
        "POST",
        f"/app/installations/{cfg['installationId']}/access_tokens",
        jwt,
        {"repository_ids": [cfg["repositoryId"]], "permissions": perms},
    )
    if not isinstance(resp, dict):
        raise InductAppError("token response malformed")
    token = resp.get("token")
    if not isinstance(token, str) or not token.startswith("ghs_"):
        raise InductAppError("installation token missing")
    # verify repository boundary
    repos = request_json("GET", "/installation/repositories?per_page=100", token)
    if not isinstance(repos, dict):
        raise InductAppError("installation inventory malformed")
    names = [r.get("full_name") for r in (repos.get("repositories") or []) if isinstance(r, dict)]
    if cfg["repository"] not in names:
        raise InductAppError(f"token cannot see {cfg['repository']}; names={names}")
    if any(n not in ALLOWED_REPOS for n in names if n):
        raise InductAppError(f"token sees non-allowlisted repos: {names}")
    return token


def status() -> dict:
    out: dict = {
        "ok": False,
        "configPath": str(CONFIG),
        "configPresent": CONFIG.is_file(),
        "schemaVersion": "gloops.induct-github-app.status.v1",
    }
    if not CONFIG.is_file():
        out["error"] = "config_missing"
        out["next"] = "Install the repository-scoped Induct GitHub App configuration"
        return out
    try:
        cfg = load_config()
        out["repository"] = cfg["repository"]
        out["appId"] = cfg["appId"]
        out["installationId"] = cfg["installationId"]
        out["repositoryId"] = cfg["repositoryId"]
        key = Path(str(cfg["privateKeyPath"]))
        out["privateKeyPresent"] = key.is_file()
        if not key.is_file():
            out["error"] = "private_key_missing"
            return out
        token = mint(cfg, write=False)
        # don't keep token; just prove mint
        del token
        out["ok"] = True
        out["mintRead"] = "ok"
        return out
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
        return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    m = sub.add_parser("mint")
    m.add_argument("--permissions", choices=("read", "write"), default="read")
    m.add_argument("--print-token", action="store_true", help="Print token to stdout (dangerous)")
    c = sub.add_parser("clone")
    c.add_argument("--sha", required=True)
    c.add_argument("--dest", required=True)
    args = ap.parse_args()

    if args.cmd == "status":
        print(json.dumps(status(), indent=2, sort_keys=True))
        return 0 if status().get("ok") else 1

    cfg = load_config()
    if args.cmd == "mint":
        token = mint(cfg, write=args.permissions == "write")
        if args.print_token:
            print(token)
        else:
            print(json.dumps({"ok": True, "permissions": args.permissions, "tokenPrefix": token[:8] + "…"}))
        return 0

    if args.cmd == "clone":
        sha = args.sha.strip().lower()
        if not SHA40.fullmatch(sha):
            raise SystemExit("sha must be 40-char hex")
        dest = Path(args.dest)
        token = mint(cfg, write=False)
        url = f"https://x-access-token:{token}@github.com/{cfg['repository']}.git"
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            subprocess.run(["rm", "-rf", str(dest)], check=True)
        r = subprocess.run(
            ["git", "clone", "--filter=blob:none", url, str(dest)],
            text=True,
            capture_output=True,
        )
        if r.returncode != 0:
            raise SystemExit(f"clone failed: {r.stderr}")
        subprocess.run(["git", "-C", str(dest), "fetch", "origin", sha], check=False)
        subprocess.run(["git", "-C", str(dest), "checkout", "--detach", sha], check=True)
        subprocess.run(
            ["git", "-C", str(dest), "remote", "set-url", "origin", f"https://github.com/{cfg['repository']}.git"],
            check=True,
        )
        head = subprocess.run(
            ["git", "-C", str(dest), "rev-parse", "HEAD"], text=True, capture_output=True, check=True
        ).stdout.strip().lower()
        if head != sha:
            raise SystemExit(f"head mismatch {head} != {sha}")
        print(json.dumps({"ok": True, "dest": str(dest), "head": head}))
        return 0

    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except InductAppError as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        raise SystemExit(1)
