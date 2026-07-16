#!/usr/bin/env bash
set -euo pipefail

readonly CONTAINER='paperclip-hermes-handshake'

docker ps --format '{{.Names}}' | grep -Fxq "${CONTAINER}" || {
  echo 'Hermes handshake container is not running' >&2
  exit 1
}

docker exec -i "${CONTAINER}" /opt/hermes/.venv/bin/python - <<'PY'
import socket

socket.setdefaulttimeout(2)

try:
    socket.getaddrinfo("github.com", 443)
except OSError:
    pass
else:
    raise SystemExit("external DNS unexpectedly resolved github.com")

for host, port, label in [
    ("1.1.1.1", 443, "direct Internet"),
    ("172.30.241.1", 22, "non-proxy host access"),
]:
    try:
        socket.create_connection((host, port), timeout=2).close()
    except OSError:
        pass
    else:
        raise SystemExit(f"{label} unexpectedly connected")

with socket.create_connection(("172.30.241.1", 18080), timeout=2) as probe:
    probe.sendall(b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n")
    response = probe.recv(1024)
    if not response.startswith(b"HTTP/1.1 403"):
        raise SystemExit(f"non-Ollama proxy authority was not denied: {response!r}")
PY

echo 'PASS executable negative egress proof: DNS, direct Internet, non-proxy host, and non-Ollama CONNECT are denied'
