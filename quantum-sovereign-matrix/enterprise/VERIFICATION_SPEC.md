# Verification Specification

This document lets a third-party developer build an independent verifier for
Proof Infrastructure Engine manifests without reading `public/verify.html`'s
source. It is the authoritative definition; `public/verify.html` is one
implementation of it (JavaScript, no backend) and `backend/proof_engine.py`
is the signing-side implementation (Python).

Two manifest versions are in active use and both are valid:

| `manifest_version` | Produced by | Notes |
|---|---|---|
| `2.0.0` | `master.html` (client-only, no backend) | `proof_type: "SOVEREIGN_EVIDENCE_MANIFEST"` |
| `4.0.0` | `backend/proof_engine.py` (enterprise, signed server-side) | nested nested `digest`/`signature`/`lifecycle`/`blockchain` objects |

A verifier MUST reject any other `manifest_version` rather than guess
compatibility (see "No silent downgrades" below).

## 1. Manifest schema

Both versions share this minimal shape, which is all a verifier strictly
needs:

```json
{
  "manifest_version": "4.0.0",
  "proof_type": "...",
  "payload": { "...": "..." },
  "digest": { "algorithm": "SHA-256", "encoding": "hex", "value": "..." },
  "signature": {
    "algorithm": "ECDSA", "curve": "secp256k1",
    "encoding": "compact-r-s-hex", "value": "...", "public_key": "..."
  }
}
```

`4.0.0` manifests additionally carry `canonicalization`, `signer`, `ipfs`,
`blockchain`, `lifecycle`, `created_at`, `verification`, `proof_id`,
`schema_version`, and optionally `mode`/`verification_status` for demo
records (see "Demo records" below).

## 2. Canonicalization procedure

`payload` is canonicalized with **RFC 8785 (JSON Canonicalization Scheme,
JCS)** — not sorted-key `JSON.stringify`, which differs on number formatting
and string escaping. Reference implementations:

- Python: the `jcs` package (`jcs.canonicalize(payload)` → bytes)
- JavaScript: the `canonicalize` npm package (`canonicalize(payload)` →
  string, then UTF-8 encode)

These two were confirmed to produce byte-identical output on payloads
containing floats and non-ASCII text.

## 3. Digest procedure

```
digest = SHA-256(UTF-8(JCS(payload)))
```

Represented as 64 lowercase hex characters. **The verifier must recompute
this from the retrieved `payload`, never trust the manifest's own stated
`digest.value` as ground truth** — it only compares the two.

## 4. Signature procedure

- Algorithm: ECDSA
- Curve: secp256k1 (classical elliptic-curve cryptography — **not**
  post-quantum; do not describe it as quantum-resistant)
- What is signed: the raw 32 **bytes** of the SHA-256 digest (not its 64
  hex-character ASCII text)
- Determinism: RFC 6979 deterministic nonce generation
- Malleability: canonical **low-S** normalization enforced at signing time;
  a verifier using `@noble/secp256k1` v3 gets this rejection for free since
  it defaults to strict/low-S verification
- Encoding: compact 64-byte `r‖s`, big-endian, hex-encoded (not DER —
  `@noble/secp256k1` v3 dropped DER support)
- Public key encoding: uncompressed SEC1, hex (`"04" + X(32B) + Y(32B)`)

A verifier MUST treat a missing signature or missing public key as a hard
failure, never a skip (see error codes PIF-006/PIF-007 below).

## 5. IPFS retrieval

The CID (or a gateway URL containing one) is resolved via an HTTP GET to an
IPFS gateway (e.g. `https://dweb.link/ipfs/<cid>`). **This is content
addressing, not identity verification** — a successful fetch does not by
itself recompute the IPFS multihash from the retrieved bytes to confirm they
match the CID, and a verifier should say so (see Update 33/34 in the
architectural spec this document implements part of).

## 6. Blockchain lookup

`GenesisRegistryV2.verifyProof(bytes32 evidenceHash)` is called read-only
against the RPC endpoint and contract address the user supplies — never
inferred — and returns:

```solidity
(bool isValid, string ipfsCID, string proofType, uint256 timestamp,
 uint256 expiresAt, address issuer, uint8 status)
```

`status` is one of `NonExistent(0) / Active(1) / Revoked(2) / Expired(3)`.
`Expired` is derived on-chain from `expiresAt < block.timestamp` and is
never stored — a revoked-then-expired record still reads `Revoked`, since
revocation is permanent and checked first.

## 7. Lifecycle interpretation

- `expires_at: null` means **NO EXPIRATION DECLARED**, not "permanently
  valid."
- Revocation does not erase history: a verifier should be able to show
  "this proof existed and was anchored, and was later revoked" rather than
  silently reporting as if the anchor never happened.

## 8. Verification state machine

A verifier MUST NOT collapse verification into a single Boolean until every
dimension below has been independently evaluated. States are drawn from
`{PASS, FAIL, WARN, SKIPPED, UNCONFIRMED, NOT_APPLICABLE}`, plus the
lifecycle dimension's own on-chain status name.

| Dimension | Meaning |
|---|---|
| `manifest` | the manifest bytes were retrieved |
| `schema` | required top-level fields are present |
| `canonicalization` | JCS canonicalization of `payload` succeeded |
| `digest` | recomputed digest matches the manifest's declared digest |
| `signature` | ECDSA signature validates against the declared digest and public key |
| `signer_key` | a public key is present to check the signature against |
| `provenance` | UNCONFIRMED when the payload names an external provider (e.g. IBM Quantum) this verifier cannot independently query; NOT_APPLICABLE otherwise |
| `ipfs` | retrieval succeeded (see caveat in section 5) |
| `blockchain` | SKIPPED if no RPC/contract supplied, else PASS/FAIL against `verifyProof` |
| `lifecycle` | `UNKNOWN` / `ACTIVE` / `REVOKED` / `EXPIRED` / `NonExistent` |
| `domain_evidence` | the payload contains the proof-type's required domain fields |

`verified: true` requires `digest`, `signature`, and `signer_key` to all be
`PASS`, and — if a chain check was configured — `blockchain` to also be
`PASS`. A `DEMO_ONLY` manifest can never reach `verified: true` regardless
of how cleanly every other dimension passes.

### Evidence levels

Independent of the per-dimension checks, a verifier MAY report an evidence
level describing verification **depth**, never certainty of the underlying
claim:

```
0  CLAIM ONLY
1  CAPTURED EVIDENCE           (manifest retrieved + well-formed)
2  CRYPTOGRAPHICALLY INTEGRITY VERIFIED   (digest matches)
3  CRYPTOGRAPHICALLY AUTHENTICATED        (+ signature valid)
4  EXTERNALLY ANCHORED                    (+ on-chain record active)
5  DOMAIN-PROVENANCE VERIFIED             (+ independently confirmed provider)
6  MULTI-SOURCE CORROBORATED              (+ multiple independent sources)
```

This repository's verifier computes levels 0–4. Levels 5–6 require
independent provider confirmation and multi-source corroboration that are
not implemented here, and the verifier never claims them.

## 9. Error codes

| Code | Meaning |
|---|---|
| PIF-001 | Manifest retrieval failed |
| PIF-002 | Malformed manifest (missing payload/digest/signature) |
| PIF-003 | Schema invalid (e.g. unsupported signature scheme) |
| PIF-004 | Canonicalization failed |
| PIF-005 | Digest mismatch |
| PIF-006 | Signature missing |
| PIF-007 | Public key missing |
| PIF-008 | Signature invalid |
| PIF-009 | CID mismatch (content retrieved does not match requested CID) |
| PIF-010 | Chain query failed / no on-chain record found |
| PIF-011 | Chain hash mismatch |
| PIF-012 | Chain CID mismatch (on-chain CID differs from the manifest's) |
| PIF-013 | Proof type mismatch (on-chain `proofType` differs from manifest's) |
| PIF-014 | Proof revoked |
| PIF-015 | Proof expired |
| PIF-016 | Unsupported protocol version |
| PIF-017 | Provider provenance unconfirmed |
| PIF-018 | Demo-only record (can never be VERIFIED) |

## 10. No silent downgrades

If a required capability is unavailable, the verifier must say exactly
that, not report success:

- No secp256k1 verifier available → `SIGNATURE COULD NOT BE VERIFIED`, not `VERIFIED`.
- RPC unreachable → `BLOCKCHAIN ANCHOR COULD NOT BE INDEPENDENTLY CHECKED`, not `BLOCKCHAIN VERIFIED`.
- No independent provider confirmation → `PROVIDER PROVENANCE UNCONFIRMED`, not `EXECUTION VERIFIED`.
- Unsupported `manifest_version` → fail closed immediately; do not attempt
  best-effort checks against an unknown schema.

## 11. Demo records

A manifest with `mode: "DEMO"` or `verification_status: "DEMO_ONLY"` is
cryptographically real (genuinely hashed and signed, genuinely verifiable)
but must never be reported as `VERIFIED` in production, however cleanly its
checks pass. Report it as `DEMO_ONLY` — its own category, not a pass or a
fail.

## 12. Test vectors

Cross-language determinism (`jcs` + Python `ecdsa` producing byte-identical
output to `canonicalize` + `@noble/secp256k1`) is exercised in
`tests/test_proof_engine.py`. There is no separate static test-vector file
in this repository yet; `test_proof_engine.py`'s assertions are the current
source of truth for expected digest/signature values given a fixed payload
and key.
