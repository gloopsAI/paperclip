# Trust-substrate IR → Paperclip Approvals + notify

## Problem
`gloops / independent-review` `action_required` only wrote a host sticky file + GitHub check.
Zach never saw Paperclip Approvals or Buzz — fallout chat was the only path.

## Fix
1. `wopr-review-publisher.py` on substrate hit:
   - publish IR `action_required`
   - mint `request_board_approval` with `payload.kind=trust_substrate_ir`
   - best-effort Slack notify (communications credentials)
2. `substrate-ir-approval-poller.py` timer (1m):
   - on board **Approve** → `--force-after-action-required` SUCCESS
   - on Reject → leave blocked
3. `--force-after-action-required` works even when substrate paths remain (intentional substrate PRs).

## Install
Install the publisher at `/usr/local/lib/paperclip-gloops/wopr-review-publisher.py`.
Install the pollers and standing helper at
`/usr/local/lib/paperclip-gloops/tools/{substrate-ir-approval-poller.py,closed-loop-argus-publish-poller.py,closed-loop-publish-review.sh}`.
Enable timers `paperclip-substrate-ir-approval-poller.timer` and
`paperclip-closed-loop-publish-poller.timer`.

## Argus-accept front half (A4)

`closed-loop-argus-publish-poller.py` runs from the signed check-suite systemd
path trigger, with the two-minute timer retained only as a bounded backstop. It reads only
review-issue **comments** for an Argus exact-head approval (or the compatible
`PAPERCLIP_SWARM_V1` accepted marker), matches that SHA to an open PR on
`gloops/stable`, then invokes the independent-review publisher and arms the
normal ready/auto-merge path. Its state is keyed by `PR:head`, so a new commit
requires a new exact-head approval.

It does not merge or deploy by itself, and it cannot bypass the publisher's
trust-substrate denylist. A substrate PR still follows the Board Approve →
scheduled substrate poller back half before independent review can be SUCCESS.

## Live acceptance canary
Paperclip **#225** exercised the full approval arm on 2026-07-30: its exact head was
held with `action_required`, a `trust_substrate_ir` board approval was minted and
approved, and the scheduled poller published independent-review SUCCESS before
auto-merge. The canary did not authorize a product deploy.
