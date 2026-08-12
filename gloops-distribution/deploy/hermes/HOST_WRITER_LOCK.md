# Paperclip host writer lock

All production mutations of `/etc/paperclip-gloops/runtime.env` and all
`systemctl` actions on Paperclip units must pass through the root-installed
`paperclip-hostctl.py` entrypoint. Read-only inspection does not take the lock.

The controller holds `/var/lock/paperclip-gloops-writer.lock` for the complete
mutate → restart → verify → terminal-receipt transaction. It writes the current
holder to `/run/paperclip-gloops/host-writer-holder.json` and appends pre,
post, break, and reconcile records to
`/var/log/paperclip-gloops/host-writer-journal.jsonl`. A second writer fails
immediately and names the holder. There is no TTL-based or silent lock steal.

## Initialize or reconcile

The first governed use should establish a baseline receipt. The same command
is required after a terminated writer, and it refuses to break a live PID:

```bash
sudo /usr/local/lib/paperclip-gloops/paperclip-hostctl.py reconcile \
  --agent-slug codex-lead \
  --session-id SESSION_ID \
  --mission-id MISSION_ID \
  --reason 'verified host baseline before governed window'
```

## Open one controlled window

```bash
sudo /usr/local/lib/paperclip-gloops/paperclip-hostctl.py apply \
  --agent-slug codex-lead \
  --session-id SESSION_ID \
  --mission-id MISSION_ID \
  --intent 'open one allowlisted general-scope reliability issue' \
  --set PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false \
  --set PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS=ISSUE_UUID \
  --set PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=ISSUE_UUID \
  --systemctl reset-failed:paperclip-gloops.service \
  --systemctl restart:paperclip-gloops.service
```

The issue must first pass the authenticated packet-readiness check with
`ready=true`, explicit Scope and Acceptance, and the intended resource-budget
ceilings. A failed packet check is provider-free and never justifies widening
admission. This window does not commission the controlled swarm or enable the
global scheduler; it only admits the matching issue UUID to a bound wake.

## Restore the freeze

```bash
sudo /usr/local/lib/paperclip-gloops/paperclip-hostctl.py apply \
  --agent-slug codex-lead \
  --session-id SESSION_ID \
  --mission-id MISSION_ID \
  --intent 'restore freeze after terminal run' \
  --set PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false \
  --set PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS= \
  --set PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS= \
  --systemctl restart:paperclip-gloops.service
```

Release is valid only when the terminal post record proves commission false,
both READMIT values empty, scheduler and recovery state, the approved pin,
both unit states, the resulting runtime hash, and exit status zero.

## Read-only status

```bash
sudo /usr/local/lib/paperclip-gloops/paperclip-hostctl.py status
```

An out-of-band `runtime.env` edit changes the recorded hash and makes the next
mutation fail closed. Reconcile only after the operator has identified and
recorded that edit. Do not edit the journal or holder sidecar to bypass a
refusal.
