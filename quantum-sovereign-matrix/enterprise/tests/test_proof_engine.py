"""
Run from enterprise/:  pip install "qiskit>=2" qiskit-ibm-runtime ecdsa pytest
                        pytest tests/test_proof_engine.py

These tests only exercise canonicalization and signing — no IBM account or
network access is needed.
"""

from ecdsa import SECP256k1, SigningKey

from backend.proof_engine import ProofEngine


def test_canonical_hashing_consistency():
    # Key order in the input dict must not affect the resulting hash.
    dict_a = {"z_key": 1, "a_key": "test", "nested": {"b": 2, "a": 1}}
    dict_b = {"a_key": "test", "z_key": 1, "nested": {"a": 1, "b": 2}}

    str_a, hash_a = ProofEngine.canonicalize_and_hash(dict_a)
    str_b, hash_b = ProofEngine.canonicalize_and_hash(dict_b)

    assert str_a == str_b
    assert hash_a == hash_b
    assert len(hash_a) == 64


def test_proof_manifest_signature():
    signing_key = SigningKey.generate(curve=SECP256k1)
    engine = ProofEngine(private_key_pem=signing_key.to_pem())
    payload = {"test_metric": 100, "status": "VERIFIED"}
    manifest = engine.build_proof_manifest("UNIT_TEST", payload)

    assert manifest["manifest_version"] == "3.0.0"
    assert manifest["proof_type"] == "UNIT_TEST"
    assert len(manifest["canonical_digest_sha256"]) == 64
    assert "signature_secp256k1" in manifest

    # The signature must verify against the engine's own public key, and
    # must fail against a payload that was tampered with afterward.
    verifying_key = signing_key.get_verifying_key()
    sig = bytes.fromhex(manifest["signature_secp256k1"])
    assert verifying_key.verify(sig, manifest["canonical_digest_sha256"].encode("utf-8"))

    _, tampered_digest = ProofEngine.canonicalize_and_hash({"test_metric": 101, "status": "VERIFIED"})
    assert tampered_digest != manifest["canonical_digest_sha256"]


def test_manifest_without_key_is_unsigned():
    engine = ProofEngine(private_key_pem=None)
    manifest = engine.build_proof_manifest("UNIT_TEST", {"a": 1})
    assert "signature_secp256k1" not in manifest
