"""
ProofEngine v2 — corrected per a protocol review that found real defects in
v1 (see enterprise/README.md "Protocol corrections, v2"):

  * v1 mixed ECDSA P-256 (master.html) with ECDSA SECP256k1 (this file /
    verify.html). Fixed: the whole protocol now standardizes on SECP256k1.
  * v1's "canonicalize_and_hash" was sorted-key JSON, not RFC 8785. Fixed:
    this now uses the `jcs` package (pip install jcs), an actual RFC 8785
    JSON Canonicalization Scheme implementation, matched on the JS side by
    the `canonicalize` npm package — the two were confirmed to produce
    byte-identical output on a test payload with floats and non-ASCII text.
  * v1 signed `digest_hex.encode("utf-8")` — the 64 ASCII hex *characters*,
    not the 32 raw digest bytes. Fixed: this now signs the digest bytes
    directly via `sign_digest_deterministic`.
  * v1 left the signature encoding unspecified. Fixed and cross-verified:
    deterministic ECDSA (RFC 6979, SHA-256), canonical low-S, encoded as a
    fixed 64-byte "compact" r||s hex string. (The review suggested DER;
    @noble/secp256k1 v3 — the only maintained JS secp256k1 lib with a small,
    audited surface — dropped DER support ["switch to noble-curves"], so
    this protocol uses compact encoding instead: simpler, fixed-size, and
    confirmed byte-for-byte identical whether Python or JS signs and the
    other verifies, including the low-S case that silently breaks
    naive cross-library verification.)

Requires: pip install "qiskit>=2" qiskit-ibm-runtime ecdsa jcs
"""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import jcs
from ecdsa import SECP256k1, SigningKey
from ecdsa.util import sigencode_string_canonize
from qiskit import QuantumCircuit
from qiskit.transpiler import generate_preset_pass_manager
from qiskit_ibm_runtime import QiskitRuntimeService, SamplerV2 as Sampler

SIGNATURE_ALGORITHM = "ECDSA"
SIGNATURE_CURVE = "secp256k1"
SIGNATURE_ENCODING = "compact-r-s-hex"  # 64 bytes: 32-byte r || 32-byte s, big-endian, low-S

PROTOCOL_VERSION = "4.0.0"
METHODOLOGY_VERSION = "1.0"
CANONICALIZATION = {"name": "RFC8785-JCS", "version": "1.0"}

# proof_type -> (schema_version, required top-level keys within `payload`).
# This is deliberately shallow (presence checks, not full JSON Schema) — it
# exists to fail closed on an obviously incomplete domain payload, not to be
# a complete validator for every field shape.
PROOF_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "QUANTUM_GHZ_EXECUTION": {
        "schema_version": "quantum-ghz@1",
        "required": ["execution", "circuit", "shots", "raw_counts", "ghz_computational_basis_population_fidelity"],
    },
    "AI_VISIBILITY_AUDIT": {
        "schema_version": "ai-visibility-audit@1",
        "required": ["audit"],
        "required_audit": ["query", "provider", "model", "timestamp", "response_hash"],
    },
    "CREDENTIAL_VERIFICATION": {
        "schema_version": "credential-verification@1",
        "required": ["credential"],
        "required_credential": ["issuer", "subject", "type"],
    },
    "BUSINESS_EVIDENCE": {
        "schema_version": "business-evidence@1",
        "required": ["evidence_type", "description"],
    },
}


class ProofEngineError(RuntimeError):
    """Raised when the engine cannot produce a proof it can stand behind.

    The engine fails closed: if a quantum job didn't actually complete, or a
    key isn't available to sign with, it raises rather than emitting a
    manifest with placeholder/fabricated fields.
    """


class ProofEngine:
    def __init__(self, ibm_token: Optional[str] = None, private_key_pem: Optional[bytes] = None):
        self.ibm_token = ibm_token or os.getenv("IBM_QUANTUM_TOKEN")
        pem_env = os.getenv("ECDSA_PRIVATE_KEY_PEM")
        self.private_key_pem = private_key_pem or (pem_env.encode("utf-8") if pem_env else None)

    def execute_ghz5_circuit(self) -> Dict[str, Any]:
        """Execute a 5-qubit GHZ circuit on the least-busy IBM Quantum backend.

        Fails closed: raises ProofEngineError rather than returning a result
        with a missing job_id/backend_name if anything about execution is
        incomplete. Never call this expecting a placeholder result back.
        """
        if not self.ibm_token:
            raise ProofEngineError("IBM_QUANTUM_TOKEN is missing. Refusing to fabricate a quantum result.")

        service = QiskitRuntimeService(channel="ibm_quantum_platform", token=self.ibm_token)
        backend = service.least_busy(operational=True, simulator=False, min_num_qubits=5)

        qc = QuantumCircuit(5, 5, name="ghz5")
        qc.h(0)
        for q in range(4):
            qc.cx(q, q + 1)
        qc.measure(range(5), range(5))

        pm = generate_preset_pass_manager(backend=backend, optimization_level=3)
        isa_circuit = pm.run(qc)

        sampler = Sampler(mode=backend)
        job = sampler.run([isa_circuit], shots=1024)
        job_id = job.job_id()
        if not job_id:
            raise ProofEngineError("IBM did not return a job ID; refusing to produce a proof for it.")

        result = job.result()
        counts = result[0].data.c.get_counts()
        total_shots = sum(counts.values())
        if total_shots == 0:
            raise ProofEngineError(f"Job {job_id} returned zero shots; refusing to produce a proof for it.")

        # This is a computational-basis population metric, NOT a full
        # quantum-state fidelity/tomography measurement. Name and document
        # it as such so nobody downstream overstates what it shows.
        basis_population = round((counts.get("00000", 0) + counts.get("11111", 0)) / total_shots, 4)

        return {
            "execution": {
                "provider": "IBM Quantum (Open Plan)",
                "backend_name": backend.name,
                "job_id": job_id,
                "execution_status": "COMPLETED",
            },
            "circuit": "GHZ-5 (H q0, CNOT chain q0->q4, measure all)",
            "shots": total_shots,
            "raw_counts": dict(counts),
            "ghz_computational_basis_population_fidelity": {
                "value": basis_population,
                "definition": "(count('00000') + count('11111')) / total_shots",
                "note": (
                    "Measures population in the two expected computational-basis "
                    "outcomes of a GHZ state. This is NOT a full quantum-state "
                    "fidelity or tomography measurement."
                ),
            },
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        }

    @staticmethod
    def canonicalize_and_hash(payload: Dict[str, Any]) -> Tuple[bytes, str]:
        """RFC 8785 (JCS) canonical bytes of `payload`, and their SHA-256 hex digest."""
        canonical_bytes = jcs.canonicalize(payload)
        digest_hex = hashlib.sha256(canonical_bytes).hexdigest()
        return canonical_bytes, digest_hex

    def sign_digest(self, digest_hex: str) -> Dict[str, str]:
        """Sign a hex digest's raw bytes (not its ASCII text) with SECP256k1.

        Deterministic (RFC 6979) + canonical low-S, so the same digest+key
        always yields the same signature, and the result is accepted by
        verifiers (including @noble/secp256k1) that reject malleable high-S
        signatures by default.
        """
        if not self.private_key_pem:
            raise ProofEngineError("ECDSA_PRIVATE_KEY_PEM is missing. Refusing to emit an unsigned proof silently.")

        digest_bytes = bytes.fromhex(digest_hex)
        if len(digest_bytes) != 32:
            raise ProofEngineError(f"Expected a 32-byte SHA-256 digest, got {len(digest_bytes)} bytes.")

        sk = SigningKey.from_pem(self.private_key_pem)
        sig_bytes = sk.sign_digest_deterministic(
            digest_bytes, hashfunc=hashlib.sha256, sigencode=sigencode_string_canonize
        )
        public_key_hex = sk.get_verifying_key().to_string("uncompressed").hex()  # "04" + X(32B) + Y(32B)

        return {
            "algorithm": SIGNATURE_ALGORITHM,
            "curve": SIGNATURE_CURVE,
            "encoding": SIGNATURE_ENCODING,
            "value": sig_bytes.hex(),
            "public_key": public_key_hex,
        }

    @staticmethod
    def validate_payload(proof_type: str, payload: Dict[str, Any]) -> str:
        """Fail closed on an obviously incomplete domain payload.

        Returns the proof type's schema_version on success, or raises
        ProofEngineError naming exactly what's missing. This is a presence
        check, not a full JSON Schema validator — it exists so a payload
        missing its domain evidence can never reach a signed manifest.
        """
        schema = PROOF_SCHEMAS.get(proof_type)
        if schema is None:
            raise ProofEngineError(
                f"Unknown proof_type {proof_type!r}. Known types: {sorted(PROOF_SCHEMAS)}"
            )
        missing = [k for k in schema["required"] if k not in payload]
        if missing:
            raise ProofEngineError(f"{proof_type} payload is missing required field(s): {missing}")
        if "required_audit" in schema:
            missing_audit = [k for k in schema["required_audit"] if k not in payload.get("audit", {})]
            if missing_audit:
                raise ProofEngineError(f"{proof_type} payload.audit is missing: {missing_audit}")
        if "required_credential" in schema:
            missing_cred = [k for k in schema["required_credential"] if k not in payload.get("credential", {})]
            if missing_cred:
                raise ProofEngineError(f"{proof_type} payload.credential is missing: {missing_cred}")
        return schema["schema_version"]

    def build_proof_manifest(
        self,
        proof_type: str,
        raw_payload: Dict[str, Any],
        signer: Optional[Dict[str, str]] = None,
        demo: bool = False,
    ) -> Dict[str, Any]:
        """Build a complete, signed proof manifest matching the v4 schema:

        manifest_version, proof_id, proof_type, schema_version, payload,
        canonicalization{name,version}, digest{}, signature{...,public_key},
        signer{type,id}, ipfs{cid,gateway_urls} (null until pinned),
        blockchain{...} (null until anchored), lifecycle{status,...},
        created_at, verification{protocol_version, methodology_version}.

        Fails closed: raises if the domain payload is incomplete, or if
        signing isn't possible, rather than emitting a manifest that looks
        complete but isn't. `demo=True` additionally stamps the manifest
        `mode: "DEMO"` / `verification_status: "DEMO_ONLY"` so no verifier
        can mistake it for a production proof, however cleanly it verifies.
        """
        schema_version = self.validate_payload(proof_type, raw_payload)
        canonical_bytes, digest_hex = self.canonicalize_and_hash(raw_payload)
        signature = self.sign_digest(digest_hex)

        manifest = {
            "manifest_version": PROTOCOL_VERSION,
            "proof_id": str(uuid.uuid4()),
            "proof_type": proof_type,
            "schema_version": schema_version,
            "payload": raw_payload,
            "canonicalization": dict(CANONICALIZATION),
            "digest": {"algorithm": "SHA-256", "encoding": "hex", "value": digest_hex},
            "signature": signature,
            "signer": signer or {"type": "secp256k1-key", "id": signature["public_key"]},
            "ipfs": {"cid": None, "gateway_urls": []},
            # Populated for real only after an actual on-chain anchorProof
            # call succeeds — never guessed, never left as a plausible-looking
            # placeholder.
            "blockchain": {
                "network": None,
                "chain_id": None,
                "contract_address": None,
                "tx_hash": None,
                "block_number": None,
                "anchored_hash": None,
            },
            "lifecycle": {"status": "ACTIVE", "revoked_at": None, "expires_at": None},
            "created_at": datetime.now(timezone.utc).isoformat(),
            "verification": {"protocol_version": PROTOCOL_VERSION, "methodology_version": METHODOLOGY_VERSION},
        }
        if demo:
            manifest["mode"] = "DEMO"
            manifest["verification_status"] = "DEMO_ONLY"
        return manifest

    def build_demo_manifest(self, proof_type: str, raw_payload: Dict[str, Any]) -> Dict[str, Any]:
        """A manifest that is cryptographically real (genuinely hashed and
        signed, verifiable with real cryptography) but is stamped DEMO so it
        can never be displayed or mistaken as a production proof — see
        demo/ for a generated pair (valid + tampered)."""
        return self.build_proof_manifest(proof_type, raw_payload, demo=True)

    def record_anchor(
        self,
        manifest: Dict[str, Any],
        *,
        network: str,
        chain_id: int,
        contract_address: str,
        tx_hash: str,
        block_number: int,
        ipfs_cid: str,
        gateway_urls: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Fill in `ipfs`/`blockchain` on a manifest AFTER a real anchor
        transaction has actually been mined. Never call this with guessed or
        placeholder values — there is deliberately no default for any
        argument here."""
        out = dict(manifest)
        out["ipfs"] = {"cid": ipfs_cid, "gateway_urls": gateway_urls or [f"https://dweb.link/ipfs/{ipfs_cid}"]}
        out["blockchain"] = {
            "network": network,
            "chain_id": chain_id,
            "contract_address": contract_address,
            "tx_hash": tx_hash,
            "block_number": block_number,
            "anchored_hash": manifest["digest"]["value"],
        }
        return out
