"""
ProofEngine — server-side counterpart to ../../qiskit_ghz.py and
quantum_hash.py, for a backend that runs the quantum job itself, signs the
result with its own ECDSA key, and serves manifests to the React/verify.html
frontends in this `enterprise/` folder.

Requires:
    pip install "qiskit>=2" qiskit-ibm-runtime ecdsa

Secrets (never commit these, never paste them into a chat):
    IBM_QUANTUM_TOKEN      - from quantum.cloud.ibm.com
    ECDSA_PRIVATE_KEY_PEM  - a PEM-encoded SECP256k1 private key, e.g.
                             generated once with:
                               from ecdsa import SigningKey, SECP256k1
                               open("key.pem","wb").write(
                                   SigningKey.generate(curve=SECP256k1).to_pem())

Canonicalization note: `canonicalize_and_hash` below sorts object keys and
uses compact separators, which matches what `enterprise/public/verify.html`
does in the browser so both sides compute the same hash. It is a practical
subset of JSON canonicalization, not a full RFC 8785 (JCS) implementation
(it does not do JCS's exact number formatting or string normalization). If
you need strict RFC 8785, use a dedicated library such as `python-canonicaljson`
on the backend and a matching JS implementation on the frontend.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Tuple

from ecdsa import SECP256k1, SigningKey
from qiskit import QuantumCircuit
from qiskit.transpiler import generate_preset_pass_manager
from qiskit_ibm_runtime import QiskitRuntimeService, SamplerV2 as Sampler


class ProofEngine:
    def __init__(self, ibm_token: str | None = None, private_key_pem: bytes | None = None):
        self.ibm_token = ibm_token or os.getenv("IBM_QUANTUM_TOKEN")
        pem_env = os.getenv("ECDSA_PRIVATE_KEY_PEM")
        self.private_key_pem = private_key_pem or (pem_env.encode("utf-8") if pem_env else None)

    def execute_ghz5_circuit(self) -> Dict[str, Any]:
        """Execute a 5-qubit GHZ circuit on the least-busy IBM Quantum backend."""
        if not self.ibm_token:
            raise ValueError("IBM_QUANTUM_TOKEN is missing.")

        service = QiskitRuntimeService(channel="ibm_quantum_platform", token=self.ibm_token)
        backend = service.least_busy(operational=True, simulator=False, min_num_qubits=5)

        qc = QuantumCircuit(5, 5, name="ghz5")
        qc.h(0)
        for q in range(4):
            qc.cx(q, q + 1)
        qc.measure(range(5), range(5))

        # Real hardware only runs circuits already written in its native gates
        # and qubit layout, so transpile through a preset pass manager first.
        pm = generate_preset_pass_manager(backend=backend, optimization_level=3)
        isa_circuit = pm.run(qc)

        sampler = Sampler(mode=backend)
        job = sampler.run([isa_circuit], shots=1024)
        result = job.result()

        counts = result[0].data.c.get_counts()
        total_shots = sum(counts.values())
        ghz_fidelity = round((counts.get("00000", 0) + counts.get("11111", 0)) / total_shots, 4)

        return {
            "backend_name": backend.name,
            "job_id": job.job_id(),
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "shots": total_shots,
            "raw_counts": dict(counts),
            "ghz_fidelity": ghz_fidelity,
            "fidelity_passed": ghz_fidelity >= 0.70,
        }

    @staticmethod
    def canonicalize_and_hash(payload: Dict[str, Any]) -> Tuple[str, str]:
        """Deterministic sorted-key JSON string + its SHA-256 hex digest.

        See the module docstring: this is a practical canonical form, not a
        certified RFC 8785 implementation.
        """
        canonical_str = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        digest = hashlib.sha256(canonical_str.encode("utf-8")).hexdigest()
        return canonical_str, digest

    def sign_hash(self, digest_hex: str) -> str:
        """Sign a hex digest with the engine's SECP256k1 key. Returns a hex signature."""
        if not self.private_key_pem:
            raise ValueError("ECDSA_PRIVATE_KEY_PEM is missing.")
        sk = SigningKey.from_pem(self.private_key_pem)
        return sk.sign(digest_hex.encode("utf-8")).hex()

    def build_proof_manifest(self, proof_type: str, raw_payload: Dict[str, Any]) -> Dict[str, Any]:
        """Build a complete, signed proof manifest ready for IPFS + on-chain anchoring."""
        canonical_str, digest = self.canonicalize_and_hash(raw_payload)
        manifest = {
            "manifest_version": "3.0.0",
            "proof_type": proof_type,
            "canonical_digest_sha256": digest,
            "payload": raw_payload,
            "audit_trail": {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "canonicalization": "sorted-key JSON, compact separators (see module docstring)",
            },
        }
        if self.private_key_pem:
            manifest["signature_secp256k1"] = self.sign_hash(digest)
        return manifest
