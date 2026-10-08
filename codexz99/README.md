# Codexz 99

Anchor evidence, issue entitlement credentials (purchases, ownership, access),
and verify them independently — demonstrating how credentials from a verified
source (IBM Quantum execution, a quantum-anchored proof, or any other
independently-confirmed attestation) can be turned into something a holder
can actually *spend, prove ownership with, or use to access something*.

## Why this exists

This started from a bug report ("tabs don't work") plus a question: how can
IBM- or quantum-verified VCs be used to create purchases, claims, or
ownership? The answer here is the `Claims` tab: a Verifiable Credential whose
subject is a **right** ("holder may spend $X at Y", "holder owns N% of
asset Z", "holder may access service W") rather than a fact about a person.
The credential *is* the entitlement. Present it, and a verifier checks it
offline; redeem it, and that consumption is anchored so it can't be spent
twice.

## Run it

```bash
npm install
npm run dev
```

Local mode (default) needs nothing further — a throwaway secp256k1 key is
generated once and kept in this browser's `localStorage` so claims can be
genuinely signed and verified end to end, with no wallet extension or real
chain required. **This key is not for real funds.**

For chain mode (a real wallet via `window.ethereum`, a real Registry.sol
anchor), copy `.env.example` to `.env.local` and fill in `VITE_MODE=chain`,
`VITE_RPC_URL`, and `VITE_CONTRACT_ADDRESS` (see `contracts/Registry.sol` —
deploy it yourself; this repo doesn't do that for you).

## What's real

- **Signing**: real ECDSA (secp256k1, via ethers) and, when `issue a claim`
  runs, a genuine hybrid signature also covering ML-DSA-65 (`@noble/post-
  quantum`, NIST FIPS 204) — not a placeholder. Verification recomputes the
  signature check against the embedded public key; it never trusts a flag
  in the file.
- **Canonicalization**: RFC 8785 (JCS) via the `canonicalize` package, the
  same real implementation used elsewhere in this account's proof-
  infrastructure work — not sorted-key `JSON.stringify`.
- **Anchoring**: a real SHA-256 hash committed to either `localStorage`
  (local mode) or a real `Registry.sol` contract (chain mode) — see
  `contracts/Registry.sol`.
- **Redemption**: consuming a claim anchors an independent redemption
  marker (`sha256("redemption-marker:" + claimId)`) that a verifier checks
  via the vault — not a field inside the signed JSON, which can never
  change after signing without invalidating its own signature. Confirmed
  by test: presenting the same claim file a second time after redemption
  is correctly rejected.
- **Trust Score**: a transparent, from-scratch-computed number (see
  `src/lib/trust.ts`) gating `Market` and `Claims` behind real evidence —
  credentials actually held, proofs actually anchored, an identity
  statement actually sealed. No hidden weights.

## What's explicitly a mockup or limitation — read this before trusting it

- **Market's "Apply" flow is a mockup.** The listed lenders (Aave, Maple
  Finance, Compound, Goldfinch, Centrifuge) are real protocols, named for
  reference. Clicking "Apply" does **not** contact any of them — it anchors
  a local record and says so on-screen. There is no real integration with
  any named company here.
- **Certify is self-graded.** The quizzes are not reviewed by a human, IBM,
  or any third party. They demonstrate the credential pattern
  (assess → sign → anchor → present), not verified expertise. A real
  deployment would plug a genuine review process in at that exact point.
- **Holder binding is not implemented.** Presenting a claim's JSON file
  currently proves nothing about whether the presenter controls the
  private key named as its holder — a copied file is as good as the
  "real" credential to whoever has it. The fix (challenge-response: the
  verifier issues a nonce, the presenter signs it fresh) is a known,
  scoped piece of work, not done here. Every `Claims` screen says this.
  This is the single most important gap to close before this pattern
  handles anything of real value.
- **Local-mode signing key** lives in `localStorage` as a convenience so
  the demo flow produces genuinely verifiable signatures without a wallet
  extension. It is not protected the way a real wallet protects a key —
  never fund it, never treat it as anything but disposable.
- **"Trust Score" was renamed from "Divinity Score"** in an earlier draft
  of this spec. The scoring mechanic (transparent factors, actionable
  gaps, a real pass threshold) is kept; the quasi-religious branding on a
  numeric gate for financial/credential access was dropped as inappropriate
  for what this actually is.

## Files

```
contracts/Registry.sol     minimal anchor/revoke/lookup contract (chain mode)
src/lib/crypto.ts          SHA-256, file download helper
src/lib/vc.ts              did:pkh helper
src/lib/store.ts           the Vault abstraction (local vs chain mode)
src/lib/pq.ts              hybrid ECDSA + ML-DSA signing/verification
src/lib/claims.ts          entitlement credential issue/verify/redeem
src/lib/credentials.ts     local index of credentials held
src/lib/trust.ts           the Trust Score engine
src/components/            ErrorBoundary, Shell, Proofs, Identity, Certify,
                            Market, Claims, TrustContext, TrustGate
```

## Tested

- Headless-browser regression: all 6 tabs render with zero JS errors,
  including with the exact misconfiguration that caused the original "tabs
  don't work" bug (`VITE_MODE=chain` + empty `VITE_CONTRACT_ADDRESS`) —
  `getVault()` now falls back to local mode instead of throwing in the App
  body, and `ErrorBoundary` is the backstop for any other render-time error.
- Full claims loop: issue a hybrid-signed purchase claim (confirmed real
  ML-DSA signature present) → present it (accepted) → redeem it (anchored)
  → present the same file again (correctly rejected as already redeemed).
- Trust Score: verified the score is actually reachable (86/100 via
  identity + 3 domain-diverse credentials + evidence + a real post-quantum
  signature) — an earlier version of the scoring formula could
  mathematically never reach the 81 threshold using only the pre-Claims
  modules, which would have permanently locked out `Market`/`Claims`. Fixed
  before commit.
