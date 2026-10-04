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
| Contract ABI | `anchor(string,bytes32)` / `latest()` | `anchorProof(bytes32,string,string,uint256)` / `verifyProof(bytes32)` |
| Canonicalization | one fixed-format quantum-output string, hashed as-is | RFC 8785 (JCS), via `jcs` (Python) / `canonicalize` (JS) |

**Do not mix the two ABIs.** Pick one contract (`../contracts/GenesisRegistry.sol`
or `contracts/GenesisRegistryV2.sol`) and use its matching function names
consistently in Remix, your backend, and your frontend.

**As of this layer's v2, `../master.html` also signs with ECDSA secp256k1**
(not P-256 — see the v2 changelog below), so a manifest produced by
`master.html`, `backend/proof_engine.py`, or anything else following this
spec all verify the same way, in `public/verify.html` or anywhere else.

## Protocol (v2), end to end

```
Quantum evidence (or any payload)
        │
        ▼
RFC 8785 JCS canonicalization   — `jcs` (Python) / `canonicalize` (JS, CDN)
        │
        ▼
SHA-256 digest (32 bytes)
        │
        ▼
ECDSA secp256k1, deterministic (RFC 6979), canonical low-S,
signed over the raw digest BYTES (never the hex text)
        │
        ▼
Signed manifest: { payload, canonicalization, digest{}, signature{...,public_key} }
        │
   ┌────┴────┐
   ▼         ▼
 IPFS      EVM anchor (GenesisRegistryV2.anchorProof(digest.value, cid, proofType))
   │         │
   └────┬────┘
        ▼
Zero-trust verifier (public/verify.html): digest match AND signature valid
AND public key present AND (chain check skipped OR chain record active +
CID match + proofType match) — every condition independent, none optional.
```

Every arrow above was executed for real in this environment while building
this layer — not just unit-tested in isolation — and is cross-checked
**byte-for-byte** across Python and JS:
canonicalization output, the signed digest, and the signature all produced
identical bytes regardless of which language signed and which verified. See
**Status** below for exactly what was run.

## Files

- `contracts/GenesisRegistryV2.sol` — content-hash-keyed registry with
  per-issuer revocation. Compiles clean under solc 0.8.26 (both its default
  settings and explicit `london` EVM version — the latter only needed for
  testing against an old local dev-chain; a real deployment needs no pin).
- `backend/proof_engine.py` — runs the same 5-qubit GHZ circuit as
  `../qiskit_ghz.py`, canonicalizes a payload (RFC 8785 via `jcs`), and signs
  its digest with a secp256k1 key (compact r||s, canonical low-S). Fails
  closed throughout: raises `ProofEngineError` rather than returning a
  result with a missing job ID, or a manifest without a real signature.
  Requires `pip install "qiskit>=2" qiskit-ibm-runtime ecdsa jcs`.
- `tests/test_proof_engine.py` — 7 pytest cases, including two that pin the
  exact defects this layer's v2 review caught (a non-canonical high-S
  signature a strict verifier would reject; signing digest *text* instead of
  digest *bytes*). No IBM account needed.
- `public/verify.html` — a standalone, client-side, granular-status
  verifier. Loads `canonicalize` + `@noble/secp256k1` + `@noble/hashes` from
  jsDelivr as ES modules (no build step). Checks the RFC 8785 digest, the
  secp256k1 signature (never silently "passing" when a public key is
  missing — that case is reported as its own non-passing status), and
  optionally an on-chain `GenesisRegistryV2` record (hash, status, CID,
  proofType all independently checked; a configured-but-failing chain check
  blocks the verdict, it is never treated the same as "not configured").
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

## v1 → v2: protocol corrections

v1 (the original pasted draft, lightly fixed) had real cryptographic
inconsistencies, caught in a follow-up review and fixed here — not style
preferences, defects that would have made cross-component verification
unreliable or silently pass things it shouldn't have:

1. **Mixed signature algorithms.** v1 had `proof_engine.py`/`verify.html` on
   SECP256k1 but `../master.html` on WebCrypto P-256 — almost certainly
   *because* browsers' native Web Crypto has no SECP256k1 support at all
   (only P-256/P-384/P-521). Fixed: `master.html` now signs with SECP256k1
   too, via a bundled `@noble/secp256k1` (not WebCrypto). All three now
   interoperate — confirmed by producing a manifest in a real headless
   browser run of `master.html` and independently verifying its signature
   with Python's `ecdsa`, and separately with `verify.html`.
2. **"RFC 8785" was sorted-key JSON, not RFC 8785.** Fixed: both sides now
   use a conformant implementation (`jcs` in Python, `canonicalize` in JS —
   the latter loaded from jsDelivr in `verify.html`/`master.html`), checked
   against a vector with a float and non-ASCII text where a naive
   "sort the keys" canonicalizer and true JCS disagree (JCS writes `1.0` as
   `1`); both implementations produced byte-identical output.
3. **Signed the digest's hex text, not its bytes.** v1's
   `sk.sign(sha256_digest.encode('utf-8'))` signed 64 ASCII characters, not
   the 32 raw digest bytes. Fixed: `sign_digest()` now signs
   `bytes.fromhex(digest_hex)` directly; a test pins that verifying against
   the old (hex-text) representation fails.
4. **Encoding: DER was recommended but isn't used — compact, by necessity.**
   `@noble/secp256k1` v3 (the current, maintained release) dropped DER
   support entirely ("switch to noble-curves"). Rather than pull in the
   larger `@noble/curves` for ASN.1 framing with no real benefit here (both
   ends of this protocol are known to each other), this protocol
   standardizes on fixed-size 64-byte compact `r‖s` encoding. This surfaced
   a second, sharper bug while testing cross-library signing: a signature
   can be mathematically valid yet "high-S," which `@noble/secp256k1`'s
   `verify()` rejects by default (BIP-62-style malleability protection) —
   Python's `ecdsa` does *not* canonicalize by default and needed
   `sigencode_string_canonize` explicitly, confirmed by generating a
   deliberately-unnormalized signature and watching an independent library
   (`cryptography`) reject it, then fixing it and watching both
   `@noble/secp256k1` and `cryptography` accept the same signature bytes.
5. **The verifier made signature verification optional.** A v1-style
   `hashMatches && (pubKey ? sigValid : true)` would call a hash-only match
   "cryptographically verified." Fixed: `verify.html` requires hash match
   **and** signature valid **and** a public key present; a missing key is
   reported as `SIGNATURE UNVERIFIED — KEY MISSING`, never as a pass.
6. **The manifest now carries its own public key**
   (`signature.public_key`), so a verifier never has to be told it
   out-of-band. As the review itself noted, this establishes cryptographic
   self-consistency, not a trust-bound identity — proving a key belongs to a
   specific person/org needs a separate mechanism (DID/VC, certificate,
   registry) that this layer does not implement.
7. **IPFS content-addressing isn't identity verification by itself**, and
   the on-chain check needed to be stronger than a loose string comparison.
   `verify.html` now extracts the bare CID from whatever was typed (a raw
   CID, an `ipfs://` URI, or a gateway URL) and requires it to equal the
   on-chain `ipfsCID` exactly, and separately requires the on-chain
   `proofType` to match the manifest's `proof_type` — both block the
   verdict on mismatch. It also surfaces chain ID, contract address,
   issuer, status and timestamp (not transaction hash/block number — those
   require indexing past `ProofAnchored` logs, which this verifier doesn't
   do; the registry's own event log has them if you need them).
   **A bug caught while building this**: a configured-but-erroring chain
   check (bad address, unreachable RPC) must never fall back to behaving
   like "not configured" — it has to block the verdict. The first version
   of this verifier had exactly that bug; a headless test against a bad
   contract address caught it immediately, and it's fixed.
8. **`ProofAnchored`'s `ipfsCID`/`proofType` are no longer marked
   `indexed`** — Solidity stores an indexed `string` as `keccak256(value)`
   in the log topic, not the string itself, which would silently give a UI
   a hash instead of a CID if it read the topic directly. They're emitted as
   plain event data instead; the full record is always available from the
   `registry` mapping regardless.
9. **`revokeProof` reordered**: existence → issuer → currently-Active, so a
   nonexistent hash reports `RecordNotFound` instead of a misleading
   `UnauthorizedIssuer(caller, address(0))`, and revoking twice now reverts
   (`NotActive`) instead of silently no-op'ing.
10. **Renamed the fidelity metric** to
    `ghz_computational_basis_population_fidelity`, with its definition and a
    note in both the field and the docstring that it is a computational-basis
    population count, not a full quantum-state fidelity/tomography
    measurement.
11. **No more `qpu_execution_confirmed: true` boolean.** Replaced with an
    `execution: { provider, backend_name, job_id, execution_status }` block
    that states what was supplied, not an unearned broader claim.
12. **Fails closed, not placeholder-friendly.** v1-style fallbacks like
    `"ibm_brisbane"` or `"UNASSIGNED_JOB_ID"` are gone. `execute_ghz5_circuit`
    and `sign_digest`/`build_proof_manifest` now raise `ProofEngineError`
    rather than returning something that looks like a completed proof when
    it isn't one.

The granular verdict states this calls for (points 4/7 in the review) are
implemented as individual status rows in `verify.html` rather than one
pass/fail badge: `INVALID MANIFEST`, `DIGEST MISMATCH`, `SIGNATURE INVALID`,
`SIGNATURE UNVERIFIED — KEY MISSING`, `IPFS RETRIEVAL FAILED`,
`CHAIN RECORD NOT FOUND`, `CHAIN CID MISMATCH`, `CHAIN PROOF TYPE MISMATCH`,
`PROOF REVOKED`, `CHAIN CHECK FAILED`, `CHAIN CHECK SKIPPED — NOT CONFIGURED`,
and only `PROVENANCE CONFIRMED` when every applicable one passed.

## v3: manifest schema, proof types, demo mode, lifecycle/expiry

A further specification asked for a domain-agnostic manifest schema, support
for multiple evidence domains, a clearly-marked demo mode, and an expiry
concept in the registry. Added:

- **Manifest v4 schema** (`ProofEngine.build_proof_manifest`): every
  manifest now carries `proof_id` (UUID), `schema_version` (per proof type),
  `canonicalization: {name, version}`, `signer: {type, id}`, `ipfs:
  {cid, gateway_urls}` and `blockchain: {network, chain_id,
  contract_address, tx_hash, block_number, anchored_hash}` — both `null`
  until a real anchor transaction actually mines — and `lifecycle:
  {status, revoked_at, expires_at}`. `ProofEngine.record_anchor(...)` fills
  in `ipfs`/`blockchain` after the fact and has **no default value for any
  argument**, so there is no way to accidentally fill in a plausible-looking
  placeholder transaction hash.
- **Proof-type validation** (`ProofEngine.validate_payload`, called before
  signing — never after): `QUANTUM_GHZ_EXECUTION`, `AI_VISIBILITY_AUDIT`,
  `CREDENTIAL_VERIFICATION`, `BUSINESS_EVIDENCE` each require their own
  domain-specific fields; an incomplete payload raises `ProofEngineError`
  before it can ever reach a signed manifest (see
  `test_fails_closed_on_incomplete_domain_payload`). This is presence
  checking, not a full JSON Schema validator, and is documented as such.
- **Demo mode**: `ProofEngine.build_demo_manifest(...)` produces a manifest
  that is cryptographically real (genuinely hashed and signed — a real
  verifier can confirm that) but stamped `mode: "DEMO"` /
  `verification_status: "DEMO_ONLY"` at the manifest root. `verify.html`
  checks for this before computing a final verdict and reports `◆ DEMO
  ONLY` no matter how cleanly the crypto checks pass — confirmed with a
  real demo-valid/demo-tampered pair in `demo/`, both run through a real
  headless `verify.html` (see **Status**).
- **Lifecycle + expiry on `GenesisRegistryV2`**: `anchorProof` takes an
  `_expiresAt` (0 = never). `Expired` is a **derived** status, never
  stored — a record's on-chain `status` field only ever holds NonExistent,
  Active or Revoked, so the history of real state transitions stays
  immutable, while `verifyProof`'s returned status reflects the true
  current effective state (Active records past their `expiresAt` read as
  Expired). `revokeProof` on an expired-but-not-yet-revoked record now
  correctly reverts (`NotActive`) rather than succeeding or reviving it.
  `anchorProof` also now rejects an `_expiresAt` already in the past.
- **`verify.html` rewritten** around the full granular checklist a later
  spec asked for: `[PASS]`/`[FAIL]`/`[WARN]`/`[SKIP]`/`[DEMO]` rows for
  manifest retrieval, schema validity, canonicalization, digest match,
  signature presence *and* validity (checked separately — see **Protocol
  v2** above for why "present" and "valid" must never be collapsed into
  one check), issuer-key presence, provider-execution-record-supplied (with
  an explicit `PROVENANCE UNCONFIRMED` line — this page cannot itself query
  IBM to confirm a job actually ran), and the full on-chain set (record
  found, hash match, CID match, proof type match, lifecycle). It also
  renders a copyable **Verification Report** (proof id/type, digest,
  signature algorithm/curve/key, provider/backend/job id, chain id/contract/
  tx/anchor time, lifecycle status, methodology version, final result) with
  links to the IPFS manifest, a best-effort block-explorer link for common
  chain IDs, and a shareable `?cid=` verification URL — and a fixed
  "what this does and does not establish" panel, including stating plainly
  that it does **not** recompute the IPFS CID's multihash from the
  retrieved bytes (`CONTENT RETRIEVED FROM GATEWAY — CID NOT LOCALLY
  RECOMPUTED`) rather than overclaiming CID verification it isn't doing.

## Scope: what's built vs. what's an integration boundary

A fuller specification for this layer additionally asked for a complete
Next.js application — `/app` routes, `/api/quantum/execute`,
`/api/ipfs/pin`, `/api/chain/verify`, server-side secret handling, W3C
DID/VC compliance, Vercel deployment, and more. Building that would mean
writing server code against IBM Quantum, Pinata, and an RPC provider that
this environment has no credentials for, and calling it "done" without ever
running it — which is exactly the kind of overclaim this whole layer exists
to prevent. Instead, consistent with "if a real external credential is
required but unavailable: implement the integration boundary, provide
`.env.example`, provide explicit setup instructions, use clearly marked
demo mode, fail closed for production verification":

- **Built and tested for real**: `ProofEngine` (the integration boundary
  itself — the exact functions a real `/api/quantum/execute` route would
  call), the manifest schema, proof-type validation, demo mode,
  `GenesisRegistryV2.sol`, and `verify.html` (which needs no backend at
  all — it's the "usable without a centralized verification database" piece
  explicitly called for).
- **Not built**: the Next.js app shell, its API routes, and anything
  requiring W3C VC/DID spec compliance (the `signer`/`credential` fields
  are shaped to be compatible with that work, not a claim of conformance to
  it).
- **`.env.example`** lists every secret a real deployment would need, with
  no real values and a reminder never to expose them client-side.

## Status

Verified in this environment (not just unit tests in isolation — an actual
local chain, actual headless-browser runs of each HTML page, and
cross-library checks):

- `pytest tests/test_proof_engine.py` → **12 passed**: the 7 from the v2
  protocol-correction round plus 5 new ones covering schema shape,
  fail-closed validation on an unknown proof type, fail-closed validation
  on an incomplete domain payload, all four proof types accepting a minimal
  valid payload, the demo manifest being flagged yet still cryptographically
  genuine, and `record_anchor`'s no-default-values guarantee.
- `GenesisRegistryV2.sol` compiles clean under solc 0.8.26 (default
  settings — no EVM-version pin needed for a real network; `london` was
  used only to work around an old local test-chain's missing PUSH0 support).
- Deployed to a local Ganache chain and exercised for real, not mocked:
  `anchorProof` (with and without an expiry, and rejecting an expiry
  already in the past), `verifyProof` reporting the correct effective
  status including the derived `Expired` state (confirmed by advancing the
  chain's clock with `evm_increaseTime`/`evm_mine`, not just wall-clock
  sleep — a first attempt at this test looked like it failed only because
  no block had actually been mined to advance `block.timestamp`),
  `revokeProof` correctly reverting on a nonexistent record, an
  already-revoked record, and an already-expired record.
- `master.html` run headlessly end to end (wallet connect, hash, key
  generation, assessment, manifest download) in iPhone-viewport Chromium;
  the resulting manifest's signature was independently verified by Python's
  `ecdsa` **and** by `verify.html` in a separate browser run.
- `verify.html` exercised against, each in a real headless browser: a real
  manifest anchored on the local chain with a matching CID and proof type
  (full `CRYPTOGRAPHICALLY VERIFIED + CHAIN ANCHOR VERIFIED`), a valid
  manifest with no chain configured (`INTEGRITY + SIGNATURE VERIFIED`, no
  chain claim made), a valid manifest checked against a malformed contract
  address (correctly fails, does not fall back to "skipped"), a tampered
  payload (`DIGEST MISMATCH`), a manifest with no `public_key`
  (`SIGNATURE UNVERIFIED — KEY MISSING`, not a pass), a revoked on-chain
  record (`PROOF REVOKED`), and the demo-valid/demo-tampered pair in
  `demo/` (valid demo's crypto genuinely passes but final result is still
  `DEMO ONLY`; tampered demo correctly fails its digest check).
- `App.jsx` parses as valid JSX (esbuild) and its ABI/field references were
  updated to match the current manifest shape and the `_expiresAt` /
  `expiresAt` contract signature, though the component itself still has no
  backend or deployed contract to run against (see **Scope** above).

Not verified (needs your own credentials/infra): a real IBM hardware run
through `execute_ghz5_circuit`, an actual Sepolia/mainnet `anchorProof`
transaction, or a live Pinata upload.
