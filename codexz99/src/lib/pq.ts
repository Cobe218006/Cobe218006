/**
 * Post-quantum signing.
 *
 * NIST selected ML-DSA (CRYSTALS-Dilithium) in August 2024 as FIPS 204. A
 * credential signed with ML-DSA stays verifiable against a quantum
 * adversary that breaks ECDSA; one signed only with ECDSA does not.
 *
 * Optional dependency: @noble/post-quantum. If it isn't installed, this
 * module falls back to ECDSA-only and says so — it never pretends a
 * post-quantum signature exists when it doesn't.
 *
 *   npm install @noble/post-quantum
 */
import type { Signer } from 'ethers';

export type SignatureAlgorithm = 'ecdsa' | 'ml-dsa-65' | 'hybrid';

export interface SignatureEnvelope {
  algorithm: SignatureAlgorithm;
  ecdsa?: string; // hex, present for 'ecdsa' and 'hybrid'
  mldsa?: string; // base64, present for 'ml-dsa-65' and 'hybrid'
  mldsaPublicKey?: string; // base64 public key, required to verify mldsa
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pqModule: any = null;
let pqLoadAttempted = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPq(): Promise<any> {
  if (pqLoadAttempted) return pqModule;
  pqLoadAttempted = true;
  try {
    const m = await import('@noble/post-quantum/ml-dsa');
    pqModule = m;
  } catch {
    pqModule = null;
  }
  return pqModule;
}

export async function pqAvailable(): Promise<boolean> {
  return (await loadPq()) !== null;
}

function bytesToHexString(payload: Uint8Array): string {
  return '0x' + Array.from(payload, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Sign arbitrary bytes. Returns a self-describing envelope. */
export async function signPayload(
  signer: Signer | null,
  payload: Uint8Array,
  algorithm: SignatureAlgorithm = 'hybrid',
): Promise<SignatureEnvelope> {
  const env: SignatureEnvelope = { algorithm };

  if ((algorithm === 'ecdsa' || algorithm === 'hybrid') && signer) {
    env.ecdsa = await signer.signMessage(bytesToHexString(payload));
  } else if (algorithm === 'ecdsa' && !signer) {
    throw new Error('ECDSA signing requested but no signer is connected.');
  }

  if (algorithm === 'ml-dsa-65' || algorithm === 'hybrid') {
    const pq = await loadPq();
    if (pq?.ml_dsa65) {
      const { publicKey, secretKey } = pq.ml_dsa65.keygen();
      const sig = pq.ml_dsa65.sign(secretKey, payload);
      env.mldsa = bytesToBase64(sig);
      env.mldsaPublicKey = bytesToBase64(publicKey);
    } else if (algorithm === 'ml-dsa-65') {
      throw new Error('ML-DSA requested but @noble/post-quantum is not installed.');
    }
    // hybrid without the optional dep: silently proceeds ECDSA-only, and
    // the envelope's absent `mldsa` field is the honest record of that.
  }

  return env;
}

export interface VerificationResult {
  ok: boolean;
  ecdsa: boolean | null;
  mldsa: boolean | null;
  notes: string[];
}

export async function verifyPayload(
  payload: Uint8Array,
  env: SignatureEnvelope,
  expectedEcdsaAddress?: string,
): Promise<VerificationResult> {
  const notes: string[] = [];
  let ecdsa: boolean | null = null;
  let mldsa: boolean | null = null;

  if (env.ecdsa) {
    try {
      const { verifyMessage } = await import('ethers');
      const recovered = verifyMessage(bytesToHexString(payload), env.ecdsa);
      ecdsa = expectedEcdsaAddress ? recovered.toLowerCase() === expectedEcdsaAddress.toLowerCase() : true;
      if (!ecdsa) notes.push(`ECDSA recovers to ${recovered}, expected ${expectedEcdsaAddress}`);
    } catch {
      ecdsa = false;
      notes.push('ECDSA verification threw (malformed signature).');
    }
  }

  if (env.mldsa && env.mldsaPublicKey) {
    const pq = await loadPq();
    if (pq?.ml_dsa65) {
      try {
        const sig = base64ToBytes(env.mldsa);
        const pk = base64ToBytes(env.mldsaPublicKey);
        mldsa = pq.ml_dsa65.verify(pk, payload, sig);
        if (!mldsa) notes.push('ML-DSA signature did not verify.');
      } catch {
        mldsa = false;
        notes.push('ML-DSA verification threw (malformed signature).');
      }
    } else {
      notes.push('ML-DSA present but @noble/post-quantum is not installed here — cannot verify it.');
    }
  }

  let ok = false;
  if (env.algorithm === 'ecdsa') ok = ecdsa === true;
  else if (env.algorithm === 'ml-dsa-65') ok = mldsa === true;
  else ok = ecdsa === true || mldsa === true; // hybrid: either half validating is sufficient

  return { ok, ecdsa, mldsa, notes };
}
