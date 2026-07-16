#!/usr/bin/env python3
import importlib.util
import socket
import ssl
import threading
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("hermes-handshake-egress-proxy.py")
SPEC = importlib.util.spec_from_file_location("handshake_proxy", MODULE_PATH)
proxy = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(proxy)


def client_hello(hostname: str) -> bytes:
    context = ssl.create_default_context()
    incoming = ssl.MemoryBIO()
    outgoing = ssl.MemoryBIO()
    tls = context.wrap_bio(incoming, outgoing, server_side=False, server_hostname=hostname)
    with unittest.TestCase().assertRaises(ssl.SSLWantReadError):
        tls.do_handshake()
    return outgoing.read()


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.server = proxy.ProxyServer(("127.0.0.1", 0), "127.0.0.1")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def connect(self):
        return socket.create_connection(self.server.server_address, timeout=2)

    def test_rejects_non_ollama_connect_without_consuming_budget(self):
        with self.connect() as client:
            client.sendall(b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n")
            self.assertTrue(client.recv(1024).startswith(b"HTTP/1.1 403"))
        self.assertFalse(self.server.claimed)

    def test_rejects_wrong_sni_and_then_enforces_one_tunnel_budget(self):
        with self.connect() as client:
            client.sendall(b"CONNECT ollama.com:443 HTTP/1.1\r\nHost: ollama.com:443\r\n\r\n")
            self.assertTrue(client.recv(1024).startswith(b"HTTP/1.1 200"))
            client.sendall(client_hello("github.com"))
            self.assertEqual(client.recv(1024), b"")
        self.assertTrue(self.server.claimed)
        with self.connect() as client:
            client.sendall(b"CONNECT ollama.com:443 HTTP/1.1\r\nHost: ollama.com:443\r\n\r\n")
            self.assertTrue(client.recv(1024).startswith(b"HTTP/1.1 429"))

    def test_extracts_exact_ollama_sni_from_real_client_hello(self):
        left, right = socket.socketpair()
        try:
            right.sendall(client_hello("ollama.com"))
            raw, sni = proxy._read_client_hello(left)
            self.assertTrue(raw.startswith(b"\x16\x03"))
            self.assertEqual(sni, "ollama.com")
        finally:
            left.close()
            right.close()


if __name__ == "__main__":
    unittest.main()
