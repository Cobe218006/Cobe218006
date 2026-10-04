"""
Tests for backend/api.py — the FastAPI substitute for a Next.js /api shell.

Run from enterprise/:  pip install -r requirements.txt
                       pytest tests/test_api.py

What's genuinely exercised here vs. what needs real external credentials:

- quantum_execute / ipfs_pin "fails closed" paths: no external dependency,
  always run.
- ipfs_pin "succeeds" path: run against a real local HTTP server this test
  spins up itself (not a mock library) — verifies the actual HTTP request
  this code builds and how it parses a response, without needing a real
  PINATA_JWT. Hitting the real api.pinata.cloud is NOT covered here.
- chain_verify: run against a real local EVM chain. Needs a chain reachable
  at CHAIN_TEST_RPC_URL (default http://127.0.0.1:8549, e.g. a running
  `ganache` or `anvil`) with GenesisRegistryV2 bytecode available at
  CHAIN_TEST_ABI_PATH/CHAIN_TEST_BIN_PATH (defaults point at the artifacts
  this project's own manual testing produced under /tmp — see
  enterprise/README.md). If neither is available, these tests skip cleanly
  rather than failing, the same way the quantum tests don't require a real
  IBM account.
- auth_google "fails closed" paths run against Google's REAL, live JWKS
  endpoint (network required) — they prove a forged/unsigned token is
  actually rejected by real signature verification, not a stub. There is no
  test here for a genuinely valid Google-issued token: producing one needs
  a real interactive OAuth sign-in this environment can't automate.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

from backend.api import app

client = TestClient(app)


def test_quantum_execute_fails_closed_without_token(monkeypatch):
    monkeypatch.delenv("IBM_QUANTUM_TOKEN", raising=False)
    resp = client.post("/api/quantum/execute", json={})
    assert resp.status_code == 424
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "QUANTUM_EXECUTION_FAILED"
    assert "IBM_QUANTUM_TOKEN" in body["error"]["message"]


def test_malformed_request_body_matches_the_ok_error_contract():
    """FastAPI's default 422 body is {"detail": [...]}, which breaks the
    {ok, error{code,message}} shape every other response follows. Pinned
    here after finding the default shape slip through uncaught."""
    resp = client.post("/api/ipfs/pin", json={})
    assert resp.status_code == 422
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert "detail" not in body


def test_ipfs_pin_fails_closed_without_jwt(monkeypatch):
    monkeypatch.delenv("PINATA_JWT", raising=False)
    resp = client.post("/api/ipfs/pin", json={"manifest": {"a": 1}})
    assert resp.status_code == 503
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "PINNING_NOT_CONFIGURED"


class _FakePinataHandler(BaseHTTPRequestHandler):
    received = {}

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        _FakePinataHandler.received["path"] = self.path
        _FakePinataHandler.received["auth"] = self.headers.get("Authorization")
        _FakePinataHandler.received["body"] = json.loads(raw)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"IpfsHash": "bafy-from-fake-server", "PinSize": 123}).encode())

    def log_message(self, *args):  # silence the default stderr logging
        pass


@pytest.fixture
def fake_pinata_server():
    server = HTTPServer(("127.0.0.1", 0), _FakePinataHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_ipfs_pin_succeeds_against_a_real_local_server(monkeypatch, fake_pinata_server):
    """Not a mock: a real HTTP server receives a real request from pin_json()."""
    monkeypatch.setenv("PINATA_JWT", "test-jwt-value")
    monkeypatch.setenv("PINATA_BASE_URL", fake_pinata_server)
    resp = client.post("/api/ipfs/pin", json={"manifest": {"hello": "world"}, "filename": "test.json"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["data"]["cid"] == "bafy-from-fake-server"
    assert body["data"]["gateway_url"].endswith("bafy-from-fake-server")

    # Confirm the request this code actually sent was well-formed.
    assert _FakePinataHandler.received["auth"] == "Bearer test-jwt-value"
    assert _FakePinataHandler.received["body"]["pinataContent"] == {"hello": "world"}
    assert _FakePinataHandler.received["body"]["pinataMetadata"]["name"] == "test.json"


def test_ipfs_pin_fails_closed_on_bad_server_response(monkeypatch):
    class _BrokenHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.send_response(500)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), _BrokenHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("PINATA_JWT", "test-jwt-value")
        monkeypatch.setenv("PINATA_BASE_URL", f"http://127.0.0.1:{server.server_port}")
        resp = client.post("/api/ipfs/pin", json={"manifest": {"a": 1}})
        assert resp.status_code == 502
        assert resp.json()["error"]["code"] == "PINNING_FAILED"
    finally:
        server.shutdown()


def test_chain_verify_rejects_malformed_digest():
    resp = client.post("/api/chain/verify", json={
        "rpc_url": "http://127.0.0.1:8549", "contract_address": "0x" + "11" * 20, "digest_hex": "deadbeef",
    })
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_DIGEST"


def test_chain_verify_fails_closed_on_unreachable_rpc():
    resp = client.post("/api/chain/verify", json={
        "rpc_url": "http://127.0.0.1:1", "contract_address": "0x" + "11" * 20, "digest_hex": "00" * 32,
    })
    assert resp.status_code == 502
    assert resp.json()["error"]["code"] == "CHAIN_CHECK_FAILED"


# --- Tests needing a real local chain -----------------------------------------

CHAIN_TEST_RPC_URL = os.getenv("CHAIN_TEST_RPC_URL", "http://127.0.0.1:8549")
CHAIN_TEST_ABI_PATH = os.getenv("CHAIN_TEST_ABI_PATH", "/tmp/claude-0/-home-user-Cobe218006/3df40df0-2f95-5a61-91bb-ead91a1349f9/scratchpad/pw/GenesisRegistryV2.abi.json")
CHAIN_TEST_BIN_PATH = os.getenv("CHAIN_TEST_BIN_PATH", "/tmp/claude-0/-home-user-Cobe218006/3df40df0-2f95-5a61-91bb-ead91a1349f9/scratchpad/pw/GenesisRegistryV2.bin")


@pytest.fixture
def deployed_registry():
    try:
        from web3 import Web3
    except ImportError:
        pytest.skip("web3.py not installed")

    w3 = Web3(Web3.HTTPProvider(CHAIN_TEST_RPC_URL, request_kwargs={"timeout": 3}))
    try:
        if not w3.is_connected():
            pytest.skip(f"No local chain reachable at {CHAIN_TEST_RPC_URL}")
    except Exception:
        pytest.skip(f"No local chain reachable at {CHAIN_TEST_RPC_URL}")

    if not (os.path.exists(CHAIN_TEST_ABI_PATH) and os.path.exists(CHAIN_TEST_BIN_PATH)):
        pytest.skip("GenesisRegistryV2 ABI/bytecode artifacts not found; compile the contract first")

    abi = json.load(open(CHAIN_TEST_ABI_PATH))
    bytecode = "0x" + open(CHAIN_TEST_BIN_PATH).read().strip()
    acct = w3.eth.accounts[0]
    Contract = w3.eth.contract(abi=abi, bytecode=bytecode)
    tx_hash = Contract.constructor().transact({"from": acct})
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    contract = w3.eth.contract(address=receipt.contractAddress, abi=abi)
    return w3, contract, acct


def test_chain_verify_reports_active_record(deployed_registry):
    w3, contract, acct = deployed_registry
    digest = w3.keccak(text="api-test-record")
    tx = contract.functions.anchorProof(digest, "bafy-api-test-cid", "BUSINESS_EVIDENCE", 0).transact({"from": acct})
    w3.eth.wait_for_transaction_receipt(tx)

    resp = client.post("/api/chain/verify", json={
        "rpc_url": CHAIN_TEST_RPC_URL, "contract_address": contract.address, "digest_hex": digest.hex(),
    })
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["status"] == "Active"
    assert data["is_valid"] is True
    assert data["ipfs_cid"] == "bafy-api-test-cid"
    assert data["proof_type"] == "BUSINESS_EVIDENCE"
    assert data["issuer"].lower() == acct.lower()


def test_chain_verify_reports_nonexistent_record(deployed_registry):
    w3, contract, _acct = deployed_registry
    digest = w3.keccak(text="never-anchored-record")
    resp = client.post("/api/chain/verify", json={
        "rpc_url": CHAIN_TEST_RPC_URL, "contract_address": contract.address, "digest_hex": digest.hex(),
    })
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["status"] == "NonExistent"
    assert data["is_valid"] is False


# --- Google Sign In server-side verification --------------------------------
# master.html decodes the ID token CLIENT-SIDE without checking its signature
# (explicitly labeled unverified there). These tests exercise the real check.

def _fake_jwt(payload: dict) -> str:
    import base64
    import json as _json

    def b64url(obj: dict) -> str:
        return base64.urlsafe_b64encode(_json.dumps(obj).encode()).rstrip(b"=").decode()

    return b64url({"alg": "RS256", "typ": "JWT"}) + "." + b64url(payload) + ".garbage-signature"


def test_google_auth_fails_closed_without_client_id(monkeypatch):
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_ID", raising=False)
    resp = client.post("/api/auth/google", json={"id_token": "whatever"})
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "GOOGLE_AUTH_NOT_CONFIGURED"


def test_google_auth_rejects_malformed_token(monkeypatch):
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "fake-client-id.apps.googleusercontent.com")
    resp = client.post("/api/auth/google", json={"id_token": "not.a.jwt"})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "GOOGLE_TOKEN_INVALID"


def test_google_auth_rejects_forged_token_against_real_google_jwks(monkeypatch):
    """Not a stub: this hits Google's live JWKS endpoint and confirms a
    well-shaped but unsigned token is still cryptographically rejected."""
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "fake-client-id.apps.googleusercontent.com")
    forged = _fake_jwt({
        "sub": "1234567890", "email": "nobody@example.com",
        "iss": "https://accounts.google.com", "aud": "fake-client-id.apps.googleusercontent.com",
    })
    resp = client.post("/api/auth/google", json={"id_token": forged})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "GOOGLE_TOKEN_INVALID"
