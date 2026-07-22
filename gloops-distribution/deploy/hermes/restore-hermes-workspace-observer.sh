#!/usr/bin/env bash
set -euo pipefail

readonly CONTAINER='paperclip-hermes-execution'
readonly WORKSPACE='/opt/paperclip/hermes-execution-state/workspace'
readonly HERMES_UID='10000'
readonly PAPERCLIP_GID='985'
readonly PAPERCLIP_UID='995'
readonly MAX_HEALTH_POLLS='75'
readonly APPROVED_IMAGE_FILE='/etc/paperclip-gloops/approved-image'

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }

health='missing'
for _ in $(seq 1 "${MAX_HEALTH_POLLS}"); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${CONTAINER}" 2>/dev/null || true)"
  [[ "${health}" == 'healthy' ]] && break
  sleep 1
done
[[ "${health}" == 'healthy' ]] || {
  echo "Hermes execution sidecar did not become healthy within ${MAX_HEALTH_POLLS} seconds (last status: ${health})" >&2
  exit 1
}

# The Hermes image initializes /opt/data as uid:gid 10000:10000, including the
# bind-mounted workspace root. Restore the shared transaction boundary after
# initialization: Hermes owns the root and Paperclip's group can create the
# adjacent merge lock required for deterministic sync-back.
chown "${HERMES_UID}:${PAPERCLIP_GID}" "${WORKSPACE}"
chmod 2770 "${WORKSPACE}"

[[ "$(stat -c '%a:%u:%g' "${WORKSPACE}")" == '2770:10000:985' ]] || {
  echo 'Hermes/Paperclip shared workspace transaction permissions were not restored' >&2
  exit 1
}
observer_image="$(<"${APPROVED_IMAGE_FILE}")"
docker image inspect "${observer_image}" >/dev/null
docker run --rm --pull never --user "${PAPERCLIP_UID}:${PAPERCLIP_GID}" \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,src=${WORKSPACE},dst=/workspace" \
  --entrypoint /bin/sh "${observer_image}" -c \
  'set -eu; probe=/workspace/.paperclip-restore-preflight; trap '\''rm -rf "$probe"'\'' EXIT; mkdir "$probe"; printf ok >"$probe/owner"; test "$(cat "$probe/owner")" = ok; rm -rf "$probe"; test -r /workspace/gloops-paperclip-plugin/.git/HEAD' || {
  echo 'Paperclip identity cannot use the shared workspace transaction boundary' >&2
  exit 1
}

echo 'restored and verified Hermes/Paperclip shared workspace transaction boundary'
