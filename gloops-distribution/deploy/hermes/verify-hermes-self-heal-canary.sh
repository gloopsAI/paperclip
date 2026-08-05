#!/usr/bin/env bash
# Offline canary: prove Hermes execution image carries v0.20 self-heal / evidence surface.
# No LLM or provider calls.
set -euo pipefail

IMAGE=""
CONTAINER="paperclip-hermes-execution"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--image sha256:...] [--container name]"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

run() {
  if [[ -n "${IMAGE}" ]]; then
    docker run --rm --entrypoint sh "${IMAGE}" -c "$1"
  else
    docker exec "${CONTAINER}" sh -c "$1"
  fi
}

echo "self-heal canary: target=${IMAGE:-container:${CONTAINER}}"

ver="$(run 'hermes --version 2>/dev/null | head -1' || true)"
echo "version: ${ver}"
echo "${ver}" | grep -Eq 'v?0\.(2[0-9]|[3-9][0-9])|v?[1-9]\.' || {
  echo "FAIL: expected Hermes >= 0.20, got: ${ver}" >&2
  exit 1
}

run 'test -f /opt/hermes/gateway/run_evidence.py'
run 'test -f /opt/hermes/hermes_state_common.py'

# Recovery / self-heal surface markers (flexible; upstream may rename helpers)
run 'python - <<"PY"
from pathlib import Path
root = Path("/opt/hermes")
needles = [
    b"already-applied",
    b"already applied",
    b"truncat",
    b"spill",
    b"near-miss",
    b"RunEvidenceAccumulator",
]
hits = {n: 0 for n in needles}
for path in root.rglob("*.py"):
    try:
        data = path.read_bytes()
    except OSError:
        continue
    for n in needles:
        if n.lower() in data.lower():
            hits[n] += 1
# require evidence module + at least two recovery-ish markers somewhere
assert hits[b"RunEvidenceAccumulator"] >= 1, hits
recovery = sum(1 for k,v in hits.items() if k != b"RunEvidenceAccumulator" and v > 0)
assert recovery >= 2, f"insufficient self-heal markers: {hits}"
print("markers_ok", {k.decode(): v for k,v in hits.items() if v})
PY'

run 'python -c "import hermes_state_common; from gateway.run_evidence import RunEvidenceAccumulator; print(\"imports_ok\")"'

echo "PASS: hermes self-heal canary"
