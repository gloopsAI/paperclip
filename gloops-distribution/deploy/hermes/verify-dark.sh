#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:38e0bd4725377cb930290f033b19418e0ccb1c3efc773243f66d25f5fb6e3d9f'
failed=0

check_inactive() {
  local unit="$1"
  if systemctl is-active --quiet "${unit}"; then
    echo "FAIL active unit: ${unit}" >&2
    failed=1
  else
    echo "PASS inactive unit: ${unit}"
  fi
}

for unit in paperclip.service gloops-runner.service hermes-agent.service paperclip-gloops.service; do
  check_inactive "${unit}"
done

if [[ "$(systemctl is-enabled paperclip-gloops.service 2>/dev/null || true)" == "masked" ]]; then
  echo "PASS paperclip-gloops.service is masked"
else
  echo "FAIL paperclip-gloops.service is not masked" >&2
  failed=1
fi

if [[ ! -e /etc/paperclip-gloops/ACTIVATION_APPROVED ]]; then
  echo "PASS activation marker is absent"
else
  echo "FAIL activation marker exists" >&2
  failed=1
fi

if docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "PASS exact image digest is installed"
else
  echo "FAIL exact image digest is missing" >&2
  failed=1
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-gloops'; then
  echo "FAIL paperclip-gloops container exists" >&2
  failed=1
else
  echo "PASS no paperclip-gloops container exists"
fi

if ss -lntH | awk '{print $4}' | grep -Eq '(^|:)3100$|(^|:)8443$'; then
  echo "FAIL Paperclip HTTP or HTTPS port is listening" >&2
  failed=1
else
  echo "PASS no Paperclip HTTP or HTTPS listener exists"
fi

if systemctl list-timers --all --no-legend | grep -Ei 'paperclip|gloops-(runner|exec|watchdog)|hermes-agent'; then
  echo "FAIL a Paperclip-related timer is scheduled" >&2
  failed=1
else
  echo "PASS no Paperclip-related timer is scheduled"
fi

if systemctl list-unit-files --type=service --no-legend | grep -E 'paperclip|gloops-runner|hermes-agent' | grep -Ev '(disabled|masked|static)'; then
  echo "FAIL a Paperclip-related service is enabled" >&2
  failed=1
else
  echo "PASS Paperclip-related services are disabled, masked, or static"
fi

if grep -RIEq '(^|_)(XAI|GROK)_(API_KEY|BASE_URL)=' /etc/paperclip-gloops /usr/local/lib/systemd/system/paperclip-gloops.service; then
  echo "FAIL Grok/xAI API configuration is present" >&2
  failed=1
else
  echo "PASS no Grok/xAI API configuration is present"
fi

exit "${failed}"
