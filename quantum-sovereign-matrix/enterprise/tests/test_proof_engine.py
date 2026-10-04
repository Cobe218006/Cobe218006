"""
Run from enterprise/:  pip install "qiskit>=2" qiskit-ibm-runtime ecdsa jcs pytest
                       pytest tests/test_proof_engine.py

These tests only exercise canonicalization and signing — no IBM account or
network access is needed. test_signature_is_low_s and
test_jcs_matches_known_vector specifically regression-test the two bugs this
protocol review caught: a naive implementation can produce a "valid" but
non-canonical (high-S) signature that a strict verifier (e.g.
@noble/secp256k1, used in verify.html) silently rejects, and a hand-rolled
"sort the keys" canonicalizer is not RFC 8785.
"""

import hashlib

import jcs
from ecdsa import SECP256k1, SigningKey
from ecdsa.util import sigdecode_string

from backend.proof_engine import ProofEngine, ProofEngineError

SECP256K1_ORDER = SECP256k1.order


def _signing_key_pem():
    return SigningKey.generate(curve=SECP256k1).to_pem()


def test_jcs_matches_known_vector():
    # A hand-rolled "sort the object keys" canonicalizer (what v1 of this
    # file did) gets this right by luck, but gets float formatting wrong:
    # RFC 8785 serializes 1.0 as "1", not "1.0". That's the concrete
    # difference between "sorted JSON" and actual JCS.
    payload = {"z": 1, "a": "x", "nested": {"b": 2, "a": 1}, "list": [3, 1, 2], "n": 1.0}
    canonical_bytes, digest_hex = ProofEngine.canonicalize_and_hash(payload)
    assert canonical_bytes == b'{"a":"x","list":[3,1,2],"n":1,"nested":{"a":1,"b":2},"z":1}'
    assert digest_hex == hashlib.sha256(canonical_bytes).hexdigest()
    assert len(digest_hex) == 64


def test_canonical_hashing_consistency():
    dict_a = {"z_key": 1, "a_key": "test", "nested": {"b": 2, "a": 1}}
    dict_b = {"a_key": "test", "z_key": 1, "nested": {"a": 1, "b": 2}}
    bytes_a, hash_a = ProofEngine.canonicalize_and_hash(dict_a)
    bytes_b, hash_b = ProofEngine.canonicalize_and_hash(dict_b)
    assert bytes_a == bytes_b
    assert hash_a == hash_b


def test_signature_is_low_s():
    """A naive ECDSA sign can emit a mathematically valid but non-canonical
    (s > n/2) signature. @noble/secp256k1 — used by verify.html — rejects
    those by default. This pins sign_digest to always emit low-S."""
    engine = ProofEngine(private_key_pem=_signing_key_pem())
    _, digest_hex = ProofEngine.canonicalize_and_hash({"a": 1})
    signature = engine.sign_digest(digest_hex)
    s = int(signature["value"][64:], 16)
    assert s <= SECP256K1_ORDER // 2, "signature is high-S; a strict verifier will reject it"
    assert signature["encoding"] == "compact-r-s-hex"
    assert len(signature["value"]) == 128  # 64 bytes, hex-encoded


def test_signature_verifies_against_digest_bytes_not_hex_text():
    """Pins the exact thing the review flagged: the signature must cover
    the 32 raw digest bytes, not the 64-character ASCII hex string."""
    pem = _signing_key_pem()
    engine = ProofEngine(private_key_pem=pem)
    _, digest_hex = ProofEngine.canonicalize_and_hash({"test_metric": 100, "status": "VERIFIED"})
    signature = engine.sign_digest(digest_hex)

    vk = SigningKey.from_pem(pem).get_verifying_key()
    sig_bytes = bytes.fromhex(signature["value"])

    # Correct: verifies against the raw digest bytes.
    assert vk.verify_digest(sig_bytes, bytes.fromhex(digest_hex), sigdecode=sigdecode_string)

    # The bug this replaces: verifying against the ASCII hex text must fail.
    import pytest
    from ecdsa import BadDigestError, BadSignatureError

    # Signing/verifying the wrong byte representation fails loudly (either
    # as a rejected signature, or - as here - because the 64-byte ASCII hex
    # text doesn't even fit the curve's expected digest length). Either way,
    # it must not silently "verify".
    with pytest.raises((BadSignatureError, BadDigestError)):
        vk.verify_digest(sig_bytes, digest_hex.encode("utf-8"), sigdecode=sigdecode_string)


def test_proof_manifest_shape_and_signature():
    pem = _signing_key_pem()
    engine = ProofEngine(private_key_pem=pem)
    manifest = engine.build_proof_manifest("UNIT_TEST", {"test_metric": 100, "status": "VERIFIED"})

    assert manifest["manifest_version"] == "4.0.0"
    assert manifest["canonicalization"] == "RFC 8785 (JSON Canonicalization Scheme)"
    assert len(manifest["digest"]["value"]) == 64
    assert manifest["signature"]["algorithm"] == "ECDSA"
    assert manifest["signature"]["curve"] == "secp256k1"
    assert "public_key" in manifest["signature"]

    vk = SigningKey.from_pem(pem).get_verifying_key()
    sig_bytes = bytes.fromhex(manifest["signature"]["value"])
    digest_bytes = bytes.fromhex(manifest["digest"]["value"])
    assert vk.verify_digest(sig_bytes, digest_bytes, sigdecode=sigdecode_string)

    # Tampering with the payload after signing must change the digest.
    _, tampered_digest = ProofEngine.canonicalize_and_hash({"test_metric": 101, "status": "VERIFIED"})
    assert tampered_digest != manifest["digest"]["value"]


def test_fails_closed_without_key():
    """A manifest must never be produced without a real signature — no
    silent 'unsigned' fallback that still looks like a complete proof."""
    engine = ProofEngine(private_key_pem=None)
    try:
        engine.build_proof_manifest("UNIT_TEST", {"a": 1})
        assert False, "expected ProofEngineError when no signing key is configured"
    except ProofEngineError:
        pass


def test_fails_closed_on_wrong_digest_length():
    engine = ProofEngine(private_key_pem=_signing_key_pem())
    try:
        engine.sign_digest("deadbeef")  # 4 bytes, not 32
        assert False, "expected ProofEngineError for a non-32-byte digest"
    except ProofEngineError:
        pass
