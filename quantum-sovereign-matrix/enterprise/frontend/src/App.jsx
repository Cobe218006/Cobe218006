/**
 * App.jsx — reference React dashboard for the enterprise proof layer.
 *
 * This is a STANDALONE COMPONENT, not a scaffolded app: it has no
 * package.json, build config or router of its own, and it is not wired
 * into any CI here. Drop it into a Vite/CRA/Next project that already has
 * `ethers` (v6) and Tailwind set up, then:
 *
 *   1. Deploy enterprise/contracts/GenesisRegistryV2.sol and set
 *      GENESIS_REGISTRY_ADDRESS below to the deployed address.
 *   2. Implement a backend endpoint at POST /api/quantum/execute that
 *      calls ProofEngine.execute_ghz5_circuit() + build_proof_manifest()
 *      (see ../backend/proof_engine.py) and returns { manifest, ipfsCid }.
 *      This file does not run Qiskit itself — it's a browser UI.
 *   3. Replace the placeholder CIDs in `evidenceCids` with your real ones.
 *
 * Differs from the iPhone-only ../../master.html: that file needs no
 * backend, build step, or paid infrastructure and runs entirely client-side
 * via static hosting on IPFS. Use this component instead when you already
 * have a server to run the Qiskit job and want a richer, multi-tab dashboard.
 */
import React, { useState } from "react";
import { ethers } from "ethers";

const GENESIS_REGISTRY_ADDRESS = "0xYourGenesisRegistryV2ContractAddressHere";
const GENESIS_REGISTRY_ABI = [
  "function anchorProof(bytes32 _evidenceHash, string calldata _ipfsCID, string calldata _proofType) external",
  "function verifyProof(bytes32 _evidenceHash) external view returns (bool isValid, string memory ipfsCID, string memory proofType, uint256 timestamp, address issuer, uint8 status)",
];

const TABS = ["dashboard", "quantum", "vault", "ai_audit"];

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [walletAddress, setWalletAddress] = useState(null);
  const [quantumResult, setQuantumResult] = useState(null); // { manifest, ipfsCid }
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  // Replace with your own five evidence CIDs before deploying.
  const [evidenceCids] = useState([
    { title: "Covenant", cid: "PASTE_COVENANT_CID_HERE" },
    { title: "Ecclesiastical Decree", cid: "PASTE_DECREE_CID_HERE" },
    { title: "Book of the Ladderborn Dominion", cid: "PASTE_LADDERBORN_CID_HERE" },
    { title: "Ancient Dams", cid: "PASTE_ANCIENT_DAMS_CID_HERE" },
    { title: "Affidavit of Covenant", cid: "PASTE_AFFIDAVIT_CID_HERE" },
  ]);

  async function connectWallet() {
    if (!window.ethereum) {
      setStatusMsg({ ok: false, text: "No wallet found. Open this page inside MetaMask's in-app browser." });
      return;
    }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      setWalletAddress(await signer.getAddress());
      setStatusMsg(null);
    } catch (err) {
      setStatusMsg({ ok: false, text: "Wallet connection failed: " + err.message });
    }
  }

  async function runQuantumExecution() {
    setLoading(true);
    setStatusMsg(null);
    try {
      const response = await fetch("/api/quantum/execute", { method: "POST" });
      if (!response.ok) throw new Error("Backend returned HTTP " + response.status);
      const data = await response.json(); // expected: { manifest, ipfsCid }
      if (!data.manifest || !data.manifest.canonical_digest_sha256) {
        throw new Error("Backend response is missing manifest.canonical_digest_sha256");
      }
      setQuantumResult(data);
    } catch (err) {
      setStatusMsg({ ok: false, text: "Quantum pipeline error: " + err.message });
    } finally {
      setLoading(false);
    }
  }

  async function anchorOnChain() {
    if (!walletAddress) return setStatusMsg({ ok: false, text: "Connect your wallet first." });
    if (!quantumResult) return setStatusMsg({ ok: false, text: "Run the quantum pipeline first." });
    if (GENESIS_REGISTRY_ADDRESS.startsWith("0xYour")) {
      return setStatusMsg({ ok: false, text: "Set GENESIS_REGISTRY_ADDRESS to your deployed contract first." });
    }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(GENESIS_REGISTRY_ADDRESS, GENESIS_REGISTRY_ABI, signer);

      const tx = await contract.anchorProof(
        "0x" + quantumResult.manifest.canonical_digest_sha256,
        quantumResult.ipfsCid || "",
        "QUANTUM_GHZ"
      );
      setStatusMsg({ ok: true, text: "Transaction submitted: " + tx.hash + " — waiting for confirmation…" });
      await tx.wait();
      setStatusMsg({ ok: true, text: "Anchored on GenesisRegistryV2. Tx: " + tx.hash });
    } catch (err) {
      setStatusMsg({ ok: false, text: "Anchoring failed: " + (err.reason || err.message) });
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-6">
      <header className="max-w-6xl mx-auto flex flex-wrap gap-3 justify-between items-center pb-6 border-b border-amber-500/30 mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-wider text-amber-400">QUANTUM SOVEREIGN MATRIX</h1>
          <p className="text-xs text-slate-400">Enterprise Proof Infrastructure — backend + on-chain anchoring</p>
        </div>
        <button
          onClick={connectWallet}
          className="bg-amber-500 hover:bg-amber-400 text-slate-950 px-4 py-2 rounded-md font-semibold text-sm"
        >
          {walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : "Connect Sovereign Wallet"}
        </button>
      </header>

      {statusMsg && (
        <div
          className={`max-w-6xl mx-auto mb-4 p-3 rounded-md text-xs font-mono ${
            statusMsg.ok ? "bg-emerald-900/40 text-emerald-300 border border-emerald-700" : "bg-rose-900/40 text-rose-300 border border-rose-700"
          }`}
        >
          {statusMsg.text}
        </div>
      )}

      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-4 gap-6">
        <nav className="flex flex-col space-y-2 bg-slate-900/60 p-4 rounded-lg border border-slate-800">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`text-left px-3 py-2 rounded-md text-sm font-medium capitalize ${
                activeTab === tab ? "bg-amber-500/20 text-amber-300 border border-amber-500/40" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {tab.replace("_", " ")}
            </button>
          ))}
        </nav>

        <main className="md:col-span-3 bg-slate-900/40 p-6 rounded-lg border border-slate-800">
          {activeTab === "dashboard" && (
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Evidence Vault" value={`${evidenceCids.length} assets`} />
              <Stat label="Quantum State" value={quantumResult ? "Executed" : "Standby"} accent="amber" />
              <Stat label="Chain Status" value={walletAddress ? "Connected" : "Offline"} accent="emerald" />
            </div>
          )}

          {activeTab === "quantum" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-amber-300 border-b border-slate-800 pb-2">5-Qubit GHZ Lab</h2>
              <button
                onClick={runQuantumExecution}
                disabled={loading}
                className="bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 px-4 py-2 rounded-md text-sm font-semibold"
              >
                {loading ? "Executing on QPU…" : "Execute GHZ-5 Circuit via Backend"}
              </button>

              {quantumResult && (
                <div className="bg-slate-950 p-4 rounded-md border border-slate-800 font-mono text-xs space-y-2 text-slate-300">
                  <p><span className="text-amber-400">Backend:</span> {quantumResult.manifest.payload?.backend_name}</p>
                  <p><span className="text-amber-400">Job ID:</span> {quantumResult.manifest.payload?.job_id}</p>
                  <p><span className="text-amber-400">GHZ fidelity:</span> {((quantumResult.manifest.payload?.ghz_fidelity ?? 0) * 100).toFixed(2)}%</p>
                  <p><span className="text-amber-400">SHA-256 digest:</span> {quantumResult.manifest.canonical_digest_sha256}</p>
                  <button
                    onClick={anchorOnChain}
                    className="mt-2 bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded text-xs font-semibold"
                  >
                    Anchor on GenesisRegistryV2
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === "vault" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-amber-300 border-b border-slate-800 pb-2">IPFS Evidence Vault</h2>
              <ul className="space-y-2">
                {evidenceCids.map((item) => (
                  <li key={item.title} className="bg-slate-950 p-3 rounded border border-slate-800 flex justify-between items-center text-xs">
                    <span className="font-medium text-slate-200">{item.title}</span>
                    <a href={`https://dweb.link/ipfs/${item.cid}`} target="_blank" rel="noreferrer" className="font-mono text-amber-400 hover:underline">
                      {item.cid.slice(0, 16)}…
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {activeTab === "ai_audit" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-amber-300 border-b border-slate-800 pb-2">AI Visibility / AEO Audit</h2>
              <p className="text-xs text-slate-400">
                Placeholder tab. Wire this to your own AEO/citation-tracking source before using it — this component
                does not capture or verify AI citations on its own.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  const color = accent === "amber" ? "text-amber-400" : accent === "emerald" ? "text-emerald-400" : "text-slate-200";
  return (
    <div className="bg-slate-950 p-4 rounded-md border border-slate-800">
      <span className="text-xs text-slate-500">{label}</span>
      <p className={`text-xl font-mono ${color}`}>{value}</p>
    </div>
  );
}
