"""
Quantum Hash Generator - SHA-256 of the quantum output string.

Hashes the EXACT text you give it (UTF-8, leading/trailing whitespace trimmed),
so anyone can recompute the same hash with any SHA-256 tool, including the
"Hash Quantum Output" box in master.html.

Usage:
    python quantum_hash.py '{"00000":0.4980,"11111":0.5020}'
    python quantum_hash.py --receipt quantum_receipt.json   # re-check a receipt
    python quantum_hash.py                                   # prompts for input

In Colab, run it in a new cell after qiskit_ghz.py; with no arguments it
picks up quantum_receipt.json automatically if that file exists.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()


def manifest_snippet(distribution: str, digest: str, extra: dict | None = None) -> str:
    block = dict(extra or {})
    block["distribution"] = distribution
    block["hash_algorithm"] = "SHA-256 over the exact UTF-8 bytes of 'distribution'"
    block["sha256"] = digest
    return json.dumps({"quantum_verification": block}, indent=2)


def check_receipt(path: str) -> None:
    with open(path, encoding="utf-8") as fh:
        qv = json.load(fh)["quantum_verification"]
    recomputed = sha256_hex(qv["distribution"])
    ok = recomputed == qv["sha256"]
    print(f"Distribution : {qv['distribution']}")
    print(f"Stored hash  : {qv['sha256']}")
    print(f"Recomputed   : {recomputed}")
    print("RESULT       : " + ("MATCH - receipt is intact" if ok else "MISMATCH - receipt was altered"))
    if not ok:
        sys.exit(1)


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["--receipt"]:
        check_receipt(args[1] if len(args) > 1 else "quantum_receipt.json")
        return
    if args:
        text = " ".join(args)
    elif os.path.exists("quantum_receipt.json"):
        check_receipt("quantum_receipt.json")
        return
    else:
        text = input("Paste the quantum output string, then Enter: ")

    text = text.strip()
    if not text:
        sys.exit("ERROR: empty input.")
    digest = sha256_hex(text)
    print("\nInput hashed (exact):", text)
    print("\nQUANTUM VERIFICATION HASH:\n" + digest)
    print("\nPaste into Manifest_Sovereign.json:\n" + manifest_snippet(text, digest))


if __name__ == "__main__":
    main()
