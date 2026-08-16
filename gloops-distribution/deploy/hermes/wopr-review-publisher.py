#!/usr/bin/env python3
"""WO-PR review-check publisher (App B). Surface trust-substrate IR to Paperclip Approvals + Slack."""
from __future__ import annotations
import argparse, base64, fnmatch, json, os, sys, time, urllib.request
import re
from pathlib import Path
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

APP_B_ID="4071335"; INSTALL_ID=140741582
KEY="/etc/paperclip-gloops/github-app-review/private-key.pem"
GOVERNED_REPOSITORIES={
    "gloopsAI/paperclip":{"repositoryId":1299155335,"baseRef":"gloops/stable"},
    "gloopsAI/personal-delegate":{"repositoryId":1308141485,"baseRef":"main"},
    "gloopsAI/autonomy-strategy":{"repositoryId":1279656482,"baseRef":"main"},
    "gloopsAI/gloops-paperclip-plugin":{"repositoryId":1297008772,"baseRef":"main"},
}
CHECK_NAME="gloops / independent-review"
SHA_RE=re.compile(r"^[0-9a-f]{40}$")
HUMAN_CLEARANCE_DIR=Path("/var/lib/paperclip-gloops/wopr-review-clearance")
def normalize_paperclip_api_base(value):
    """Normalize either the Paperclip origin or its legacy /api base URL."""
    base = value.rstrip("/")
    return base[:-4] if base.endswith("/api") else base

PAPERCLIP_API=normalize_paperclip_api_base(os.environ.get("PAPERCLIP_API","http://127.0.0.1:3100"))
COMPANY_ID=os.environ.get("PAPERCLIP_COMPANY_ID","89ed0964-d918-4fcc-b830-5be49d2d4089")
BOARD_TOKEN_FILE=Path(os.environ.get("PAPERCLIP_BOARD_TOKEN_FILE","/etc/paperclip-gloops/operator-board-token"))
SLACK_CHANNEL_ID=os.environ.get("PAPERCLIP_SUBSTRATE_SLACK_CHANNEL","C0BGVS837EG")
SUBSTRATE=["gloops-distribution/**",".github/**","Dockerfile","docker/**",".env.example",".npmrc","pnpm-workspace.yaml","pnpm-lock.yaml","package.json","**/package.json","scripts/verify-*","scripts/gloops-runtime-policy.mjs","scripts/run-vitest-stable.mjs","scripts/check-*.mjs","scripts/release*","scripts/rollback-latest.sh","scripts/create-github-release.sh","scripts/deploy.sh","scripts/**/deploy*","server/src/middleware/**","server/src/secrets/**","server/src/routes/authz.ts","server/src/routes/auth.ts","server/src/routes/access.ts","server/src/agent-auth-jwt.ts","server/src/config.ts","server/src/redaction.ts","server/src/log-redaction.ts","server/src/attachment-types.ts","server/src/services/execution-allowlist.ts","server/src/services/budgets.ts","packages/db/src/migrations/**","packages/db/src/schema.ts","packages/db/src/schema/**","packages/adapter-utils/src/execution-envelope.ts","packages/adapter-utils/src/sandbox-callback-bridge.ts","packages/adapter-utils/src/acpx-engine/constants.ts","packages/plugins/sandbox-providers/kubernetes/src/image-allowlist.ts","packages/adapters/*/src/server/permissions.ts","packages/shared/src/constants.ts","vitest.config.ts","**/vitest.config.ts","vitest.config.*","**/vitest.config.*","tsconfig.json","**/tsconfig.json","tsconfig.*.json",".husky/**"]

def is_substrate(path): return any(fnmatch.fnmatch(path,g) for g in SUBSTRATE)

def gh(method, path, auth, body=None):
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request("https://api.github.com"+path,data=data,method=method,headers={"Authorization":auth,"Accept":"application/vnd.github+json","User-Agent":"wopr-review-publisher","X-GitHub-Api-Version":"2022-11-28"})
    with urllib.request.urlopen(req,timeout=30) as resp: return json.load(resp)

def paperclip(method, path, body=None):
    token=BOARD_TOKEN_FILE.read_text().strip()
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request(PAPERCLIP_API+(path if path.startswith("/") else "/"+path),data=data,method=method,headers={"Authorization":f"Bearer {token}","Accept":"application/json",**({"Content-Type":"application/json"} if body is not None else {})})
    with urllib.request.urlopen(req,timeout=45) as resp:
        raw=resp.read(); return json.loads(raw) if raw else {}

def paperclip_issue(issue_id):
    value=paperclip("GET",f"/api/issues/{issue_id}")
    return value.get("issue") if isinstance(value,dict) and isinstance(value.get("issue"),dict) else value

def paperclip_comments(issue_id):
    value=paperclip("GET",f"/api/issues/{issue_id}/comments")
    if isinstance(value,dict): value=value.get("comments") or value.get("items") or []
    return value if isinstance(value,list) else []

def verify_review_receipt(args, repository_id):
    issue=paperclip_issue(args.review_issue_id)
    run=paperclip("GET",f"/api/heartbeat-runs/{args.review_run_id}")
    settings=issue.get("executionWorkspaceSettings") if isinstance(issue,dict) else None
    provenance=settings.get("reviewProvenance") if isinstance(settings,dict) else None
    if not isinstance(provenance,dict) or provenance.get("kind")!="implementation_exact_head_v2":
        raise SystemExit("review issue lacks server-owned v2 provenance")
    expected={
        "repositoryId":str(repository_id),"repositoryFullName":args.repo,
        "baseRef":args.base,"exactBaseSha":args.base_sha,"exactHeadSha":args.head,
        "pullRequestNumber":args.pr,"pullRequestUrl":f"https://github.com/{args.repo}/pull/{args.pr}",
    }
    if any(provenance.get(key)!=value for key,value in expected.items()):
        raise SystemExit("review provenance does not match repository/PR/base/head")
    reviewer=issue.get("assigneeAgentId")
    allowed={provenance.get("reviewerAgentId"),*(provenance.get("alternateReviewerAgentIds") or [])}
    if not reviewer or reviewer not in allowed or reviewer==provenance.get("implementerAgentId"):
        raise SystemExit("reviewer identity is not independent and designated")
    context=run.get("contextSnapshot") if isinstance(run,dict) else None
    attempted=(run.get("providerInvocationAttempted") is True or (isinstance(run.get("resultJson"),dict) and run["resultJson"].get("providerInvocationAttempted") is True))
    if not (isinstance(context,dict) and run.get("companyId")==COMPANY_ID and run.get("agentId")==reviewer and run.get("status")=="succeeded" and context.get("issueId")==args.review_issue_id and attempted):
        raise SystemExit("review run is not a successful server-bound reviewer invocation")
    approval=re.compile(r"\bAPPROVE\b(?:\s+exact)?(?:\s+head)?\s+"+re.escape(args.head)+r"\b",re.I)
    matched=any(
        comment.get("createdByRunId")==args.review_run_id
        and comment.get("authorAgentId")==reviewer
        and comment.get("authorUserId") in (None,"")
        and approval.search(str(comment.get("body") or comment.get("content") or ""))
        for comment in paperclip_comments(args.review_issue_id)
        if isinstance(comment,dict)
    )
    if not matched:
        raise SystemExit("review issue has no exact-head approval from the bound reviewer run")
    return provenance

def governed_repository(repo, base_ref):
    binding=GOVERNED_REPOSITORIES.get(repo)
    if not binding or binding["baseRef"]!=base_ref:
        raise SystemExit("repository/base is outside the governed allowlist")
    return binding

def app_b_token(repository_id):
    key=serialization.load_pem_private_key(Path(KEY).read_bytes(), password=None)
    b=lambda x: base64.urlsafe_b64encode(x).rstrip(b"=")
    now=int(time.time())
    h=b(json.dumps({"alg":"RS256","typ":"JWT"}).encode()); p=b(json.dumps({"iat":now-30,"exp":now+300,"iss":APP_B_ID}).encode())
    sig=key.sign(h+b"."+p, padding.PKCS1v15(), hashes.SHA256())
    jwt=(h+b"."+p+b"."+b(sig)).decode()
    tok=gh("POST",f"/app/installations/{INSTALL_ID}/access_tokens","Bearer "+jwt,{"repository_ids":[repository_id],"permissions":{"checks":"write","contents":"read","pull_requests":"read"}})
    return tok["token"]

def list_pr_files(auth, repo, pr):
    files=[]; page=1
    while True:
        batch=gh("GET",f"/repos/{repo}/pulls/{pr}/files?per_page=100&page={page}",auth)
        if not isinstance(batch,list) or not batch: break
        files.extend(batch)
        if len(batch)<100: break
        page+=1
        if page>50: raise RuntimeError("pagination cap")
    return files

def classify_paths(file_objs):
    considered=[]; hits=[]
    for f in file_objs:
        for path in (f.get("filename") or "", f.get("previous_filename") or ""):
            if not path: continue
            if path not in considered: considered.append(path)
            if is_substrate(path) and path not in hits: hits.append(path)
    return considered, hits

def clearance_key(repository_id, pr, base_sha, head): return f"repo-{repository_id}-pr-{pr}-base-{base_sha}-head-{head}"

def prior_action_required(repository_id, pr, base_sha, head):
    key=clearance_key(repository_id, pr, base_sha, head)
    sticky=HUMAN_CLEARANCE_DIR/f"{key}.action-required"
    if sticky.exists():
        return not (HUMAN_CLEARANCE_DIR/f"{key}.human-cleared").exists()
    return False

def mark_action_required(repository_id, repo, base_ref, base_sha, pr, head):
    HUMAN_CLEARANCE_DIR.mkdir(parents=True, exist_ok=True)
    sticky=HUMAN_CLEARANCE_DIR/f"{clearance_key(repository_id, pr, base_sha, head)}.action-required"
    if not sticky.exists():
        sticky.write_text(json.dumps({"repositoryId":repository_id,"repository":repo,"baseRef":base_ref,"baseSha":base_sha,"pr":pr,"headSha":head,"markedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())})+"\n")
        os.chmod(sticky, 0o600)

def write_human_cleared(repository_id, repo, base_ref, base_sha, pr, head, mode, substrate_hits):
    HUMAN_CLEARANCE_DIR.mkdir(parents=True, exist_ok=True)
    (HUMAN_CLEARANCE_DIR/f"{clearance_key(repository_id, pr, base_sha, head)}.human-cleared").write_text(json.dumps({"repositoryId":repository_id,"repository":repo,"baseRef":base_ref,"baseSha":base_sha,"pr":pr,"headSha":head,"clearedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"mode":mode,"substrateHits":substrate_hits[:40]})+"\n")

def existing_open_substrate_approval(repository_id, repo, base_ref, base_sha, pr, head):
    try: apps=paperclip("GET", f"/api/companies/{COMPANY_ID}/approvals")
    except Exception as e:
        print(f"WARN list approvals: {e}", file=sys.stderr); return None
    if not isinstance(apps,list): return None
    for a in apps:
        if a.get("status")!="pending": continue
        payload=a.get("payload") or {}
        if payload.get("kind")=="trust_substrate_ir" and payload.get("repositoryId")==str(repository_id) and payload.get("repository")==repo and payload.get("baseRef")==base_ref and payload.get("baseSha")==base_sha and int(payload.get("pr") or 0)==pr and payload.get("headSha")==head:
            return a
    return None

def mint_board_approval(repository_id, repo, base_ref, base_sha, pr, head, substrate_hits, review_issue_id, review_run_id):
    existing=existing_open_substrate_approval(repository_id, repo, base_ref, base_sha, pr, head)
    if existing:
        print(f"board approval already pending id={existing.get('id')}"); return existing.get("id")
    pr_url=f"https://github.com/{repo}/pull/{pr}"
    payload={
        "kind":"trust_substrate_ir",
        "title":f"Trust substrate IR clearance — PR #{pr}",
        "summary":f"Independent review for PR #{pr} touches trust-substrate paths. Approve only if you accept the governance impact. Head `{head[:12]}`. Paths: {', '.join(substrate_hits[:12])}.",
        "recommendedAction":f"Approve to clear GitHub check gloops/independent-review for PR #{pr} and allow GitHub's strict protected merge. Reject keeps merge blocked.",
        "repositoryId":str(repository_id),"repository":repo,"baseRef":base_ref,"baseSha":base_sha,"pr":pr,"prUrl":pr_url,"headSha":head,"reviewIssueId":review_issue_id,"reviewRunId":review_run_id,"substratePaths":substrate_hits[:40],
        "risks":["Touches trust-substrate denylist paths.","Clearance unblocks the independent-review check and strict protected merge.","Does not authorize GO DEPLOY or Induct write."],
        "encodeClass":"T-SUBSTRATE-IR-SURFACE",
    }
    try:
        created=paperclip("POST", f"/api/companies/{COMPANY_ID}/approvals", {"type":"request_board_approval","payload":payload})
        aid=created.get("id")
        if not aid:
            raise RuntimeError("Paperclip returned a board-approval response without an id")
        print(f"board approval minted id={aid}")
        HUMAN_CLEARANCE_DIR.mkdir(parents=True, exist_ok=True)
        (HUMAN_CLEARANCE_DIR/f"{clearance_key(repository_id, pr, base_sha, head)}.approval-id").write_text(str(aid)+"\n")
        return aid
    except Exception as e:
        raise RuntimeError(f"board approval mint failed: {e}") from e

def notify_human(repo, pr, head, substrate_hits, approval_id):
    pr_url=f"https://github.com/{repo}/pull/{pr}"
    text=(f"*Trust substrate IR — human decision required*\nPR #{pr}: {pr_url}\nHead: `{head[:12]}`\n"
          f"Paths: {', '.join(substrate_hits[:8])}\nPaperclip Approvals: https://paperclip.gloops.ai/GLO/approvals/pending\n"
          f"Approval id: `{approval_id or 'mint-failed'}`\nPhrase: `clear trust substrate IR for #{pr}`")
    token=os.environ.get("SLACK_BOT_TOKEN","").strip()
    if not token:
        for p in [Path("/etc/paperclip-gloops/communications.env"), Path("/var/lib/paperclip-gloops/communications.env")]:
            try:
                if p.is_file():
                    for line in p.read_text().splitlines():
                        if line.startswith("SLACK_BOT_TOKEN="):
                            token=line.split("=",1)[1].strip().strip("\"'"); break
            except Exception: pass
            if token: break
    if not token:
        print("WARN slack notify skipped (no token)", file=sys.stderr); return
    try:
        req=urllib.request.Request("https://slack.com/api/chat.postMessage", data=json.dumps({"channel":SLACK_CHANNEL_ID,"text":text}).encode(), method="POST",
            headers={"Authorization":f"Bearer {token}","Content-Type":"application/json"})
        with urllib.request.urlopen(req, timeout=20) as resp: data=json.loads(resp.read())
        print("slack notify", "ok" if data.get("ok") else data.get("error"))
    except Exception as e:
        print(f"WARN slack: {e}", file=sys.stderr)

def publish_with_auth(a, repository_id, provenance, auth):
    pr=gh("GET", f"/repos/{a.repo}/pulls/{a.pr}", auth)
    head=pr["head"]["sha"]
    if a.head!=head: raise SystemExit(f"--head mismatch")
    if (pr.get("base") or {}).get("ref")!=a.base: raise SystemExit("--base mismatch")
    if (pr.get("base") or {}).get("sha")!=a.base_sha: raise SystemExit("--base-sha mismatch")
    if int((pr.get("base") or {}).get("repo",{}).get("id") or 0)!=repository_id: raise SystemExit("repository id mismatch")
    paths, subs=classify_paths(list_pr_files(auth, a.repo, a.pr))
    approval_id=None
    approval_error=None
    if a.verdict!="accepted":
        concl,title,summ="failure","Independent review: changes required","Argus requested changes."
    elif a.force_after_action_required:
        if not a.dry_run: write_human_cleared(repository_id,a.repo,a.base,a.base_sha,a.pr,head,"force_after_action_required", subs)
        concl="success"; title="Independent review: accepted (human trust-substrate clearance)"
        summ=("Operator/board cleared trust-substrate IR. Paths: "+", ".join(subs[:20])) if subs else "Operator/board cleared prior action_required."
    elif subs:
        concl="action_required"; title="Independent review: touches trust substrate - human review required"
        summ=("Changed files include trust-substrate paths (merge withheld): "+", ".join(subs[:20])+
              f". Open Paperclip Approvals or phrase: `clear trust substrate IR for #{a.pr}`.")
        if not a.dry_run:
            mark_action_required(repository_id,a.repo,a.base,a.base_sha,a.pr,head)
            try:
                approval_id=mint_board_approval(repository_id,a.repo,a.base,a.base_sha,a.pr,head,subs,a.review_issue_id,a.review_run_id)
            except RuntimeError as e:
                approval_error=str(e)
                summ=("Changed files include trust-substrate paths; merge remains withheld. "
                      f"CRITICAL: Paperclip board approval was not created ({approval_error}). "
                      "Treat this publisher invocation as failed; investigate the board path before clearing IR.")
            notify_human(a.repo,a.pr,head,subs,approval_id)
    elif prior_action_required(repository_id,a.pr,a.base_sha,head):
        concl="action_required"; title="Independent review: prior substrate touch requires human clearance"
        summ=f"PR #{a.pr} previously action_required. Clear via Paperclip Approvals or --force-after-action-required."
        if not a.dry_run:
            try:
                approval_id=mint_board_approval(repository_id,a.repo,a.base,a.base_sha,a.pr,head,subs or ["(prior sticky)"],a.review_issue_id,a.review_run_id)
            except RuntimeError as e:
                approval_error=str(e)
                summ=("PR has a prior trust-substrate hold and remains blocked. "
                      f"CRITICAL: Paperclip board approval was not created ({approval_error}). "
                      "Treat this publisher invocation as failed; investigate the board path before clearing IR.")
            notify_human(a.repo,a.pr,head,subs or ["(prior sticky)"],approval_id)
    else:
        concl,title,summ="success","Independent review: accepted","Argus accepted the exact head; no trust-substrate paths touched."
    external_id=f"gloops-ir-v2:{repository_id}:{a.pr}:{head}:{provenance['sourceRunId']}:{a.review_run_id}"
    body={"name":CHECK_NAME,"head_sha":head,"status":"completed","conclusion":concl,"external_id":external_id,"output":{"title":title,"summary":summ}}
    print(f"head={head} files={len(paths)} substrate={len(subs)} conclusion={concl} approval={approval_id}")
    if a.dry_run: print("DRY RUN"); return
    res=gh("POST", f"/repos/{a.repo}/check-runs", auth, body)
    print("published check-run id", res.get("id"), "conclusion", res.get("conclusion"))
    if approval_error:
        raise SystemExit(approval_error)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--base-sha", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--review-issue-id", required=True)
    ap.add_argument("--review-run-id", required=True)
    ap.add_argument("--verdict", default="accepted", choices=["accepted","changes_required"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force-after-action-required", action="store_true")
    a=ap.parse_args()
    if not SHA_RE.fullmatch(a.base_sha) or not SHA_RE.fullmatch(a.head):
        raise SystemExit("base/head must be full lowercase SHAs")
    binding=governed_repository(a.repo,a.base)
    repository_id=binding["repositoryId"]
    provenance=verify_review_receipt(a,repository_id)
    token=app_b_token(repository_id)
    auth="token "+token
    try:
        publish_with_auth(a,repository_id,provenance,auth)
    finally:
        try: gh("DELETE","/installation/token",auth)
        except Exception: pass

if __name__=="__main__":
    main()
