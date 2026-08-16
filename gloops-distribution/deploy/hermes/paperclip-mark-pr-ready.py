#!/usr/bin/env python3
"""Bind an approved exact PR head to GitHub's protected merge transaction.

This helper never arms delayed auto-merge and never pushes the base ref. It
requires strict required-status-check enforcement, marks a matching draft
ready, and asks GitHub to squash-merge only a clean exact head/base tuple. If
the base advances, strict enforcement makes the reviewed head stale and the
server-side merge fails atomically.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote
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


def assert_strict_required_checks(repo: str, base_ref: str, token: str) -> None:
    encoded = quote(base_ref, safe="")
    try:
        legacy = gh_api(
            "GET", f"/repos/{repo}/branches/{encoded}/protection/required_status_checks", token
        )
        if legacy.get("strict") is True:
            return
    except RuntimeError:
        pass
    try:
        rules = gh_api("GET", f"/repos/{repo}/rules/branches/{encoded}", token)
    except RuntimeError as error:
        raise RuntimeError("strict required-status-check enforcement is unproved") from error
    if not isinstance(rules, list) or not any(
        isinstance(rule, dict)
        and rule.get("type") == "required_status_checks"
        and isinstance(rule.get("parameters"), dict)
        and rule["parameters"].get("strict_required_status_checks_policy") is True
        for rule in rules
    ):
        raise RuntimeError("strict required-status-check enforcement is absent")


def assert_exact_squash_commit(commit: dict, expected_base_sha: str) -> None:
    parents = commit.get("parents") if isinstance(commit, dict) else None
    if not isinstance(parents, list) or len(parents) != 1:
        raise RuntimeError("merged PR is not an exact squash commit")
    parent = str((parents[0] or {}).get("sha") or "").lower()
    if parent != expected_base_sha:
        raise RuntimeError(
            f"merged PR parent drifted: expected {expected_base_sha}, observed {parent or 'missing'}"
        )


def reconcile_merged_pr(
    *, repo: str, pr: dict, expected_head: str, expected_base: str,
    expected_base_sha: str, token: str,
) -> str:
    if not pr.get("merged"):
        raise RuntimeError("pull request is not merged")
    if str((pr.get("head") or {}).get("sha") or "").lower() != expected_head:
        raise RuntimeError("merged PR head does not match the reviewed head")
    if str((pr.get("base") or {}).get("ref") or "") != expected_base:
        raise RuntimeError("merged PR base ref does not match the reviewed base")
    merge_sha = str(pr.get("merge_commit_sha") or "").lower()
    if SHA_RE.fullmatch(merge_sha) is None:
        raise RuntimeError("merged PR is missing its merge commit SHA")
    commit = gh_api("GET", f"/repos/{repo}/git/commits/{merge_sha}", token)
    assert_exact_squash_commit(commit, expected_base_sha)
    return merge_sha


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
        if not pr.get("merged"):
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
        merge_sha = None
        if pr.get("merged"):
            final = pr
            merge_sha = reconcile_merged_pr(
                repo=args.repo, pr=pr, expected_head=expected_head,
                expected_base=args.base, expected_base_sha=expected_base_sha, token=token,
            )
        else:
            assert_strict_required_checks(args.repo, args.base, token)
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
                try:
                    result = gh_api("PUT", f"{path}/merge", token, {
                        "merge_method": "squash",
                        "sha": expected_head,
                    })
                    if result.get("merged") is not True:
                        raise RuntimeError("GitHub protected merge was not accepted")
                except Exception as merge_error:
                    final = gh_api("GET", path, token)
                    if not final.get("merged"):
                        raise RuntimeError("protected merge failed before a terminal GitHub state") from merge_error
                final = gh_api("GET", path, token)
                merge_sha = reconcile_merged_pr(
                    repo=args.repo, pr=final, expected_head=expected_head,
                    expected_base=args.base, expected_base_sha=expected_base_sha, token=token,
                )
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
            "mergeCommitSha": merge_sha,
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
