# Single-file distribution

`quantum-sovereign-matrix.html` bundles the whole project into one file you
can upload to Pinata/IPFS and open on an iPhone: it **embeds the real,
tested `master.html` and `verify.html` directly** (via `iframe.srcdoc`, not
retyped — so there is no drift between what you see here and what was
actually tested), plus the real source files (`GenesisRegistryV2.sol`,
`backend/*.py`, `tests/*.py`, `requirements.txt`, `.env.example`) as
copy-button code blocks, and a condensed Deploy tab.

**Why `srcdoc`, not a `data:` URI**: an iframe loaded from a `data:` URI gets
an opaque origin and **`crypto.subtle` is unavailable inside it** — which
would silently break every signing/hashing/verification feature in both
embedded pages. `srcdoc` (set as a JS property, not an HTML attribute
string) inherits a secure context from the parent page instead. Confirmed
with a real headless-browser check of `window.isSecureContext` and
`crypto.subtle` inside both iframes before and after the fix — the `data:`
URI version looked fine visually but was completely non-functional for its
actual purpose.

Regenerate after changing `master.html`, `enterprise/public/verify.html`, or
any of the embedded source files:

```
python3 dist/build_command_center.py
```

Tested (real headless browser runs, not just inspection):
- Both embedded pages load with `crypto.subtle` available and
  `isSecureContext: true`.
- `master.html`'s hash/key-generation/manifest-download tools work inside
  the embed exactly as they do standalone.
- `verify.html` correctly reports `IPFS RETRIEVAL FAILED` for a bad URL and
  `✓ VERIFIED` (digest match + signature valid) for a real manifest built by
  the embedded `master.html` in the same run — the full producer→verifier
  loop closes correctly inside this single file.
- All code-tab copy buttons restore the exact original file bytes (base64
  round-tripped, not HTML-entity-decoded text).

Not changed from the rest of the repo: this file doesn't alter the protocol
(still secp256k1 everywhere, real RFC 8785, signs digest bytes, compact
low-S signatures) and doesn't add the sovereign-citizen-style "divinity
assessment" content from an earlier draft — see the file's own "Read Me" tab
for why.
