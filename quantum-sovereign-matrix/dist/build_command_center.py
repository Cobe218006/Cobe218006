import base64, html, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def read(p):
    with open(os.path.join(ROOT, p), "r", encoding="utf-8") as f:
        return f.read()

def b64(s):
    return base64.b64encode(s.encode("utf-8")).decode("ascii")

def read_binary_b64(p):
    with open(os.path.join(ROOT, p), "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")

master_html = read("master.html")
verify_html = read("enterprise/public/verify.html")
logo_512_b64 = read_binary_b64("assets/logo-512.webp")

code_files = [
    ("contract", "enterprise/contracts/GenesisRegistryV2.sol", "contracts/GenesisRegistryV2.sol"),
    ("engine", "enterprise/backend/proof_engine.py", "backend/proof_engine.py"),
    ("api", "enterprise/backend/api.py", "backend/api.py"),
    ("pinning", "enterprise/backend/pinning.py", "backend/pinning.py"),
    ("requirements", "enterprise/requirements.txt", "requirements.txt"),
    ("envexample", "enterprise/.env.example", ".env.example"),
    ("tests_engine", "enterprise/tests/test_proof_engine.py", "tests/test_proof_engine.py"),
    ("tests_api", "enterprise/tests/test_api.py", "tests/test_api.py"),
    ("qiskit_script", "qiskit_ghz.py", "qiskit_ghz.py (base iPhone flow)"),
]

code_blocks = []
code_tab_buttons = []
for key, path, label in code_files:
    content = read(path)
    code_blocks.append((key, label, content))

html_out = []
html_out.append("""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0a08">
<title>Quantum Sovereign Matrix — Command Center</title>
<style>
  :root { --bg:#0a0a12; --panel:#12121f; --border:#22223a; --gold:#d4a853; --gold-hi:#f3d68a; --text:#e6e6f0; --muted:#7a7a95; --green:#4ade80; --red:#f87171; }
  * { box-sizing:border-box; }
  html,body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;
    padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
  .container { max-width:900px; margin:0 auto; padding:0 16px 24px; }
  header { text-align:center; padding:20px 0 14px; border-bottom:1px solid var(--border); }
  h1 { font-size:18px; letter-spacing:1.5px; color:var(--gold); font-weight:700; text-transform:uppercase; margin:0; }
  .sub { font-size:10px; color:var(--muted); letter-spacing:1.5px; text-transform:uppercase; margin-top:6px; }
  nav.tabs { display:flex; overflow-x:auto; gap:6px; padding:12px 0; -webkit-overflow-scrolling:touch; position:sticky; top:0; background:var(--bg); z-index:10; }
  nav.tabs::-webkit-scrollbar { display:none; }
  nav.tabs button { flex-shrink:0; background:transparent; border:1px solid var(--border); color:var(--muted); padding:8px 14px;
    border-radius:20px; font-size:11px; font-weight:600; letter-spacing:.5px; text-transform:uppercase; cursor:pointer; font-family:inherit; }
  nav.tabs button.active { background:rgba(212,168,83,.15); border-color:var(--gold); color:var(--gold-hi); }
  .panel { display:none; }
  .panel.active { display:block; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:14px; }
  .card h2 { font-size:12px; color:var(--gold-hi); letter-spacing:1px; text-transform:uppercase; margin:0 0 10px; padding-bottom:8px; border-bottom:1px solid var(--border); }
  .card p { font-size:12px; color:var(--muted); line-height:1.6; margin:0 0 8px; }
  .code-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap; }
  .code-header span { font:12px ui-monospace,"SF Mono",Menlo,monospace; color:var(--gold); font-weight:600; word-break:break-all; }
  .copy-btn { background:#1a1a2e; border:1px solid var(--border); color:var(--gold-hi); padding:6px 12px; border-radius:6px;
    font-size:10px; font-weight:700; cursor:pointer; letter-spacing:.5px; text-transform:uppercase; flex-shrink:0; }
  .copy-btn.copied { background:#166534; color:#dcfce7; border-color:#22c55e; }
  pre.code { background:#05050a; border:1px solid var(--border); border-radius:8px; padding:12px; overflow-x:auto;
    font:11px/1.55 ui-monospace,"SF Mono",Menlo,monospace; color:#d0d0e0; white-space:pre; max-height:420px; -webkit-overflow-scrolling:touch; margin:0; }
  .iframe-wrap { border:1px solid var(--border); border-radius:12px; overflow:hidden; background:#000; }
  iframe { width:100%; height:80vh; border:0; display:block; background:#0b0a08; }
  .doc h3 { color:var(--gold-hi); font-size:13px; margin:16px 0 8px; }
  .doc h4 { color:var(--gold); font-size:11px; margin:14px 0 6px; text-transform:uppercase; letter-spacing:1px; }
  .doc p, .doc li { font-size:12px; color:var(--text); margin-bottom:6px; line-height:1.6; }
  .doc ul, .doc ol { padding-left:20px; margin-bottom:10px; }
  .doc code { background:#08080f; padding:2px 6px; border-radius:3px; font:11px ui-monospace,monospace; color:var(--gold-hi); }
  .callout { background:rgba(251,191,36,.08); border-left:3px solid #fbbf24; padding:10px 12px; border-radius:6px; margin:10px 0; font-size:11px; }
  .callout-red { background:rgba(248,113,113,.08); border-left-color:var(--red); }
  footer { text-align:center; padding:20px 0 8px; font-size:9px; color:var(--muted); letter-spacing:1px; text-transform:uppercase; border-top:1px solid var(--border); margin-top:20px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <img id="wrapperLogo" style="display:block;width:72px;height:72px;margin:0 auto 10px;border-radius:50%;box-shadow:0 2px 10px rgba(0,0,0,.5);" alt="Battleborn Vegas Corporate Curators" width="72" height="72">
    <h1>Quantum Sovereign Matrix</h1>
    <div class="sub">Command Center &middot; built from this repo's tested source, not retyped</div>
  </header>

  <nav class="tabs">
    <button data-tab="about" class="active">Read Me</button>
    <button data-tab="command">Command</button>
    <button data-tab="verify">Verify</button>
    <button data-tab="contract">Contract</button>
    <button data-tab="backend">Backend</button>
    <button data-tab="tests">Tests</button>
    <button data-tab="deploy">Deploy</button>
  </nav>

  <div class="panel active" id="panel-about">
    <div class="card doc">
      <h3>What this file is</h3>
      <p>A single-file distribution of the Quantum Sovereign Matrix / Proof Infrastructure Engine. The <strong>Command</strong>
      and <strong>Verify</strong> tabs embed the actual, tested <code>master.html</code> and <code>verify.html</code> pages from
      this repo directly (as iframes) — not reimplemented or retyped, so there is no drift between what you see here and what
      was actually tested. The <strong>Contract</strong>, <strong>Backend</strong>, and <strong>Tests</strong> tabs embed the
      real source files with copy buttons. <strong>Deploy</strong> condenses the setup steps.</p>
      <h4>What changed from an earlier draft</h4>
      <p>This file intentionally does NOT use: ECDSA P-256 for signing (this protocol uses secp256k1, consistently, everywhere
      — WebCrypto cannot do secp256k1 natively, which is why P-256 kept creeping back in; the fix is a small bundled library,
      not a weaker curve), a sorted-keys-only "RFC 8785" (the real implementation is used), or signing a digest's hex text
      instead of its bytes. It also does not include any "divinity assessment" content based on sovereign-citizen-style
      claims (allodial title, dissolving "corporate fictions", and similar) — those pseudo-legal theories have caused real
      people real harm (lost property, failed court cases, jail time) when relied on, and this tool will not treat answers to
      them as meaningful evidence to cryptographically sign and anchor. The neutral stewardship/custody assessment already in
      <code>master.html</code> is used instead.</p>
    </div>
  </div>

  <div class="panel" id="panel-command">
    <div class="card">
      <h2>Master Control Center (live, embedded)</h2>
      <p>This is the real <code>master.html</code> from the repo, running inside this page. Wallet connect only works inside a
      wallet app's built-in browser (e.g. MetaMask Mobile) — a plain iframe in Safari cannot inject <code>window.ethereum</code>.
      For the wallet step, open <code>master.html</code> directly rather than through this wrapper.</p>
    </div>
    <div class="iframe-wrap"><iframe id="masterFrame" title="Master Control Center"></iframe></div>
  </div>

  <div class="panel" id="panel-verify">
    <div class="card">
      <h2>Zero-Trust Verifier (live, embedded)</h2>
      <p>The real <code>verify.html</code> from the repo. Paste a manifest CID or URL, optionally an RPC + contract address, and
      run it — the checks are genuinely performed in your browser.</p>
    </div>
    <div class="iframe-wrap"><iframe id="verifyFrame" title="Zero-Trust Verifier"></iframe></div>
  </div>

  <div class="panel" id="panel-contract">
    <div class="card">
      <p>The enterprise registry contract (secp256k1-agnostic — any hash can be anchored). Compiles clean under solc 0.8.26.
      The simpler base-flow contract (<code>contracts/GenesisRegistry.sol</code>, different ABI) isn't duplicated here — see
      the repo.</p>
    </div>
  </div>

  <div class="panel" id="panel-backend"></div>
  <div class="panel" id="panel-tests"></div>

  <div class="panel" id="panel-deploy">
    <div class="card doc" id="deployDoc"></div>
  </div>

  <footer>Verifiable &middot; signed &middot; anchored &middot; nothing claimed beyond what was tested</footer>
</div>

<script>
(function(){
  "use strict";
  const tabs = document.querySelectorAll('nav.tabs button');
  tabs.forEach(btn => btn.addEventListener('click', () => {
    tabs.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  }));

  function b64dec(b64) { return decodeURIComponent(escape(atob(b64))); }

  // Embedded pages, as base64 to avoid any srcdoc-escaping issues.
""")

html_out.append(f'  document.getElementById("masterFrame").srcdoc = b64dec("{b64(master_html)}");\n')
html_out.append(f'  document.getElementById("verifyFrame").srcdoc = b64dec("{b64(verify_html)}");\n')
html_out.append(f'  document.getElementById("wrapperLogo").src = "data:image/webp;base64,{logo_512_b64}";\n')

html_out.append("""
  // Embedded source files, base64-encoded so copy-to-clipboard restores the
  // exact original bytes regardless of how the browser normalizes HTML text.
  const FILES = [
""")
for key, path, label in code_files:
    content = read(path)
    html_out.append(f'    {{ key: {json.dumps(key)}, label: {json.dumps(label)}, b64: "{b64(content)}" }},\n')
html_out.append("""  ];

  function renderCodeBlock(file) {
    const wrap = document.createElement("div");
    wrap.className = "card";
    const header = document.createElement("div");
    header.className = "code-header";
    const span = document.createElement("span");
    span.textContent = file.label;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      const text = b64dec(file.b64);
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied"; btn.classList.add("copied");
      } catch (_) {
        btn.textContent = "Copy failed — select manually";
      }
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
    });
    header.append(span, btn);
    const pre = document.createElement("pre");
    pre.className = "code";
    pre.textContent = b64dec(file.b64);
    wrap.append(header, pre);
    return wrap;
  }

  const backendPanel = document.getElementById("panel-backend");
  const contractPanel = document.getElementById("panel-contract");
  const testsPanel = document.getElementById("panel-tests");

  for (const f of FILES) {
    const target = f.key === "contract" ? contractPanel
      : f.key.startsWith("tests") ? testsPanel
      : backendPanel;
    target.appendChild(renderCodeBlock(f));
  }
""")

# Deploy tab content (condensed, accurate to what's actually built)
deploy_html = """
      <h3>Two ways to deploy this</h3>
      <p>This project has two independent paths — pick one, don't mix their contracts/keys:</p>
      <ul>
        <li><strong>Base (free, no backend)</strong>: <code>master.html</code> + <code>qiskit_ghz.py</code> run in Colab + Pinata +
        <code>contracts/GenesisRegistry.sol</code>. Full steps: <code>DEPLOYMENT.md</code> in the repo root.</li>
        <li><strong>Enterprise (your own backend)</strong>: FastAPI (<code>backend/api.py</code>) + web3.py +
        <code>contracts/GenesisRegistryV2.sol</code>. Steps below.</li>
      </ul>

      <h4>Enterprise path</h4>
      <ol>
        <li><strong>IBM Quantum token</strong> — quantum.cloud.ibm.com, free Open Plan, copy your API key. Never paste it into a
        chat; it goes in your backend's environment only.</li>
        <li><strong>Signing key</strong> — generate a secp256k1 key once:
<pre class="code">from ecdsa import SigningKey, SECP256k1
open("key.pem","wb").write(SigningKey.generate(curve=SECP256k1).to_pem())</pre>
        Keep <code>key.pem</code> out of git. Its contents become <code>ECDSA_PRIVATE_KEY_PEM</code>.</li>
        <li><strong>Install &amp; run the backend</strong>:
<pre class="code">cd enterprise
pip install -r requirements.txt
cp .env.example .env   # fill in real values, never commit this file
uvicorn backend.api:app --reload</pre>
        Confirm it's alive: <code>curl -X POST localhost:8000/api/quantum/execute</code> should return a structured
        <code>{"ok":false,...}</code> error if <code>IBM_QUANTUM_TOKEN</code> isn't set yet — that's the fail-closed behavior
        working correctly, not a bug.</li>
        <li><strong>Pinata</strong> — api.pinata.cloud, create a JWT, set <code>PINATA_JWT</code>. Free tier is enough.</li>
        <li><strong>Deploy the contract</strong> — open <code>contracts/GenesisRegistryV2.sol</code> in Remix (inside MetaMask
        Mobile's browser works on iPhone), compile with solc 0.8.24+, deploy to Sepolia (free, via a faucet) to start. Save the
        deployed address.</li>
        <li><strong>Host the backend</strong> somewhere that runs a long-lived Python process (Railway, Render, Fly.io all have
        free tiers that work with a plain <code>uvicorn</code> app) — set the same env vars there.</li>
        <li><strong>Wire up the frontend</strong> — <code>frontend/src/App.jsx</code> is a reference component, not a standalone
        app; drop it into a Vite/CRA/Next project with <code>ethers</code> installed, point it at your backend URL and deployed
        contract address.</li>
        <li><strong>Verify</strong> — open the Verify tab here (or <code>enterprise/public/verify.html</code> directly), paste
        your manifest's CID, your RPC URL, and your contract address.</li>
      </ol>

      <div class="callout callout-red">Never paste a real IBM token, a Pinata JWT, a private key, or a wallet seed phrase into
      this page, this repo, or any AI chat. They belong only in your own environment/secret manager.</div>

      <div class="callout">Full details, "what you'll see" walkthroughs, and the zero-cost base-flow steps are in
      <code>DEPLOYMENT.md</code> and <code>enterprise/README.md</code> in the repo — this tab is a condensed index, not a
      replacement for them.</div>
"""
html_out.append(f'  document.getElementById("deployDoc").innerHTML = {json.dumps(deploy_html)};\n')

html_out.append("""})();
</script>
</body>
</html>
""")

out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "quantum-sovereign-matrix.html")
with open(out_path, "w", encoding="utf-8") as f:
    f.write("".join(html_out))
print("wrote", out_path, os.path.getsize(out_path), "bytes")
