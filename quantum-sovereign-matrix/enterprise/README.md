# Enterprise Proof Infrastructure Layer (optional)

This folder is a **second, server-based path**, separate from the free,
no-backend iPhone flow in `../DEPLOYMENT.md` (`../qiskit_ghz.py`,
`../quantum_hash.py`, `../master.html`, `../contracts/GenesisRegistry.sol`).
Use it only if you already have, or want to run, your own backend and are
comfortable paying gas for anchoring. Everything here has been fixed up and
tested (see **Status** below) from the originally pasted draft.

| | Base flow (`../`) | This enterprise layer |
|---|---|---|
| Runs where | iPhone + Colab + Pinata, no server | Your own backend + a React frontend |
| Contract ABI | `anchor(string,bytes32)` / `latest()` | `anchorProof(bytes32,string,string)` / `verifyProof(bytes32)` |
| Key/signing | ECDSA P-256, generated and kept in the browser | ECDSA SECP256k1, held by your backend |
| Canonicalization | one fixed-format quantum-output string, hashed as-is | sorted-key JSON (practical subset, not certified RFC 8785 — see `backend/proof_engine.py`) |

**Do not mix the two ABIs.** Pick one contract (`../contracts/GenesisRegistry.sol`
or `contracts/GenesisRegistryV2.sol`) and use its matching function names
consistently in Remix, your backend, and your frontend.

## Files

- `contracts/GenesisRegistryV2.sol` — content-hash-keyed registry with
  per-issuer revocation. Compiles under solc ^0.8.24 (verified).
- `backend/proof_engine.py` — runs the same 5-qubit GHZ circuit as
  `../qiskit_ghz.py` via a backend process, canonicalizes a payload, and signs
  its hash with a SECP256k1 key. Requires `pip install "qiskit>=2"
  qiskit-ibm-runtime ecdsa`.
- `tests/test_proof_engine.py` — pytest suite for canonicalization and
  signing (3 tests, no IBM account needed; passing as of this commit).
- `public/verify.html` — a standalone, client-side verifier: paste a CID,
  it fetches the manifest and recomputes the hash in-browser. Its JS
  canonicalization is written to match `proof_engine.py`'s Python
  canonicalization exactly — this was tested by hashing the same manifest
  with both and confirming identical output.
- `frontend/src/App.jsx` — a reference React dashboard (wallet connect,
  trigger a quantum run via a backend endpoint, anchor the result,
  browse evidence CIDs). **Not a runnable app by itself** — it has no
  `package.json` or build config; drop it into an existing Vite/CRA/Next
  project with `ethers` v6 and Tailwind installed.

## What you still need to build

This layer does **not** include a server. `App.jsx` calls
`POST /api/quantum/execute` — you implement that endpoint yourself, calling:

```python
from backend.proof_engine import ProofEngine

engine = ProofEngine()  # reads IBM_QUANTUM_TOKEN, ECDSA_PRIVATE_KEY_PEM from env
result = engine.execute_ghz5_circuit()          # runs on real IBM hardware
manifest = engine.build_proof_manifest("QUANTUM_GHZ", result)
# pin `manifest` to IPFS yourself (e.g. Pinata's API), then return:
# { "manifest": manifest, "ipfsCid": "<cid returned by your pinning call>" }
```

Secrets (`IBM_QUANTUM_TOKEN`, `ECDSA_PRIVATE_KEY_PEM`, your Pinata key) belong
in your backend's environment/secret manager — never in this repo, never in
a chat.

## Status / what changed from the original draft

The pasted draft had a few issues fixed here so the code actually runs:

- `execute_ghz5_circuit` was missing `self` — fixed.
- Counts were read with a fragile `hasattr(data, 'meas')` fallback; since the
  circuit uses `qc.measure(range(5), range(5))` the classical register is
  always named `c`, so this now reads `result[0].data.c.get_counts()`
  directly (confirmed via Qiskit).
- Added `generate_preset_pass_manager(...)` before running on hardware —
  real IBM backends only accept circuits already transpiled to their native
  gates and qubit layout.
- The "RFC 8785 JCS" label was inaccurate (no UTF-16 key ordering, no
  JCS number formatting); the docstrings and this README now call it what
  it is — sorted-key JSON with compact separators — and verify.html was
  written to match it exactly, confirmed by hashing one manifest both ways.
- `GenesisRegistry.sol` was renamed to `GenesisRegistryV2.sol` here so it
  doesn't collide with `../contracts/GenesisRegistry.sol`, which the base
  `DEPLOYMENT.md` guide already references with a different ABI.

Verified in this environment:
- `pytest tests/test_proof_engine.py` → 3 passed
- `GenesisRegistryV2.sol` compiles clean under solc 0.8.26
- `App.jsx` parses as valid JSX (esbuild)
- `verify.html` run headlessly against a manifest produced by
  `proof_engine.py`: computed hash matched the manifest's stated hash

Not verified (needs your own credentials/infra): a real IBM hardware run
through `execute_ghz5_circuit`, an actual on-chain `anchorProof` call, or a
live Pinata upload.
