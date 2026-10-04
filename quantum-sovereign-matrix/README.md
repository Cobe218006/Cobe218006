# Quantum Sovereign Matrix

A free, iPhone-friendly pipeline that:

1. runs a 5-qubit GHZ circuit on IBM Quantum hardware (`qiskit_ghz.py`)
2. hashes the measured distribution with SHA-256 (`quantum_hash.py`)
3. records the hash, your five evidence CIDs, your wallet and a Divinity score in a signed
   `Manifest_Sovereign.json`, built by the Master Control Center (`master.html`)
4. anchors the manifest's CID on-chain through `GenesisRegistry.sol`

**Start here → [DEPLOYMENT.md](DEPLOYMENT.md)** (step-by-step guide with "WHAT YOU SEE" notes and the final checklist).

Quick local test (no IBM account needed):

```
pip install "qiskit>=2" qiskit-ibm-runtime
python qiskit_ghz.py --simulate
python quantum_hash.py --receipt quantum_receipt.json
```
