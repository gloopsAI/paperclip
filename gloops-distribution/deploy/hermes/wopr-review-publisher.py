#!/usr/bin/env python3
"""WO-PR review-check publisher (App B). Surface trust-substrate IR to Paperclip Approvals + Slack."""
from __future__ import annotations
import argparse, base64, fnmatch, json, os, sys, time, urllib.request
from pathlib import Path
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

APP_B_ID="4071335"; INSTALL_ID=140741582
KEY="/etc/paperclip-gloops/github-app-review/private-key.pem"
REPO="gloopsAI/paperclip"; REPO_ID=1299155335
CHECK_NAME="gloops / independent-review"
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

def app_b_token():
    key=serialization.load_pem_private_key(Path(KEY).read_bytes(), password=None)
    b=lambda x: base64.urlsafe_b64encode(x).rstrip(b"=")
    now=int(time.time())
    h=b(json.dumps({"alg":"RS256","typ":"JWT"}).encode()); p=b(json.dumps({"iat":now-30,"exp":now+300,"iss":APP_B_ID}).encode())
    sig=key.sign(h+b"."+p, padding.PKCS1v15(), hashes.SHA256())
    jwt=(h+b"."+p+b"."+b(sig)).decode()
    tok=gh("POST",f"/app/installations/{INSTALL_ID}/access_tokens","Bearer "+jwt,{"repository_ids":[REPO_ID],"permissions":{"checks":"write"}})
    return "token "+tok["token"]

def list_pr_files(auth, pr):
    files=[]; page=1
    while True:
        batch=gh("GET",f"/repos/{REPO}/pulls/{pr}/files?per_page=100&page={page}",auth)
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

def prior_action_required(pr):
    sticky=HUMAN_CLEARANCE_DIR/f"pr-{pr}.action-required"
    if sticky.exists():
        return not (HUMAN_CLEARANCE_DIR/f"pr-{pr}.human-cleared").exists()
    return False

def mark_action_required(pr):
    HUMAN_CLEARANCE_DIR.mkdir(parents=True, exist_ok=True)
    sticky=HUMAN_CLEARANCE_DIR/f"pr-{pr}.action-required"
    if not sticky.exists():
        sticky.write_text(json.dumps({"pr":pr,"markedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())})+"\n")
        os.chmod(sticky, 0o600)

def write_human_cleared(pr, mode, substrate_hits):
    HUMAN_CLEARANCE_DIR.mkdir(parents=True, exist_ok=True)
    (HUMAN_CLEARANCE_DIR/f"pr-{pr}.human-cleared").write_text(json.dumps({"pr":pr,"clearedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"mode":mode,"substrateHits":substrate_hits[:40]})+"\n")

def existing_open_substrate_approval(pr):
    try: apps=paperclip("GET", f"/api/companies/{COMPANY_ID}/approvals")
    except Exception as e:
        print(f"WARN list approvals: {e}", file=sys.stderr); return None
    if not isinstance(apps,list): return None
    for a in apps:
        if a.get("status")!="pending": continue
        payload=a.get("payload") or {}
        if payload.get("kind")=="trust_substrate_ir" and int(payload.get("pr") or 0)==pr:
            return a
    return None

def mint_board_approval(pr, head, substrate_hits):
    existing=existing_open_substrate_approval(pr)
    if existing:
        print(f"board approval already pending id={existing.get('id')}"); return existing.get("id")
    pr_url=f"https://github.com/{REPO}/pull/{pr}"
    payload={
        "kind":"trust_substrate_ir",
        "title":f"Trust substrate IR clearance — PR #{pr}",
        "summary":f"Independent review for PR #{pr} touches trust-substrate paths. Approve only if you accept the governance impact. Head `{head[:12]}`. Paths: {', '.join(substrate_hits[:12])}.",
        "recommendedAction":f"Approve to clear GitHub check gloops/independent-review for PR #{pr} and allow auto-merge. Reject keeps merge blocked.",
        "pr":pr,"prUrl":pr_url,"headSha":head,"substratePaths":substrate_hits[:40],
        "risks":["Touches trust-substrate denylist paths.","Clearance unblocks required branch-protection check and may auto-merge to gloops/stable.","Does not authorize GO DEPLOY or Induct write."],
        "encodeClass":"T-SUBSTRATE-IR-SURFACE",
    }
    try:
        created=paperclip("POST", f"/api/companies/{COMPANY_ID}/approvals", {"type":"request_board_approval","payload":payload})
        aid=created.get("id")
        if not aid:
            raise RuntimeError("Paperclip returned a board-approval response without an id")
        print(f"board approval minted id={aid}")
        HUMAN_CLEARANCE_DIR.mkdir(parents=True, exist_ok=True)
        (HUMAN_CLEARANCE_DIR/f"pr-{pr}.approval-id").write_text(str(aid)+"\n")
        return aid
    except Exception as e:
        raise RuntimeError(f"board approval mint failed: {e}") from e

def notify_human(pr, head, substrate_hits, approval_id):
    pr_url=f"https://github.com/{REPO}/pull/{pr}"
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

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--head")
    ap.add_argument("--verdict", default="accepted", choices=["accepted","changes_required"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force-after-action-required", action="store_true")
    a=ap.parse_args()
    auth=app_b_token()
    pr=gh("GET", f"/repos/{REPO}/pulls/{a.pr}", auth)
    head=pr["head"]["sha"]
    if a.head and a.head!=head: raise SystemExit(f"--head mismatch")
    paths, subs=classify_paths(list_pr_files(auth, a.pr))
    approval_id=None
    approval_error=None
    if a.verdict!="accepted":
        concl,title,summ="failure","Independent review: changes required","Argus requested changes."
    elif a.force_after_action_required:
        if not a.dry_run: write_human_cleared(a.pr, "force_after_action_required", subs)
        concl="success"; title="Independent review: accepted (human trust-substrate clearance)"
        summ=("Operator/board cleared trust-substrate IR. Paths: "+", ".join(subs[:20])) if subs else "Operator/board cleared prior action_required."
    elif subs:
        concl="action_required"; title="Independent review: touches trust substrate - human review required"
        summ=("Changed files include trust-substrate paths (auto-merge withheld): "+", ".join(subs[:20])+
              f". Open Paperclip Approvals or phrase: `clear trust substrate IR for #{a.pr}`.")
        if not a.dry_run:
            mark_action_required(a.pr)
            try:
                approval_id=mint_board_approval(a.pr, head, subs)
            except RuntimeError as e:
                approval_error=str(e)
                summ=("Changed files include trust-substrate paths; auto-merge remains withheld. "
                      f"CRITICAL: Paperclip board approval was not created ({approval_error}). "
                      "Treat this publisher invocation as failed; investigate the board path before clearing IR.")
            notify_human(a.pr, head, subs, approval_id)
    elif prior_action_required(a.pr):
        concl="action_required"; title="Independent review: prior substrate touch requires human clearance"
        summ=f"PR #{a.pr} previously action_required. Clear via Paperclip Approvals or --force-after-action-required."
        if not a.dry_run:
            try:
                approval_id=mint_board_approval(a.pr, head, subs or ["(prior sticky)"])
            except RuntimeError as e:
                approval_error=str(e)
                summ=("PR has a prior trust-substrate hold and remains blocked. "
                      f"CRITICAL: Paperclip board approval was not created ({approval_error}). "
                      "Treat this publisher invocation as failed; investigate the board path before clearing IR.")
            notify_human(a.pr, head, subs or ["(prior sticky)"], approval_id)
    else:
        concl,title,summ="success","Independent review: accepted","Argus accepted the exact head; no trust-substrate paths touched."
    body={"name":CHECK_NAME,"head_sha":head,"status":"completed","conclusion":concl,"output":{"title":title,"summary":summ}}
    print(f"head={head} files={len(paths)} substrate={len(subs)} conclusion={concl} approval={approval_id}")
    if a.dry_run: print("DRY RUN"); return
    res=gh("POST", f"/repos/{REPO}/check-runs", auth, body)
    print("published check-run id", res.get("id"), "conclusion", res.get("conclusion"))
    if approval_error:
        raise SystemExit(approval_error)

if __name__=="__main__":
    main()
