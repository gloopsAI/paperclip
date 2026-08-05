# Hermes lifecycle receipt sink (outbound webhooks)

Notify-only path: Hermes `hooks.outbound` POSTs signed lifecycle events to
`hermes-lifecycle-sink:8765` on the `paperclip-execution` Docker network.

## Host apply

```bash
# 1) Secret (once)
SECRET=$(openssl rand -hex 32)
# append to hermes-execution.env without printing
echo "HERMES_OUTBOUND_WEBHOOK_SECRET=${SECRET}" | sudo tee -a /etc/paperclip-gloops/hermes-execution.env >/dev/null
sudo chmod 600 /etc/paperclip-gloops/hermes-execution.env

# 2) Install script + unit
sudo install -m 0755 -o root -g root hermes-lifecycle-receipt-sink.py \
  /usr/local/lib/paperclip-gloops/hermes-lifecycle-receipt-sink.py
sudo install -m 0644 -o root -g root paperclip-hermes-lifecycle-sink.service \
  /etc/systemd/system/paperclip-hermes-lifecycle-sink.service
sudo mkdir -p /var/lib/paperclip-gloops/hermes-lifecycle-receipts
sudo chmod 700 /var/lib/paperclip-gloops/hermes-lifecycle-receipts

# 3) Refresh hermes profile config (max_turns + hooks) from distribution
sudo install -m 0400 -o 10000 -g 10000 hermes-execution-config.yaml \
  /opt/paperclip/hermes-execution-profile/config.yaml
# or re-run prepare-hermes-execution-profile.sh

# 4) Start sink then restart hermes
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-hermes-lifecycle-sink.service
sudo systemctl restart paperclip-hermes-execution.service

# 5) Canaries
sudo HERMES_OUTBOUND_WEBHOOK_SECRET=$SECRET ./verify-hermes-outbound-webhook-canary.sh
sudo ./verify-hermes-self-heal-canary.sh --container paperclip-hermes-execution
curl -fsS http://127.0.0.1:3100/api/health
```

## Authority

Receipts are observations only. They do not graduate capabilities or authorize mutations.
