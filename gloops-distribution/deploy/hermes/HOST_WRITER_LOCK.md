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

Ordinary issue assignment and execution do not require a host-writer window.
Paperclip's issue/workspace/run claim is the admission boundary. Use this tool
only for actual host configuration or service lifecycle changes, including
starting or ending an explicitly governed controlled-swarm campaign.

## Read-only status

```bash
sudo /usr/local/lib/paperclip-gloops/paperclip-hostctl.py status
```

An out-of-band `runtime.env` edit changes the recorded hash and makes the next
mutation fail closed. Reconcile only after the operator has identified and
recorded that edit. Do not edit the journal or holder sidecar to bypass a
refusal.
