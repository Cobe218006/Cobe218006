# Codexz 99 / Quantum Sovereign Matrix — Architecture

This is the single repo. "Codexz 99" names the overall system described
below; `quantum-sovereign-matrix/` is its only codebase — there is no
separate app of that name. (A different, standalone Vite/TypeScript
project at `codexz99/` in this same repo was an earlier, deliberately
separate experiment — entitlement credentials, a local trust score — and
is unrelated to this architecture.)

## What "Quantum Sovereignty" means here

A technical framework for user-controlled identity, evidence, credentials,
claims, governance, and cryptographically verifiable records. "Sovereignty"
describes the system's design objective — control, portability,
self-custody, independent verification — not a claim that the application
grants anyone legal sovereignty. A quantum execution produces **quantum
evidence, verified**; it does not prove anyone's "sovereign status." Keep
that distinction explicit everywhere this system reports a result.

## Layers, and where each one actually lives

```
QUANTUM LAB ─┐
             ├─▶ PROOF VAULT / EVIDENCE ─┐
IDENTITY ────┘                          ├─▶ CLAIM ENGINE ─▶ COVENANT ENGINE ─▶ (DAO / GOVERNANCE — not built)
                                         │
                                SMART CONTRACTS ─▶ (SOURCIFY — not built) ─▶ EVM ANCHOR / PROOF
```

| Layer | Status | Where |
|---|---|---|
| Quantum Lab (IBM Qiskit, GHZ-5) | **Built** | `enterprise/backend/proof_engine.py::execute_ghz5_circuit` |
| Evidence/Proof Vault (JCS, SHA-256, signatures, IPFS) | **Built** | `proof_engine.py`, `backend/pinning.py` |
| Identity — wallet | **Built** | `master.html` "Sovereign Wallet" |
| Identity — signing key | **Built** | `master.html` "Signing Key" (secp256k1) |
| Identity — SSO claim | **Built**, explicitly unverified client-side | `master.html` "Sign In", `backend/api.py` `/api/auth/google` |
| Identity — DID (did:pkh) | **Built this pass** | `master.html::didPkh`, `proof_engine.py::did_pkh` |
| Claim Engine (IDENTITY/OWNERSHIP/AUTHORIZATION claims) | **Built this pass** | `proof_engine.py::validate_claims`, `CLAIM_TYPES`, `CLAIM_INTERPRETATIONS` |
| Covenant Engine (signed, versioned principles) | **Built this pass** | `master.html` "Covenant" section |
| Smart contracts (anchor/revoke/lookup) | **Built** | `enterprise/contracts/GenesisRegistryV2.sol` |
| DAO / Governor / Treasury | **Not built** | — |
| Multisig issuance | **Not built** | — |
| Sourcify (contract source/runtime verification) | **Not built** | — |
| Governance tab (Identity/Authority/DAO/Covenants UI) | **Not built** | — |
| Verification centerpiece (DID/CID/tx/contract → one reconstructed trace) | **Partially built** — see below | `enterprise/public/verify.html` |

## DID

`did:pkh:eip155:<chainId>:<address>` — CAIP-10, no registry or resolver
needed. Tied to the **connected wallet** (the account that would anchor
on-chain, i.e. `msg.sender` in `GenesisRegistryV2`), deliberately separate
from `signature.public_key` (the signing key) and `identity_claims` (the
SSO claim). None of the three proves the others — see the three-way
identity separation principle already documented in `enterprise/README.md`.

## Claim Engine

A payload may carry an optional `claims` array. Each claim separates
**what** is asserted (`claim_type`: `IDENTITY` | `OWNERSHIP` |
`AUTHORIZATION`) from **how** it was arrived at (`interpretation`:
`OBSERVED` | `CALCULATED` | `SIGNED` | `ANCHORED` | `PROVIDER_REPORTED` |
`INFERRED` | `INTERPRETED` | `UNVERIFIED`). Validated before signing,
fails closed on an invented `claim_type`/`interpretation` or a duplicate
`claim_id` (`proof_engine.py::validate_claims`, tested in
`tests/test_proof_engine.py`). A manifest's signature validates the
*integrity and authenticity of the record* — it does not by itself
validate the *truth* of any claim inside it. This is deliberately the
same principle the v5.0 architectural update (see
`enterprise/README.md`) laid out and left as backlog; it's real now.

## Covenant Engine

A versioned, signed policy document: `{version, principles, did,
signer_public_key, sealed_at}`, canonicalized (JCS) and signed exactly
like a manifest, reusing the same signing key — see `master.html`'s
"Covenant" section. It is explicitly **not** identity or legal status:
sealing a covenant proves the holder of a specific key authored specific
text at a specific time, nothing about who that holder is or whether the
covenant is enforceable anywhere. It anchors the same way a manifest does
— manually, via the existing "hash to anchor" flow, with
`proofType: "COVENANT"` — no new on-chain mechanism was added.

**Built with the technical framing from the current architecture
discussion (principles / rules / versions / hashes / contract bindings),
not extended from `master.html`'s existing `CONFIG.evidence` placeholder
entries** ("Covenant HTML," "Ecclesiastical Decree," "Book of the
Ladderborn Dominion," "Affidavit of Covenant") or the "Divinity
Assessment" self-scoring section (threshold 81, weighted
Truth/Custody/Covenant/Stewardship/Service questions). Those predate this
architecture work, are explicitly marked as a user-editable template
("EDIT THIS BLOCK, THEN UPLOAD THE FILE TO PINATA"), and were left
untouched rather than silently reworded — but they use the same pattern
(a numeric self-assessment threshold, mystical/pseudo-legal document
titles) that was deliberately declined and renamed when it showed up in
the `codexz99/` project this session ("Divinity Score" → "Trust Score").
Worth a conscious decision on whether to revise them, not a silent one.

## Verification status vocabulary

The target vocabulary is `VERIFIED | UNVERIFIED | REVOKED | EXPIRED |
DISPUTED | UNKNOWN`. The existing verifier (`verify.html`) already
implements most of this under different names — it's a renaming/mapping
exercise, not new logic:

| Target | Existing equivalent |
|---|---|
| `VERIFIED` | `checks` all `PASS`, `verified: true` |
| `UNVERIFIED` | `checks.signature` or `checks.digest` = `FAIL` |
| `REVOKED` | `checks.lifecycle` = `Revoked` |
| `EXPIRED` | `checks.lifecycle` = `Expired` |
| `UNKNOWN` | `checks.lifecycle` = `UNKNOWN` (no chain check configured), or `checks.provenance` = `UNCONFIRMED` |
| `DISPUTED` | **not represented** — would need a mechanism for a third party to contest a claim without revoking it; not designed yet |

Not remapped this pass — the existing granular `checks` object (from the
v5.0 update) is more informative than collapsing to one of six labels,
and the "Verification centerpiece" (enter a DID/credential/CID/tx/contract
address, get one reconstructed trace through Identity → Evidence →
Credential → Claim → Authority → Policy → Contract → Transaction → Proof)
is a real UI/aggregation project of its own — it needs a backend endpoint
that can look up each entity type, not just the file-by-file checks
`verify.html` does today.

## Deliberately not built this pass, and why

- **DAO / Governor / Treasury / Multisig issuance.** Each is a real
  Solidity undertaking (OpenZeppelin `Governor` + `TimelockController`,
  or a Safe multisig, with its own deployment, testing, and audit
  surface) — not something to stub convincingly. Building a fake-looking
  DAO would be exactly the kind of fabricated-authority problem this
  whole protocol has been built to avoid (see "NEVER MANUFACTURE PROOF"
  in the v5.0 spec already adopted in `enterprise/README.md`).
- **Sourcify integration.** Real contract verification needs a live
  call to Sourcify's API after a real deployment — nothing to build
  usefully before `GenesisRegistryV2` is actually deployed somewhere
  Sourcify can reach.
- **Governance tab UI.** Depends on the above existing for real; a tab
  that lists DAO membership/proposals/voting with no DAO behind it would
  be decorative.

Suggested order, each a real, scoped piece:
1. Deploy `GenesisRegistryV2` to a public testnet (this was already the
   "going live" plan from earlier this session) → verify it on Sourcify
   for real.
2. Multisig issuance: swap the single `DEPLOYER_PRIVATE_KEY` signer for
   a Safe, so `anchorProof` calls require M-of-N approval.
3. A minimal `Governor` + `TimelockController` pair gated on holding an
   `AUTHORIZATION` claim (built this pass) from a recognized issuer —
   this is where "Authority registry" and "Recognition" in the
   Governance diagram become real contract state instead of UI copy.
4. The Verification centerpiece, once there's a real DAO/Governor to
   look up — otherwise it has nothing to show for those branches.
