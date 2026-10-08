"""
Quantum Sovereign Matrix - 5-qubit GHZ run on IBM Quantum (Qiskit 2.x).

Builds a 5-qubit GHZ state (H on q0, then a CNOT chain q0->q1->q2->q3->q4),
measures every qubit, runs it on the least-busy real IBM Quantum backend your
account can use, and prints:

  * the probability distribution, as a canonical one-line JSON string
  * the SHA-256 of that exact string (your Quantum Verification Hash)
  * a quantum_verification block ready to paste into Manifest_Sovereign.json

It also writes quantum_receipt.json next to the script.

Run in Google Colab (works in iPhone Safari):
    Cell 1:  !pip install -q "qiskit>=2" qiskit-ibm-runtime
    Cell 2:  paste this whole file and press Play

Run locally:
    pip install "qiskit>=2" qiskit-ibm-runtime
    python qiskit_ghz.py              # real IBM hardware (uses QPU time)
    python qiskit_ghz.py --simulate   # local simulator, free, no account

Your API token is read from (first match wins):
    1. the IBM_QUANTUM_TOKEN environment variable
    2. Colab Secrets, key name IBM_QUANTUM_TOKEN (key icon in Colab's sidebar)
    3. a hidden prompt (getpass) - nothing is echoed or saved in the notebook
"""

from __future__ import annotations

import datetime as _dt
import getpass
import hashlib
import json
import os
import sys

NUM_QUBITS = 5
SHOTS = 1024
# Optional: pin a backend name such as "ibm_brisbane". None = least busy.
BACKEND_NAME: str | None = None
# Optional: your instance CRN from quantum.cloud.ibm.com. None = auto-pick.
IBM_INSTANCE: str | None = None


def build_ghz(n: int = NUM_QUBITS):
    from qiskit import QuantumCircuit

    qc = QuantumCircuit(n, name=f"ghz_{n}")
    qc.h(0)
    # A chain (0->1, 1->2, ...) maps onto IBM's heavy-hex layout with fewer
    # SWAPs than fanning every CNOT out of qubit 0, so the result is cleaner.
    for i in range(n - 1):
        qc.cx(i, i + 1)
    qc.measure_all()  # classical register is named "meas"
    return qc


def canonical_distribution(counts: dict[str, int]) -> tuple[str, dict[str, float]]:
    """Return a deterministic one-line JSON string of probabilities.

    Keys are sorted, probabilities use exactly 4 decimals, no spaces. Hashing
    this exact string in Python, JavaScript or any SHA-256 tool gives the same
    hash, which is what makes it independently checkable.
    """
    total = sum(counts.values())
    probs = {k: counts[k] / total for k in sorted(counts)}
    body = ",".join(f'"{k}":{v:.4f}' for k, v in probs.items())
    return "{" + body + "}", probs


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_token() -> str:
    token = os.environ.get("IBM_QUANTUM_TOKEN", "").strip()
    if token:
        return token
    try:  # Colab Secrets
        from google.colab import userdata  # type: ignore

        token = (userdata.get("IBM_QUANTUM_TOKEN") or "").strip()
        if token:
            return token
    except Exception:
        pass
    return getpass.getpass("Paste your IBM Quantum API key (hidden), then Enter: ").strip()


def run_on_ibm(qc):
    from qiskit.transpiler import generate_preset_pass_manager
    from qiskit_ibm_runtime import QiskitRuntimeService, SamplerV2
    from qiskit_ibm_runtime.exceptions import (
        IBMAccountError,
        IBMNotAuthorizedError,
        IBMRuntimeError,
        RuntimeJobFailureError,
    )

    token = read_token()
    if not token:
        sys.exit("ERROR: no API key provided. See DEPLOYMENT.md step 2.")

    print("Authenticating to IBM Quantum ...")
    try:
        service = QiskitRuntimeService(
            channel="ibm_quantum_platform", token=token, instance=IBM_INSTANCE
        )
    except (IBMNotAuthorizedError, IBMAccountError) as exc:
        sys.exit(
            "ERROR: IBM Quantum rejected the API key.\n"
            "  - Copy the key again from quantum.cloud.ibm.com (no spaces).\n"
            "  - Keys created on the old quantum.ibm.com site no longer work.\n"
            f"  Details: {exc}"
        )
    except Exception as exc:
        sys.exit(f"ERROR: could not reach IBM Quantum ({type(exc).__name__}): {exc}")

    print("Choosing a backend ...")
    try:
        if BACKEND_NAME:
            backend = service.backend(BACKEND_NAME)
        else:
            backend = service.least_busy(
                operational=True, simulator=False, min_num_qubits=NUM_QUBITS
            )
    except Exception as exc:
        sys.exit(
            "ERROR: no IBM backend is available to your account right now.\n"
            "  - Check the 'Compute resources' page on quantum.cloud.ibm.com.\n"
            "  - Try again later, or run with --simulate to test the pipeline.\n"
            f"  Details: {exc}"
        )

    status = backend.status()
    print(
        f"Backend: {backend.name}  ({backend.num_qubits} qubits, "
        f"{status.pending_jobs} jobs queued)"
    )

    # Real hardware only accepts circuits written in its native gates/layout.
    pm = generate_preset_pass_manager(backend=backend, optimization_level=1)
    isa_circuit = pm.run(qc)

    # Job mode (no Session) is what the free Open Plan allows.
    sampler = SamplerV2(mode=backend)
    try:
        job = sampler.run([isa_circuit], shots=SHOTS)
    except IBMRuntimeError as exc:
        sys.exit(
            "ERROR: IBM refused the job. If the message mentions usage or quota,\n"
            "your free QPU minutes for this window are used up - run with\n"
            f"--simulate or wait for the window to reset.\n  Details: {exc}"
        )

    job_id = job.job_id()
    print(f"Job submitted. Job ID: {job_id}")
    print("Waiting in the queue (can take seconds to hours on the free plan) ...")
    try:
        result = job.result()
    except RuntimeJobFailureError as exc:
        sys.exit(f"ERROR: the job failed on the backend: {exc}")

    counts = result[0].data.meas.get_counts()
    return counts, backend.name, job_id, False


def run_simulated(qc):
    from qiskit.primitives import StatevectorSampler

    print("Running on the LOCAL simulator (not quantum hardware) ...")
    result = StatevectorSampler().run([qc], shots=SHOTS).result()
    counts = result[0].data.meas.get_counts()
    return counts, "local_statevector_simulator", "local-simulation", True


def main() -> None:
    simulate = "--simulate" in sys.argv
    qc = build_ghz()
    print(qc.draw(output="text"))

    counts, backend_name, job_id, simulated = (
        run_simulated(qc) if simulate else run_on_ibm(qc)
    )

    canonical, probs = canonical_distribution(counts)
    digest = sha256_hex(canonical)
    ghz_fidelity = probs.get("0" * NUM_QUBITS, 0.0) + probs.get("1" * NUM_QUBITS, 0.0)

    quantum_verification = {
        "provider": "local" if simulated else "IBM Quantum (Open Plan)",
        "hardware": not simulated,
        "backend": backend_name,
        "job_id": job_id,
        "circuit": f"GHZ-{NUM_QUBITS} (H q0, CNOT chain q0->q{NUM_QUBITS - 1}, measure all)",
        "shots": SHOTS,
        "distribution": canonical,
        "ghz_population": round(ghz_fidelity, 4),
        "hash_algorithm": "SHA-256 over the exact UTF-8 bytes of 'distribution'",
        "sha256": digest,
        "executed_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
    }

    receipt = {"quantum_verification": quantum_verification, "raw_counts": counts}
    with open("quantum_receipt.json", "w", encoding="utf-8") as fh:
        json.dump(receipt, fh, indent=2)

    print("\n================ QUANTUM OUTPUT ================")
    print(canonical)
    print(f"\nGHZ population (|00000> + |11111>): {ghz_fidelity:.1%}")
    if not simulated:
        print("(Real hardware is noisy: a few other bitstrings showing up is normal.)")
    print("\n============ QUANTUM VERIFICATION HASH ===========")
    print(digest)
    print("\n====== PASTE INTO Manifest_Sovereign.json / master.html ======")
    print(json.dumps({"quantum_verification": quantum_verification}, indent=2))
    print("\nSaved: quantum_receipt.json")


if __name__ == "__main__":
    main()
