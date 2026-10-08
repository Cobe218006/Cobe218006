# Deployment Protocol: Quantum Sovereign Matrix (iPhone)

Each step lists **DO** (what to tap or type), **WHAT YOU SEE** (roughly what the
screen shows), and **COST** (whether you pay anything).

> Websites change their layouts often. If a button has moved or been renamed,
> look for the closest match. The steps themselves stay the same.

> 🔐 **Never** paste your MetaMask seed phrase, `Main Wallet.json`, or IBM API key
> into any AI chat, website form or file you upload. The only places your IBM key
> goes are the hidden prompt in Colab or Colab Secrets.

> ℹ️ `master.html`'s CONFIG block already has five real evidence CIDs filled in.
> Before relying on them, open each **Open (dweb.link)** link yourself and confirm
> it loads your actual file — CIDs were typed in by hand and have not been
> independently re-verified against the source files in this session.

---

## A note on third-party "quantum verification" tools

If you've seen suggestions to run this through extra tools like **QWARD**,
**QSimVerifier**, **QuantumD**, or **Skaden**: only **QWARD**
(`pip install qiskit-qward`) is a real, publicly installable package — it's a
Qiskit-ecosystem project for analyzing circuit/QPU execution quality, and you
can add it as an extra check before Step 6 if you want (`!pip install -q
qiskit-qward`, then inspect your transpiled circuit with it). **QSimVerifier**
exists only as a single academic paper with no public code found. **QuantumD**
and **Skaden** could not be confirmed to exist anywhere under those names.
Don't build a dependency on a tool you can't find the source of. This
protocol's own `quantum_hash.py` receipt check is the verification step that
matters — it doesn't need any of these.

---

## Files in this folder

| File | What it is |
|---|---|
| `qiskit_ghz.py` | Builds and runs the 5-qubit GHZ circuit on IBM Quantum, then prints the result and its SHA-256 hash |
| `quantum_hash.py` | Standalone SHA-256 hasher and receipt checker |
| `master.html` | The Master Control Center app (one self-contained file) |
| `Manifest_Sovereign.template.json` | The manifest structure (`master.html` generates the real one for you) |
| `contracts/GenesisRegistry.sol` | Reference registry contract, only needed if you don't already have yours deployed |

Getting the files onto your iPhone: open this repository on github.com in Safari,
tap a file, then tap **Raw**. For `.py` files, select all and copy the text. For
`master.html`, use Safari's Share button and choose **Save to Files**.

---

## Phase 1: IBM Quantum account

### Step 1. Create a free IBM Quantum account
- **DO:** In Safari, go to **https://quantum.cloud.ibm.com** and tap **Sign in**, then **Create an IBMid**. Enter your email, verify it with the code IBM sends you, and finish the form.
- **WHAT YOU SEE:** A dark IBM sign-in page, then a short form, then the IBM Quantum Platform dashboard with a welcome panel.
- **DO (if asked):** Create an **instance** and pick the **Open Plan**.
- **WHAT YOU SEE:** A list of plans. Open Plan shows $0.
- **COST:** $0. The Open Plan is free and gives a monthly allowance of QPU time (IBM lists 10 minutes per rolling 28-day window). IBM Cloud sometimes asks for a card to verify your identity. The Open Plan does not charge it, but read the screen before you confirm anything.

### Step 2. Generate your API key
- **DO:** On the dashboard, find the **API key** panel (on the home page or under your profile/account menu). Tap **Create** and give the key a name such as `matrix`.
- **WHAT YOU SEE:** A long string of letters and numbers with a **copy** icon. IBM shows it **only once**.
- **DO:** Tap copy, then paste the key into **Apple Passwords** or a locked note. Do not paste it into any chat.
- **COST:** $0.

---

## Phase 2: Run the quantum circuit (Google Colab)

> IBM Quantum Lab was retired, so use Google Colab. It runs in iPhone Safari.
> Tip: tap **aA → Request Desktop Website** in Safari's address bar for an easier layout.

### Step 3. Open a Colab notebook
- **DO:** Go to **https://colab.research.google.com**, sign in with a Google account, and tap **New notebook**.
- **WHAT YOU SEE:** A notebook named `Untitled0.ipynb` with one empty code cell and a round ▶ Play button on its left.
- **COST:** $0. The free tier is enough.

### Step 4. (Recommended) Store your key in Colab Secrets
- **DO:** Tap the **🔑 key icon** in the left sidebar, then **Add new secret**. Set Name to `IBM_QUANTUM_TOKEN`, paste your key as the Value, and turn **Notebook access** on.
- **WHAT YOU SEE:** One row in the secrets list with its toggle on.
- If you skip this step, the script asks for the key in a hidden box when it runs.
- **COST:** $0.

### Step 5. Install Qiskit
- **DO:** Paste this into the first cell and tap ▶:
  ```
  !pip install -q "qiskit>=2" qiskit-ibm-runtime
  ```
- **WHAT YOU SEE:** A spinner, then a few lines of install output after about 30–60 seconds. Ignore any "restart session" notice unless an import fails later.
- **COST:** $0.

### Step 6. Run the GHZ circuit
- **DO:** Tap **+ Code** to add a second cell. Paste the **entire** contents of `qiskit_ghz.py` and tap ▶.
- **WHAT YOU SEE (in order):**
  1. A text drawing of the circuit: an `H` on q_0, then a staircase of CNOTs (`■` joined to `X`) down to q_4, then `M` measurement boxes.
  2. `Paste your IBM Quantum API key (hidden)` appears only if you skipped Step 4. Paste the key and press return.
  3. `Authenticating to IBM Quantum ...`
  4. `Backend: ibm_xxxxx (127 qubits, N jobs queued)`. The name depends on which machine is least busy.
  5. `Job submitted. Job ID: d1...`. The cell keeps spinning while the job waits in the queue. **This can take anywhere from seconds to hours on the free plan.** Leave the tab open.
  6. When the job finishes, three blocks appear:
     - **QUANTUM OUTPUT**: one line such as `{"00000":0.4873,"00001":0.0098,...,"11111":0.4711}`
     - **QUANTUM VERIFICATION HASH**: 64 hex characters
     - **PASTE INTO Manifest_Sovereign.json**: a JSON block
- **What a good result looks like:** on real hardware, most of the probability sits on `00000` and `11111` (`GHZ population` is usually 80–95%). A few other bitstrings with small values are normal hardware noise. You will **not** get exactly `{"00000": 0.5, "11111": 0.5}`. An exact 50/50 split only happens on a simulator.
- **If something goes wrong:**
  - `IBM Quantum rejected the API key`: copy the key again. Keys from the old `quantum.ibm.com` site don't work.
  - `no IBM backend is available`: try again later.
  - A message about quota or usage: your free minutes for this window are spent. To test everything else, change the very last line of the cell from `    main()` to `    sys.argv.append("--simulate"); main()` (keep the 4 leading spaces). The run is then marked `hardware: false` and is **not** a quantum-hardware result.
- **COST:** $0. One 1024-shot GHZ job uses only a few seconds of your free QPU time.

### Step 7. Save your results
- **DO:** Press and hold the **QUANTUM OUTPUT** line, select it, and copy it into your notes. Do the same for the **hash**, the **Job ID** and the **backend name**.
- **DO (optional):** In the left sidebar, tap the 📁 folder icon, then tap ⋮ next to `quantum_receipt.json` and choose **Download**.
- **WHAT YOU SEE:** `quantum_receipt.json` in the file list.
- **COST:** $0.

### Step 8. Double-check the hash
- **DO:** Add a third cell, paste the contents of `quantum_hash.py`, and tap ▶.
- **WHAT YOU SEE:** `RESULT : MATCH - receipt is intact`.
- You can also hash any string directly: `!python quantum_hash.py '{"00000":0.4873,...}'` (upload the file to Colab first). The hash covers the **exact** characters, so a single changed digit or space gives a completely different hash.
- **COST:** $0.

---

## Phase 3: Put the hash into the Master Control Center

### Step 9. Edit the CONFIG block in master.html
There are two ways to do this. Option A is permanent and is the one you should publish.

**Option A: edit the file (permanent, the same for everyone)**
- **DO:** Open `master.html` in a text editor. On iPhone, the free **Textastic** trial or **Koder** works, or edit it on github.com with the ✏️ pencil icon. Find the block marked:
  ```
  /* CONFIG  —  EDIT THIS BLOCK, THEN UPLOAD THE FILE TO PINATA */
  ```
  Replace:
  - each `PASTE_..._CID_HERE` with your five evidence CIDs
  - `PASTE_BACKEND_NAME_HERE` with the backend name (e.g. `ibm_brisbane`)
  - `PASTE_JOB_ID_HERE` with the job ID
  - `distribution: ""` with your QUANTUM OUTPUT line. Wrap it in **single** quotes because it contains double quotes: `distribution: '{"00000":0.4873,...}',`
  - `PASTE_QUANTUM_HASH_HERE` with the 64-character hash
- **WHAT YOU SEE:** Values in quotes. Keep the quotes and the commas at the end of each line.

**Option B: fill in Setup on the device (quick, saved only in your browser)**
- Open the page, scroll to **Setup**, tap **Edit CIDs & quantum record on this device**, paste everything in, and tap **Save**.

### Step 10. Test the app locally
- **DO:** Tap `master.html` in the Files app to preview it, or (better) do Steps 11–12 and open the gateway link.
- **WHAT YOU SEE:** A black-and-gold page titled **MASTER CONTROL CENTER** with five numbered evidence entries, each with **Open (dweb.link)** and **Backup (ipfs.io)** links.
- Note: the Files preview may block JavaScript and Web Crypto. Everything works once the page is opened over `https://`.
- **COST:** $0.

---

## Phase 4: Publish to IPFS (Pinata)

### Step 11. Upload master.html
- **DO:** Go to **https://app.pinata.cloud** and sign up (free). Tap **+ Add**, then **File Upload**, choose `master.html` from Files, and tap **Upload**.
- **WHAT YOU SEE:** `master.html` in your file list with a **CID** column (`bafy…` or `Qm…`) and a copy icon.
- **DO:** Copy the CID. This is your **master.html CID**.
- **COST:** $0 on Pinata's free tier.

### Step 12. Open the live app
- **DO:** In Safari, go to `https://dweb.link/ipfs/<your master.html CID>`.
- **WHAT YOU SEE:** Your Master Control Center loads. Tap each **Open (dweb.link)** link. Each evidence file should open; the first load can take 10–60 seconds while the gateway fetches it. If dweb.link is slow, use **Backup (ipfs.io)**.

---

## Phase 5: Build the manifest

### Step 13. Connect your wallet, generate a key, and run the assessment
- **DO:** Open the **MetaMask app**, tap the **browser** tab (🧭 or ☰ → Browser), and enter `https://dweb.link/ipfs/<master.html CID>`.
  (MetaMask's wallet connection works only inside MetaMask's own browser on iPhone, not in Safari.)
- **DO:** Tap **Connect Sovereign Wallet**, then **Connect** in the MetaMask popup.
  - **WHAT YOU SEE:** `Connected: 0x…` plus a chain number (`11155111` is Sepolia, `1` is Ethereum mainnet).
- **DO:** Tap **Generate Signing Key**.
  - **WHAT YOU SEE:** `ECDSA secp256k1 key ready.` and a 64-character fingerprint. (The page loads a small signing library from a CDN the first time you do this — it needs a working internet connection.)
- **DO:** Tap **Run Divinity Assessment** and answer the 5 popups with numbers from 1 to 5.
  - **WHAT YOU SEE:** A large score such as `88 / 100`, then **Acceptable alignment (≥ 81%)** or **Below the 81% alignment threshold**.
- **DO:** Paste your QUANTUM OUTPUT into the Quantum Verification box and tap **Hash Quantum Output**.
  - **WHAT YOU SEE:** The SHA-256, followed by `MATCHES the recorded quantum hash ✓`. **Copy Quantum Hash** copies it to the clipboard.
- **COST:** $0. Connecting a wallet and signing locally cost no gas.

### Step 14. Add the master.html CID and download the manifest
- **DO:** Under **Setup**, paste your master.html CID (from Step 11) into **master.html CID** and tap **Save**.
- **DO:** Tap **Download Manifest**.
- **WHAT YOU SEE:** Either a download prompt or the iOS share sheet (choose **Save to Files**). Below the button: `File SHA-256 (use as bytes32 in Remix): 0x…`, any ⚠ warnings (missing CIDs, no wallet, and so on), and the full JSON.
  - If nothing downloads (common inside the MetaMask browser), tap **Copy Manifest JSON**. Then, in Safari, open Pinata and upload the JSON as a file, or paste it into a new `Manifest_Sovereign.json` file.
- **DO:** Copy the `0x…` **File SHA-256**. You need it in Step 17.
- **COST:** $0.

### Step 15. Upload the manifest to Pinata
- **DO:** In Pinata, tap **+ Add**, then **File Upload**, and choose `Manifest_Sovereign.json`.
- **WHAT YOU SEE:** A new row with its own CID. Copy it. This is your **Manifest CID**.
- **COST:** $0.

---

## Phase 6: Anchor on-chain (Remix and MetaMask)

> ⚠️ **About cost:** every on-chain transaction needs gas. To keep this at $0,
> use the **Sepolia testnet**: get free test ETH from a Sepolia faucet. Some
> faucets ask you to sign in, or to hold a little mainnet ETH, to prevent abuse.
> Anchoring on **Ethereum mainnet costs real ETH**. A layer-2 network such as Base
> or Arbitrum costs a few cents.

### Step 16. Open Remix and connect MetaMask
- **DO:** In the **MetaMask app's browser**, go to **https://remix.ethereum.org**. Use desktop mode if offered.
- **DO:** In MetaMask, switch the network to **Sepolia**. You may need to turn on "Show test networks" in Settings.
- **DO:** In Remix, open the **Deploy & Run** tab (the Ethereum icon) and set **Environment** to **Injected Provider – MetaMask**. Approve the connection.
- **WHAT YOU SEE:** `Account: 0x…` with your Sepolia balance, and `Sepolia (11155111) network`.

### Step 17. Anchor the manifest
**If you already have GenesisRegistry deployed:**
- **DO:** Load your `GenesisRegistry.sol` into Remix and compile it (the Solidity tab, then **Compile**). In Deploy & Run, paste your contract address into **At Address** and tap it.

**If you don't have it deployed yet:**
- **DO:** Create a file `GenesisRegistry.sol` in Remix's File Explorer, paste `contracts/GenesisRegistry.sol` from this folder, compile with 0.8.24 or later, then tap **Deploy** and **Confirm** in MetaMask.
- **WHAT YOU SEE:** The contract appears under **Deployed Contracts** with its address. Save the address.

**Then:**
- **DO:** Expand the contract and find the anchor function. In the reference contract it is `anchor(string cid, bytes32 contentHash)`. Fill in:
  - `cid`: your **Manifest CID** from Step 15
  - `contentHash`: the `0x…` **File SHA-256** from Step 14
  Tap **transact**, then **Confirm** in MetaMask.
- **WHAT YOU SEE:** A green ✓ in the Remix console, with a transaction hash. Tap it to see the `Anchored` event. Open `https://sepolia.etherscan.io/tx/<hash>` to view it publicly.
- If your own contract's function has a different name or inputs, use those. The idea is the same: store the Manifest CID and, if your contract supports it, the hash.
- **COST:** $0 on Sepolia (test ETH). On mainnet, real gas fees apply.

### Step 18. Verify the whole chain
1. Call `latest()` (or your contract's equivalent) in Remix. It returns your Manifest CID and hash.
2. Open `https://dweb.link/ipfs/<Manifest CID>`. The manifest loads.
3. Inside it, `master_control_center.gateway_url` opens your app, and each `evidence[].gateway_url` opens a file.
4. `quantum_verification.sha256` equals the SHA-256 of `quantum_verification.distribution`. Check it in Colab with `quantum_hash.py`, or with **Hash Quantum Output** in the app.

---

## Zero-cost summary

| Service | Cost | Notes |
|---|---|---|
| IBM Quantum Open Plan | $0 | Limited monthly QPU minutes (see IBM's current plan page) |
| Google Colab | $0 | Free tier |
| Pinata | $0 | Free tier, with storage and file-count limits |
| dweb.link / ipfs.io gateways | $0 | Public, sometimes slow |
| MetaMask | $0 | Wallet app |
| Remix IDE | $0 | Browser IDE |
| Sepolia testnet | $0 | Faucet test ETH |
| Ethereum mainnet / L2 | **not free** | Real gas, only if you choose it |

Other free quantum options (qBraid, Quantum Rings, and others) sometimes offer
starter credits. Their offers change often, so check their pricing pages before
relying on them. This protocol needs only IBM's Open Plan.

---

## What this does and does not prove

- ✅ The manifest's CID is anchored on-chain at a specific time by your wallet. That proves the manifest existed, unchanged, at that time.
- ✅ Each evidence CID is the content hash of its file, so the files can't be swapped without changing the manifest.
- ✅ The quantum hash links the manifest to a specific IBM job (backend and job ID) and its measured results.
- ⚠️ IBM job results can be viewed only from the owner's IBM account. Others have to trust your receipt unless you share a screenshot or export from IBM. The hash proves the numbers weren't edited *after* they were recorded, not that they came from IBM.
- ⚠️ The signing key is a standard ECDSA secp256k1 key generated in the browser (the same scheme `enterprise/backend/proof_engine.py` and `enterprise/public/verify.html` use, so a manifest from any of them verifies the same way). It is not post-quantum, and it is forgotten when the page reloads. Its signature proves only that the manifest wasn't altered after you downloaded it.

---

## Final checklist

- [ ] IBM Quantum account created
- [ ] API token generated (stored safely, never pasted into a chat)
- [ ] Qiskit script run successfully (job ID and backend saved)
- [ ] Quantum hash generated (and `MATCH` confirmed)
- [ ] Master Control Center updated with hash
- [ ] Updated HTML uploaded to Pinata
- [ ] New CID added to Manifest
- [ ] Manifest uploaded to Pinata
- [ ] Manifest CID anchored to GenesisRegistry.sol
- [ ] Wallet address visible on the app
- [ ] Divinity Score calculated
