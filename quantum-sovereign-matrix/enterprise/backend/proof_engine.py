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
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import jcs
from ecdsa import SECP256k1, SigningKey
from ecdsa.util import sigencode_string_canonize
from qiskit import QuantumCircuit
from qiskit.transpiler import generate_preset_pass_manager
from qiskit_ibm_runtime import QiskitRuntimeService, SamplerV2 as Sampler

SIGNATURE_ALGORITHM = "ECDSA"
SIGNATURE_CURVE = "secp256k1"
SIGNATURE_ENCODING = "compact-r-s-hex"  # 64 bytes: 32-byte r || 32-byte s, big-endian, low-S


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

    def build_proof_manifest(self, proof_type: str, raw_payload: Dict[str, Any]) -> Dict[str, Any]:
        """Build a complete, signed proof manifest.

        Fails closed: raises if signing isn't possible rather than emitting
        an unsigned manifest that looks complete. If you deliberately want
        an unsigned manifest (e.g. for local testing), call
        canonicalize_and_hash yourself and assemble it explicitly.
        """
        canonical_bytes, digest_hex = self.canonicalize_and_hash(raw_payload)
        signature = self.sign_digest(digest_hex)

        return {
            "manifest_version": "4.0.0",
            "proof_type": proof_type,
            "payload": raw_payload,
            "canonicalization": "RFC 8785 (JSON Canonicalization Scheme)",
            "digest": {
                "algorithm": "SHA-256",
                "encoding": "hex",
                "value": digest_hex,
            },
            "signature": signature,
            "audit_trail": {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "canonical_byte_length": len(canonical_bytes),
            },
        }
