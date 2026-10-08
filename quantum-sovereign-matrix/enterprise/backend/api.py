"""
FastAPI backend for the Proof Infrastructure Engine.

Chosen as the "powerful substitute" for the Next.js /api routes a fuller
spec called for: same role (serve /api/quantum/execute, /api/ipfs/pin,
/api/chain/verify), but Python — same language as proof_engine.py, so no
second runtime, and every endpoint below is actually exercised by
tests/test_api.py against a real local chain and a real (fake, local)
pinning server, not left as an unbuilt shell.

Run it:
    pip install -r requirements.txt
    uvicorn backend.api:app --reload

Every response follows the shape from the spec:
    {"ok": true, "data": {...}}
    {"ok": false, "error": {"code": "...", "message": "..."}}
No endpoint ever leaks a stack trace to the client.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel
from web3 import Web3

from .pinning import PinningError, pin_json
from .proof_engine import ProofEngine, ProofEngineError

app = FastAPI(title="Proof Infrastructure Engine API")


def ok(data: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": True, "data": data}


def err(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    # FastAPI's default 422 body is {"detail": [...]}, which breaks the
    # {ok, error{code,message}} contract every other response follows.
    # Normalize it instead of leaving one endpoint shape inconsistent.
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", []) if p != "body")
    message = f"{field}: {first.get('msg', 'invalid request body')}" if field else "invalid request body"
    return JSONResponse(status_code=422, content=err("INVALID_REQUEST", message))


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    # Fail closed on the response shape too: never let a raw traceback or
    # exception string reach the client (section 34 / section 30).
    return JSONResponse(status_code=500, content=err("INTERNAL_ERROR", "An internal error occurred."))


# ---------------------------------------------------------------------------
# POST /api/quantum/execute
# ---------------------------------------------------------------------------

class QuantumExecuteRequest(BaseModel):
    proof_type: str = "QUANTUM_GHZ_EXECUTION"
    demo: bool = False


@app.post("/api/quantum/execute")
def quantum_execute(body: QuantumExecuteRequest) -> JSONResponse:
    engine = ProofEngine()  # reads IBM_QUANTUM_TOKEN, ECDSA_PRIVATE_KEY_PEM from env
    try:
        result = engine.execute_ghz5_circuit()
    except ProofEngineError as exc:
        # Fails closed: no IBM token, no backend available, no job id, zero
        # shots - all of these raise here and are reported as a structured
        # error, never as a 200 with a placeholder-filled manifest.
        return JSONResponse(status_code=424, content=err("QUANTUM_EXECUTION_FAILED", str(exc)))

    try:
        manifest = (
            engine.build_demo_manifest(body.proof_type, result)
            if body.demo
            else engine.build_proof_manifest(body.proof_type, result)
        )
    except ProofEngineError as exc:
        return JSONResponse(status_code=424, content=err("MANIFEST_SIGNING_FAILED", str(exc)))

    return JSONResponse(content=ok({"manifest": manifest}))


# ---------------------------------------------------------------------------
# POST /api/ipfs/pin
# ---------------------------------------------------------------------------

class IpfsPinRequest(BaseModel):
    manifest: Dict[str, Any]
    filename: str = "Manifest_Sovereign.json"


@app.post("/api/ipfs/pin")
def ipfs_pin(body: IpfsPinRequest) -> JSONResponse:
    jwt = os.getenv("PINATA_JWT")
    if not jwt:
        # Fail closed: never invent a CID. A missing credential is reported
        # as a structured error, not papered over with a fake-looking pin.
        return JSONResponse(status_code=503, content=err("PINNING_NOT_CONFIGURED", "PINATA_JWT is not set."))
    base_url = os.getenv("PINATA_BASE_URL")  # override point for tests; unset in production
    kwargs = {"base_url": base_url} if base_url else {}
    try:
        cid = pin_json(body.manifest, filename=body.filename, jwt=jwt, **kwargs)
    except PinningError as exc:
        return JSONResponse(status_code=502, content=err("PINNING_FAILED", str(exc)))
    return JSONResponse(content=ok({"cid": cid, "gateway_url": f"https://dweb.link/ipfs/{cid}"}))


# ---------------------------------------------------------------------------
# POST /api/chain/verify
# ---------------------------------------------------------------------------

GENESIS_REGISTRY_V2_ABI = [
    {
        "inputs": [{"internalType": "bytes32", "name": "_evidenceHash", "type": "bytes32"}],
        "name": "verifyProof",
        "outputs": [
            {"internalType": "bool", "name": "isValid", "type": "bool"},
            {"internalType": "string", "name": "ipfsCID", "type": "string"},
            {"internalType": "string", "name": "proofType", "type": "string"},
            {"internalType": "uint256", "name": "timestamp", "type": "uint256"},
            {"internalType": "uint256", "name": "expiresAt", "type": "uint256"},
            {"internalType": "address", "name": "issuer", "type": "address"},
            {"internalType": "uint8", "name": "status", "type": "uint8"},
        ],
        "stateMutability": "view",
        "type": "function",
    }
]
STATUS_NAMES = ["NonExistent", "Active", "Revoked", "Expired"]


class ChainVerifyRequest(BaseModel):
    rpc_url: str
    contract_address: str
    digest_hex: str  # 64 hex chars, no 0x prefix (matches manifest.digest.value)


@app.post("/api/chain/verify")
def chain_verify(body: ChainVerifyRequest) -> JSONResponse:
    try:
        digest_bytes = bytes.fromhex(body.digest_hex.replace("0x", ""))
        if len(digest_bytes) != 32:
            raise ValueError("digest_hex must be 32 bytes (64 hex characters)")
    except ValueError as exc:
        return JSONResponse(status_code=400, content=err("INVALID_DIGEST", str(exc)))

    try:
        w3 = Web3(Web3.HTTPProvider(body.rpc_url, request_kwargs={"timeout": 10}))
        if not w3.is_connected():
            raise ConnectionError(f"Could not connect to RPC {body.rpc_url}")
        contract = w3.eth.contract(address=Web3.to_checksum_address(body.contract_address), abi=GENESIS_REGISTRY_V2_ABI)
        is_valid, ipfs_cid, proof_type, timestamp, expires_at, issuer, status = contract.functions.verifyProof(
            digest_bytes
        ).call()
        chain_id = w3.eth.chain_id
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any RPC/ABI/network failure reports as CHAIN_CHECK_FAILED
        return JSONResponse(status_code=502, content=err("CHAIN_CHECK_FAILED", str(exc)))

    return JSONResponse(content=ok({
        "chain_id": chain_id,
        "contract_address": body.contract_address,
        "is_valid": is_valid,
        "ipfs_cid": ipfs_cid or None,
        "proof_type": proof_type or None,
        "timestamp": timestamp,
        "expires_at": expires_at or None,
        "issuer": issuer,
        "status": STATUS_NAMES[status] if status < len(STATUS_NAMES) else str(status),
    }))


# ---------------------------------------------------------------------------
# POST /api/auth/google
#
# master.html's Sign In decodes the Google ID token CLIENT-SIDE, without
# checking its signature - that's explicitly labeled unverified there. This
# endpoint is the real check: it fetches Google's current public keys and
# verifies the token's signature, issuer, audience and expiry server-side,
# the only way to actually trust the claims inside it.
# ---------------------------------------------------------------------------

class GoogleAuthRequest(BaseModel):
    id_token: str


@app.post("/api/auth/google")
def auth_google(body: GoogleAuthRequest) -> JSONResponse:
    client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID")
    if not client_id:
        # Fail closed: without a known audience to check the token against,
        # "verifying" it would mean trusting an attacker-chosen client ID.
        return JSONResponse(status_code=503, content=err("GOOGLE_AUTH_NOT_CONFIGURED", "GOOGLE_OAUTH_CLIENT_ID is not set."))

    try:
        # Verifies: RS256 signature against Google's live JWKS, iss is
        # accounts.google.com (or https:// variant), aud matches client_id,
        # and the token is not expired. Raises ValueError on any failure.
        claims = google_id_token.verify_oauth2_token(body.id_token, google_requests.Request(), client_id)
    except ValueError as exc:
        return JSONResponse(status_code=401, content=err("GOOGLE_TOKEN_INVALID", str(exc)))

    return JSONResponse(content=ok({
        "sub": claims["sub"],
        "email": claims.get("email"),
        "email_verified": claims.get("email_verified", False),
        "name": claims.get("name"),
        "picture": claims.get("picture"),
        "verified_server_side": True,
    }))
