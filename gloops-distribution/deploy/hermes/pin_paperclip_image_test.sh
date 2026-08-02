#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; readonly SCRIPT_DIR
readonly OLD_IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly NEW_IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
readonly FAILED_IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
readonly IMAGE_ID='sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
readonly REVISION='dddddddddddddddddddddddddddddddddddddddd'

test_root="$(mktemp -d)"
trap 'rm -rf "${test_root}"' EXIT
root="${test_root}/root"
bin="${test_root}/bin"
mkdir -p \
  "${root}/etc/paperclip-gloops" \
  "${root}/var/lib/paperclip-gloops/controlled-swarm" \
  "${root}/var/lib/paperclip-gloops/credential-runtime" \
  "${root}/opt/paperclip/hermes-execution-profile/cron-disabled" \
  "${root}/opt/paperclip/hermes-execution-state/workspace" \
  "${bin}"
touch \
  "${root}/opt/paperclip/hermes-execution-profile/auth.json" \
  "${root}/opt/paperclip/hermes-execution-profile/config.yaml" \
  "${root}/opt/paperclip/hermes-execution-profile/policy.json"
printf '%s\n' "${OLD_IMAGE}" >"${root}/etc/paperclip-gloops/approved-image"
cat >"${root}/etc/paperclip-gloops/runtime.env" <<EOF
HOST=0.0.0.0
PAPERCLIP_IMAGE=${OLD_IMAGE}
PORT=3100
EOF
cat >"${root}/var/lib/paperclip-gloops/controlled-swarm/supervisor-operational-closure.json" <<EOF
{
  "approvedImage": "${OLD_IMAGE}",
  "authorization": "operator",
  "authorizedAt": "2026-08-01T00:00:00Z",
  "campaignId": "campaign",
  "providerRoute": "ollama",
  "schemaVersion": "gloops.supervisor-operational-closure-commissioning.v1",
  "workItem": "test"
}
EOF
cat >"${root}/etc/paperclip-gloops/github-app.json" <<'EOF'
{"appId":4307157,"installationId":146796843,"repository":"gloopsAI/gloops-paperclip-plugin","repositoryId":1297008772}
EOF
cat >"${root}/var/lib/paperclip-gloops/credential-runtime/credential-receipt.json" <<'EOF'
{"appId":4307157,"installationId":146796843,"repository":"gloopsAI/gloops-paperclip-plugin","repositoryId":1297008772}
EOF

cat >"${bin}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"${PAPERCLIP_TEST_COMMAND_LOG}"
if [[ "$1 $2 ${3:-}" == 'image inspect --format' && "${4:-}" == '{{json .RepoDigests}}' ]]; then
  printf '["%s"]\n' "${PAPERCLIP_TEST_NEW_IMAGE}"
elif [[ "$1 $2 ${3:-}" == 'inspect --format {{.Config.Image}}' ]]; then
  if [[ -n "${PAPERCLIP_TEST_RUNNING_IMAGE_FILE:-}" ]]; then
    tr -d '\r\n' <"${PAPERCLIP_TEST_RUNNING_IMAGE_FILE}"
    printf '\n'
  else
    printf '%s\n' "${PAPERCLIP_TEST_NEW_IMAGE}"
  fi
elif [[ "$1 $2 ${3:-}" == 'inspect --format {{.Image}}' ]]; then
  printf '%s\n' "${PAPERCLIP_TEST_IMAGE_ID}"
elif [[ "$1 $2 ${3:-}" == 'image inspect --format' && "${4:-}" == '{{index .Config.Labels "org.opencontainers.image.revision"}}' ]]; then
  printf '%s\n' "${PAPERCLIP_TEST_REVISION}"
fi
EOF
cat >"${bin}/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >>"${PAPERCLIP_TEST_COMMAND_LOG}"
if [[ "$1" == 'restart' && "${PAPERCLIP_TEST_FAIL_NEXT_RESTART:-0}" == '1' ]]; then
  count=0
  [[ ! -f "${PAPERCLIP_TEST_RESTART_STATE}" ]] || count="$(<"${PAPERCLIP_TEST_RESTART_STATE}")"
  printf '%s\n' "$((count + 1))" >"${PAPERCLIP_TEST_RESTART_STATE}"
  ((count > 0)) || exit 1
fi
exit 0
EOF
cat >"${bin}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '{"status":"ok"}\n'
EOF
cat >"${bin}/journalctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'journal evidence\n' >&2
EOF
chmod +x "${bin}"/*

export PAPERCLIP_PIN_TEST_MODE=1
export PAPERCLIP_PIN_TEST_ROOT="${root}"
export PAPERCLIP_PIN_TEST_BIN_DIR="${bin}"
export PAPERCLIP_PIN_TIMEOUT_SECONDS=2
export PAPERCLIP_TEST_COMMAND_LOG="${test_root}/commands.log"
export PAPERCLIP_TEST_NEW_IMAGE="${NEW_IMAGE}"
export PAPERCLIP_TEST_IMAGE_ID="${IMAGE_ID}"
export PAPERCLIP_TEST_REVISION="${REVISION}"
export PAPERCLIP_TEST_RUNNING_IMAGE_FILE="${root}/etc/paperclip-gloops/approved-image"

"${SCRIPT_DIR}/pin-paperclip-image.sh" --dry-run --skip-pull "${NEW_IMAGE}" >"${test_root}/dry-run.out"
grep -Fq 'DRY RUN OK' "${test_root}/dry-run.out"
grep -Fqx "${OLD_IMAGE}" "${root}/etc/paperclip-gloops/approved-image"

"${SCRIPT_DIR}/pin-paperclip-image.sh" --skip-pull "${NEW_IMAGE}" >"${test_root}/pin.out"
grep -Fq 'PIN OK' "${test_root}/pin.out"
grep -Fqx "${NEW_IMAGE}" "${root}/etc/paperclip-gloops/approved-image"
grep -Fqx "PAPERCLIP_IMAGE=${NEW_IMAGE}" "${root}/etc/paperclip-gloops/runtime.env"
python3 - "${root}" "${NEW_IMAGE}" "${REVISION}" <<'PY'
import json
import sys
from pathlib import Path

root, expected_image, expected_revision = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
supervisor = json.loads((root / "var/lib/paperclip-gloops/controlled-swarm/supervisor-operational-closure.json").read_text())
assert supervisor["approvedImage"] == expected_image
assert set(supervisor) == {
    "approvedImage", "authorization", "authorizedAt", "campaignId",
    "providerRoute", "schemaVersion", "workItem",
}
receipts = list((root / "var/lib/paperclip-gloops/receipts").glob("pin-paperclip-image-*.json"))
assert len(receipts) == 1
receipt = json.loads(receipts[0].read_text())
assert receipt["approvedImage"] == expected_image
assert receipt["sourceRevision"] == expected_revision
assert receipt["health"] == {"status": "ok"}
backups = list((root / "var/lib/paperclip-gloops/receipts/pin-backups").glob("*"))
assert len(backups) == 1
assert (backups[0] / "approved-image").read_text().strip().endswith("a" * 64)
PY
grep -Fq 'systemctl restart paperclip-gloops.service' "${PAPERCLIP_TEST_COMMAND_LOG}"

# A failed restart must restore all three authoritative pin files and prove that
# the prior service becomes healthy again. The pin command itself still fails so
# automation cannot confuse a successful rollback with a successful deployment.
export PAPERCLIP_TEST_NEW_IMAGE="${FAILED_IMAGE}"
export PAPERCLIP_TEST_FAIL_NEXT_RESTART=1
export PAPERCLIP_TEST_RESTART_STATE="${test_root}/restart-count"
if "${SCRIPT_DIR}/pin-paperclip-image.sh" --skip-pull "${FAILED_IMAGE}" \
  >"${test_root}/failed-pin.out" 2>"${test_root}/failed-pin.err"; then
  echo 'expected the simulated failed restart to fail the pin command' >&2
  exit 1
fi
grep -Fq 'ROLLBACK OK' "${test_root}/failed-pin.err"
grep -Fqx "${NEW_IMAGE}" "${root}/etc/paperclip-gloops/approved-image"
grep -Fqx "PAPERCLIP_IMAGE=${NEW_IMAGE}" "${root}/etc/paperclip-gloops/runtime.env"
python3 - "${root}" "${NEW_IMAGE}" <<'PY'
import json
import sys
from pathlib import Path

root, expected_image = Path(sys.argv[1]), sys.argv[2]
supervisor = json.loads((root / "var/lib/paperclip-gloops/controlled-swarm/supervisor-operational-closure.json").read_text())
assert supervisor["approvedImage"] == expected_image
assert len(list((root / "var/lib/paperclip-gloops/receipts").glob("pin-paperclip-image-*.json"))) == 1
PY
unset PAPERCLIP_TEST_FAIL_NEXT_RESTART PAPERCLIP_TEST_RESTART_STATE
export PAPERCLIP_TEST_NEW_IMAGE="${NEW_IMAGE}"

export PAPERCLIP_PREPULL_TEST_MODE=1
export PAPERCLIP_PREPULL_TEST_ROOT="${root}"
export PAPERCLIP_PREPULL_TEST_BIN_DIR="${bin}"
"${SCRIPT_DIR}/pull-latest-stable.sh" >"${test_root}/prepull.out"
grep -Fq 'PREPULL UPDATED' "${test_root}/prepull.out"
grep -Fqx "${NEW_IMAGE}" "${root}/var/lib/paperclip-gloops/prepull/latest-stable-image"
"${SCRIPT_DIR}/pull-latest-stable.sh" >"${test_root}/prepull-second.out"
grep -Fq 'PREPULL UNCHANGED' "${test_root}/prepull-second.out"

echo 'PASS pin-paperclip-image and stable pre-pull mocked-host tests'
