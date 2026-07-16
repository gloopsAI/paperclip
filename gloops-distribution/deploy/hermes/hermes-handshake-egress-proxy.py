#!/usr/bin/env python3
"""Single-purpose CONNECT+TLS-SNI proxy for the bounded Ollama handshake."""

from __future__ import annotations

import argparse
import ipaddress
import json
import selectors
import socket
import socketserver
import threading
import time

TARGET = "ollama.com"
TARGET_PORT = 443
MAX_HEADER = 8192
MAX_HELLO = 65536


def _recv_until(sock: socket.socket, marker: bytes, limit: int) -> bytes:
    data = bytearray()
    while marker not in data:
        chunk = sock.recv(min(4096, limit - len(data)))
        if not chunk or len(data) + len(chunk) > limit:
            raise ValueError("bounded input is incomplete or too large")
        data.extend(chunk)
    return bytes(data)


def _read_client_hello(sock: socket.socket) -> tuple[bytes, str]:
    raw = bytearray()
    handshake = bytearray()
    expected = None
    while expected is None or len(handshake) < expected:
        header = _recv_exact(sock, 5)
        if header[0] != 0x16 or header[1] != 0x03:
            raise ValueError("first tunneled payload is not a TLS handshake")
        length = int.from_bytes(header[3:5], "big")
        if length <= 0 or len(raw) + 5 + length > MAX_HELLO:
            raise ValueError("TLS ClientHello exceeds the handshake bound")
        payload = _recv_exact(sock, length)
        raw.extend(header + payload)
        handshake.extend(payload)
        if len(handshake) >= 4:
            if handshake[0] != 0x01:
                raise ValueError("first TLS handshake message is not ClientHello")
            expected = 4 + int.from_bytes(handshake[1:4], "big")
    return bytes(raw), _extract_sni(bytes(handshake[4:expected]))


def _recv_exact(sock: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ValueError("unexpected EOF")
        data.extend(chunk)
    return bytes(data)


def _extract_sni(hello: bytes) -> str:
    pos = 2 + 32
    if len(hello) < pos + 1:
        raise ValueError("truncated ClientHello")
    session_len = hello[pos]
    pos += 1 + session_len
    if len(hello) < pos + 2:
        raise ValueError("truncated cipher suites")
    cipher_len = int.from_bytes(hello[pos:pos + 2], "big")
    pos += 2 + cipher_len
    if len(hello) < pos + 1:
        raise ValueError("truncated compression methods")
    compression_len = hello[pos]
    pos += 1 + compression_len
    if len(hello) < pos + 2:
        raise ValueError("missing ClientHello extensions")
    extensions_len = int.from_bytes(hello[pos:pos + 2], "big")
    pos += 2
    end = pos + extensions_len
    if end != len(hello):
        raise ValueError("malformed ClientHello extensions")
    while pos + 4 <= end:
        kind = int.from_bytes(hello[pos:pos + 2], "big")
        size = int.from_bytes(hello[pos + 2:pos + 4], "big")
        value = hello[pos + 4:pos + 4 + size]
        if len(value) != size:
            raise ValueError("truncated ClientHello extension")
        if kind == 0:
            if len(value) < 5 or int.from_bytes(value[:2], "big") != len(value) - 2 or value[2] != 0:
                raise ValueError("malformed SNI extension")
            name_len = int.from_bytes(value[3:5], "big")
            if 5 + name_len != len(value):
                raise ValueError("ambiguous SNI extension")
            return value[5:].decode("ascii").lower()
        pos += 4 + size
    raise ValueError("TLS ClientHello has no SNI")


def _connect_target() -> socket.socket:
    infos = socket.getaddrinfo(TARGET, TARGET_PORT, socket.AF_INET, socket.SOCK_STREAM)
    if not infos:
        raise OSError("Ollama target did not resolve")
    address = ipaddress.ip_address(infos[0][4][0])
    if not address.is_global:
        raise OSError("Ollama target resolved to a non-global address")
    upstream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    upstream.settimeout(10)
    upstream.connect((str(address), TARGET_PORT))
    upstream.settimeout(None)
    return upstream


def _relay(left: socket.socket, right: socket.socket) -> None:
    selector = selectors.DefaultSelector()
    selector.register(left, selectors.EVENT_READ, right)
    selector.register(right, selectors.EVENT_READ, left)
    while True:
        events = selector.select(timeout=30)
        if not events:
            continue
        for key, _ in events:
            data = key.fileobj.recv(65536)
            if not data:
                return
            key.data.sendall(data)


class ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, address: tuple[str, int], allowed_client: str, max_connections: int = 4):
        super().__init__(address, ProxyHandler)
        self.allowed_client = allowed_client
        self.claimed = False
        self.claim_lock = threading.Lock()
        self.connection_slots = threading.BoundedSemaphore(max_connections)
        self.active_connections = 0
        self.active_lock = threading.Lock()

    def process_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        if not self.connection_slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
            finally:
                self.shutdown_request(request)
            print(json.dumps({
                "client": client_address[0],
                "result": "saturated",
            }, sort_keys=True), flush=True)
            return
        with self.active_lock:
            self.active_connections += 1
        try:
            super().process_request(request, client_address)
        except Exception:
            with self.active_lock:
                self.active_connections -= 1
            self.connection_slots.release()
            self.shutdown_request(request)
            raise

    def process_request_thread(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self.active_lock:
                self.active_connections -= 1
            self.connection_slots.release()


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        started = time.monotonic()
        event = {"client": self.client_address[0], "target": None, "result": "denied"}
        try:
            self.request.settimeout(10)
            if self.client_address[0] != self.server.allowed_client:
                raise ValueError("client source is not the fixed Hermes address")
            header = _recv_until(self.request, b"\r\n\r\n", MAX_HEADER)
            line = header.split(b"\r\n", 1)[0].decode("ascii")
            event["target"] = line
            if line != f"CONNECT {TARGET}:{TARGET_PORT} HTTP/1.1":
                self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
                raise ValueError("CONNECT authority is not Ollama")
            with self.server.claim_lock:
                if self.server.claimed:
                    self.request.sendall(b"HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n")
                    raise ValueError("one-tunnel budget is exhausted")
                self.server.claimed = True
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            client_hello, sni = _read_client_hello(self.request)
            if sni != TARGET:
                raise ValueError("TLS SNI is not Ollama")
            upstream = _connect_target()
            with upstream:
                upstream.sendall(client_hello)
                self.request.settimeout(None)
                event["result"] = "allowed"
                _relay(self.request, upstream)
        except Exception as error:
            event["reason"] = type(error).__name__
        finally:
            event["elapsedMs"] = round((time.monotonic() - started) * 1000)
            print(json.dumps(event, sort_keys=True), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--allowed-client", required=True)
    parser.add_argument("--max-connections", required=True, type=int, choices=range(1, 9))
    args = parser.parse_args()
    with ProxyServer((args.listen, args.port), args.allowed_client, args.max_connections) as server:
        server.serve_forever(poll_interval=0.2)


if __name__ == "__main__":
    main()
