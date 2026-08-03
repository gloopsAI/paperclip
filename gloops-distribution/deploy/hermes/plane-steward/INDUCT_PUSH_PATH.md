# Induct agent write path (P1)

## Why two tools
- Hermes runs as uid 10000 and **cannot** read root App private keys.
- `induct-git-push.py` mints Induct App tokens → must run as **root on host**.
- Agents use `induct-request-push.py` to write a pending request under the lease.
- Host `induct-push-poller.py` executes requests with the App.

## Agent steps (inside Hermes)
```bash
# after commits on lease
python3 /opt/data/bin/induct-request-push.py \
  --cwd /opt/data/workspace/induct-main \
  --branch agent/wren/glo-XXXX-short \
  --title "fix: ..." \
  --body "..." \
  --pr
```

## Host execute (Lead/ops or timer)
```bash
sudo python3 /usr/local/lib/paperclip-gloops/bin/induct-push-poller.py --once
# or direct:
sudo python3 /usr/local/lib/paperclip-gloops/tools/induct-git-push.py push-pr \
  --cwd /opt/paperclip/hermes-execution-state/workspace/induct-main \
  --branch agent/wren/glo-XXXX-short --title "..." --body "..."
```

## Direct host push (canary without agent)
Same `induct-git-push.py` as root.

## P3 verify
```bash
sudo /usr/local/lib/paperclip-gloops/bin/verify-induct-lease.sh
```
