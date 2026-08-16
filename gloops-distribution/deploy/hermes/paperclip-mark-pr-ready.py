#!/usr/bin/env python3
"""Bind an approved exact PR head to one exact-base repository mutation.

This helper marks a matching draft ready, waits for GitHub to classify the PR
as clean, then fast-forwards the governed base with a Git force-with-lease bound
to the independently reviewed base OID. It never arms delayed auto-merge. A
base or head change before the mutation makes the lease/fetch fail closed.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

APP_B_ID = "4071335"
INSTALL_ID = 140741582
KEY = Path("/etc/paperclip-gloops/github-app-review/private-key.pem")
GOVERNED_REPOSITORIES = {
    "gloopsAI/paperclip": {"repositoryId": 1299155335, "baseRef": "gloops/stable"},
    "gloopsAI/personal-delegate": {"repositoryId": 1308141485, "baseRef": "main"},
    "gloopsAI/autonomy-strategy": {"repositoryId": 1279656482, "baseRef": "main"},
    "gloopsAI/gloops-paperclip-plugin": {"repositoryId": 1297008772, "baseRef": "main"},
}
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def governed_repository(repo: str, base_ref: str) -> dict[str, object]:
    binding = GOVERNED_REPOSITORIES.get(repo)
    if binding is None or binding["baseRef"] != base_ref:
        raise RuntimeError("repository/base is outside the governed allowlist")
    return binding


def app_b_token(repository_id: int) -> str:
    key = serialization.load_pem_private_key(KEY.read_bytes(), password=None)
    encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=")
    now = int(time.time())
    header = encode(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = encode(json.dumps({"iat": now - 30, "exp": now + 300, "iss": APP_B_ID}, separators=(",", ":")).encode())
    signature = key.sign(header + b"." + payload, padding.PKCS1v15(), hashes.SHA256())
    jwt = (header + b"." + payload + b"." + encode(signature)).decode()
    response = gh_api(
        "POST",
        f"/app/installations/{INSTALL_ID}/access_tokens",
        jwt,
        {
            "repository_ids": [repository_id],
            "permissions": {"checks": "read", "contents": "write", "pull_requests": "write"},
        },
        bearer=True,
    )
    token = response.get("token") if isinstance(response, dict) else None
    if not isinstance(token, str) or not token:
        raise RuntimeError("GitHub App did not return a repository-scoped token")
    return token


def gh_api(method: str, path: str, token: str, body=None, *, bearer: bool = False):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        "https://api.github.com" + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"{'Bearer' if bearer else 'token'} {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "paperclip-mark-pr-ready",
            **({"Content-Type": "application/json"} if data else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read()
            return {} if not raw else json.loads(raw)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:300]
        raise RuntimeError(f"GitHub {method} {path} -> {error.code}: {detail}") from error


def graphql(token: str, query: str, variables: dict):
    request = urllib.request.Request(
        "https://api.github.com/graphql",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "paperclip-mark-pr-ready",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        result = json.loads(response.read())
    if result.get("errors"):
        raise RuntimeError("GitHub rejected the protected merge action")
    return result.get("data") or {}


def assert_exact_pr(pr: dict, expected_head: str, expected_base: str, expected_base_sha: str) -> None:
    observed_head = str((pr.get("head") or {}).get("sha") or "").lower()
    observed_base = str((pr.get("base") or {}).get("ref") or "")
    observed_base_sha = str((pr.get("base") or {}).get("sha") or "").lower()
    if observed_head != expected_head:
        raise RuntimeError(f"PR head drifted: expected {expected_head}, observed {observed_head or 'missing'}")
    if observed_base != expected_base:
        raise RuntimeError(f"PR base drifted: expected {expected_base}, observed {observed_base or 'missing'}")
    if observed_base_sha != expected_base_sha:
        raise RuntimeError(f"PR base SHA drifted: expected {expected_base_sha}, observed {observed_base_sha or 'missing'}")
    if (pr.get("state") or "").lower() == "closed" and not pr.get("merged"):
        raise RuntimeError("PR is closed without merge")


def assert_exact_independent_review(
    checks: dict, *, repository_id: int, pull_request_number: int,
    expected_head_sha: str, source_run_id: str, review_run_id: str,
) -> None:
    expected_external_id = (
        f"gloops-ir-v2:{repository_id}:{pull_request_number}:{expected_head_sha}:"
        f"{source_run_id}:{review_run_id}"
    )
    runs = checks.get("check_runs") if isinstance(checks, dict) else None
    if not isinstance(runs, list):
        raise RuntimeError("independent-review check evidence is malformed")
    matching = [
        check for check in runs
        if check.get("name") == "gloops / independent-review"
        and int((check.get("app") or {}).get("id") or 0) == int(APP_B_ID)
        and str(check.get("head_sha") or "").lower() == expected_head_sha
        and check.get("external_id") == expected_external_id
        and check.get("status") == "completed"
        and check.get("conclusion") == "success"
    ]
    if len(matching) != 1:
        raise RuntimeError("exact App-B independent-review check is absent or ambiguous")


def run_git(args: list[str], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=90,
    )


def checked_git(args: list[str], cwd: Path, env: dict[str, str]) -> str:
    result = run_git(args, cwd, env)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "git command failed")[-400:]
        raise RuntimeError(f"exact-base Git mutation failed: {detail}")
    return result.stdout.strip()


def exact_leased_fast_forward(
    *, repo: str, base_ref: str, expected_base_sha: str,
    expected_head_sha: str, pull_request_number: int, token: str,
) -> None:
    """Advance base to head iff the remote still has the reviewed tuple.

    Git's force-with-lease is the remote compare-and-swap primitive. The update
    is additionally constrained to a real fast-forward by an ancestry proof;
    the word "force" only enables the exact old-OID lease check.
    """
    with tempfile.TemporaryDirectory(prefix="gloops-exact-merge-") as temp_name:
        temp = Path(temp_name)
        os.chmod(temp, 0o700)
        askpass = temp / "askpass.sh"
        askpass.write_text(
            "#!/bin/sh\n"
            "case \"$1\" in\n"
            "  *Username*) printf '%s\\n' x-access-token ;;\n"
            "  *) printf '%s\\n' \"$GLOOPS_GITHUB_APP_TOKEN\" ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        os.chmod(askpass, 0o700)
        env = {
            **os.environ,
            "GIT_ASKPASS": str(askpass),
            "GIT_TERMINAL_PROMPT": "0",
            "GLOOPS_GITHUB_APP_TOKEN": token,
        }
        checked_git(["init", "--bare", "--quiet"], temp, env)
        remote = f"https://github.com/{repo}.git"
        checked_git([
            "fetch", "--quiet", "--no-tags", remote,
            f"+refs/heads/{base_ref}:refs/gloops/base",
            f"+refs/pull/{pull_request_number}/head:refs/gloops/head",
        ], temp, env)
        observed_base = checked_git(["rev-parse", "refs/gloops/base^{commit}"], temp, env).lower()
        observed_head = checked_git(["rev-parse", "refs/gloops/head^{commit}"], temp, env).lower()
        if observed_base != expected_base_sha:
            raise RuntimeError(
                f"base changed before leased merge: expected {expected_base_sha}, observed {observed_base}"
            )
        if observed_head != expected_head_sha:
            raise RuntimeError(
                f"head changed before leased merge: expected {expected_head_sha}, observed {observed_head}"
            )
        checked_git(["merge-base", "--is-ancestor", expected_base_sha, expected_head_sha], temp, env)
        checked_git([
            "push", "--porcelain",
            f"--force-with-lease=refs/heads/{base_ref}:{expected_base_sha}",
            remote,
            f"{expected_head_sha}:refs/heads/{base_ref}",
        ], temp, env)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--source-run-id", required=True)
    parser.add_argument("--review-run-id", required=True)
    parser.add_argument("--merge-exact", action="store_true")
    args = parser.parse_args()

    expected_head = args.expected_head.lower()
    expected_base_sha = args.base_sha.lower()
    if SHA_RE.fullmatch(expected_head) is None or SHA_RE.fullmatch(expected_base_sha) is None:
        print(json.dumps({"ok": False, "error": "expected head and base must be full lowercase SHAs"}), file=sys.stderr)
        return 1

    token = None
    try:
        binding = governed_repository(args.repo, args.base)
        token = app_b_token(int(binding["repositoryId"]))
        path = f"/repos/{args.repo}/pulls/{args.pr}"
        pr = gh_api("GET", path, token)
        assert_exact_pr(pr, expected_head, args.base, expected_base_sha)
        checks = gh_api(
            "GET",
            f"/repos/{args.repo}/commits/{expected_head}/check-runs"
            "?check_name=gloops%20%2F%20independent-review&per_page=100",
            token,
        )
        assert_exact_independent_review(
            checks,
            repository_id=int(binding["repositoryId"]),
            pull_request_number=args.pr,
            expected_head_sha=expected_head,
            source_run_id=args.source_run_id,
            review_run_id=args.review_run_id,
        )
        node_id = pr.get("node_id")
        if not node_id:
            raise RuntimeError("pull request is missing its immutable node id")

        mutation_attempted = False
        if pr.get("merged"):
            final = pr
        else:
            if pr.get("draft"):
                graphql(token, """
                  mutation($id: ID!) {
                    markPullRequestReadyForReview(input: {pullRequestId: $id}) {
                      pullRequest { isDraft number }
                    }
                  }
                """, {"id": node_id})
            refreshed = gh_api("GET", path, token)
            assert_exact_pr(refreshed, expected_head, args.base, expected_base_sha)
            if args.merge_exact and refreshed.get("mergeable") is True and refreshed.get("mergeable_state") == "clean":
                mutation_attempted = True
                exact_leased_fast_forward(
                    repo=args.repo,
                    base_ref=args.base,
                    expected_base_sha=expected_base_sha,
                    expected_head_sha=expected_head,
                    pull_request_number=args.pr,
                    token=token,
                )
                final = refreshed
                for _ in range(10):
                    final = gh_api("GET", path, token)
                    if final.get("merged"):
                        break
                    time.sleep(0.5)
                if not final.get("merged"):
                    raise RuntimeError("base mutation succeeded but GitHub PR merge reconciliation is unproved")
            else:
                final = refreshed

        if not final.get("merged"):
            assert_exact_pr(final, expected_head, args.base, expected_base_sha)
        ready = final.get("draft") is False
        merged = bool(final.get("merged"))
        if not ready:
            raise RuntimeError("PR did not become ready")
        print(json.dumps({
            "ok": True,
            "pr": args.pr,
            "repo": args.repo,
            "headSha": expected_head,
            "baseRef": args.base,
            "baseSha": expected_base_sha,
            "ready": ready,
            "merged": merged,
            "mergePending": bool(args.merge_exact and not merged),
            "mutationAttempted": mutation_attempted,
        }, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:400]}, sort_keys=True), file=sys.stderr)
        return 1
    finally:
        if token is not None:
            try:
                gh_api("DELETE", "/installation/token", token)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
