/**
 * Entitlement credentials: a Verifiable Credential whose subject is a
 * RIGHT ("holder may spend/own/access X") rather than a fact about a
 * person. This is the pattern behind W3C capability systems (ZCAP-LD,
 * UCAN) and what IBM Verify calls "verifiable credentials with holder
 * binding" — see the holder-binding note below for what this file does
 * NOT yet implement.
 */
import canonicalize from 'canonicalize';
import type { Signer } from 'ethers';
import { sha256Hex } from './crypto';
import { addressFromDidPkh, didPkh } from './vc';
import { getVault } from './store';
import { signPayload, verifyPayload, type SignatureAlgorithm, type SignatureEnvelope } from './pq';

export type ClaimKind = 'purchase' | 'ownership' | 'access';

export interface PurchaseClaim {
  kind: 'purchase';
  amountMinor: number; // minor units of `currency`
  currency: string; // 'USDC', 'USD', 'ETH'
  merchant: string; // did or domain the claim is bound to
  item: string;
}

export interface OwnershipClaim {
  kind: 'ownership';
  assetId: string; // token id, serial, deed number
  assetClass: string; // 'erc721', 'invoice', 'land-title', 'equity'
  basisPoints: number; // fraction held, 0-10000. 10000 = full.
  registry: string; // chain id, registry URL, or 'offchain'
}

export interface AccessClaim {
  kind: 'access';
  service: string; // 'api:acme.com/v1', 'facility:lab-a', 'role:auditor'
  scope: string[];
  validUntil: number; // unix seconds, 0 = non-expiring
}

export type ClaimBody = PurchaseClaim | OwnershipClaim | AccessClaim;

export interface ClaimCredential {
  '@context': string[];
  id: string;
  type: ['VerifiableCredential', 'EntitlementCredential'];
  issuer: { id: string };
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: {
    id: string; // holder DID
    claim: ClaimBody;
    status: 'active' | 'redeemed' | 'revoked';
  };
  proof: SignatureEnvelope;
  anchor?: { proofId: string; txHash: string; contentHash: string };
}

export interface IssueClaimInput {
  holderDid: string;
  claim: ClaimBody;
  algorithm?: SignatureAlgorithm;
  expiresAt?: number; // unix seconds
}

function canonicalBytes(obj: unknown): Uint8Array {
  const json = canonicalize(obj);
  if (json === undefined) throw new Error('Canonicalization failed (undefined input).');
  return new TextEncoder().encode(json);
}

/**
 * A signed VC's body can never be mutated without invalidating its own
 * signature — so "redeemed" can NOT be recorded by changing
 * credentialSubject.status in the file itself. It must be checked by
 * looking up this independent, deterministic marker in the vault instead.
 * Anyone holding the VC JSON can compute this hash without the issuer's
 * help, which is exactly what lets both redeemClaim and verifyClaim agree
 * on where to look.
 */
function redemptionMarkerHash(claimId: string): Promise<string> {
  return sha256Hex(`redemption-marker:${claimId}`);
}

export async function issueClaim(signer: Signer, input: IssueClaimInput): Promise<ClaimCredential> {
  const issuerAddress = await signer.getAddress();
  const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? 11155111);
  const issuerDid = didPkh(chainId, issuerAddress);

  const body = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://codexz99.example/contexts/entitlement/v1.jsonld',
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', 'EntitlementCredential'] as ['VerifiableCredential', 'EntitlementCredential'],
    issuer: { id: issuerDid },
    issuanceDate: new Date().toISOString(),
    ...(input.expiresAt ? { expirationDate: new Date(input.expiresAt * 1000).toISOString() } : {}),
    credentialSubject: {
      id: input.holderDid,
      claim: input.claim,
      status: 'active' as const,
    },
  };

  const signature = await signPayload(signer, canonicalBytes(body), input.algorithm ?? 'hybrid');
  return { ...body, proof: signature };
}

export interface ClaimVerification {
  signatureOk: boolean;
  holderOk: boolean;
  statusOk: boolean;
  unexpired: boolean;
  notes: string[];
  entitlement: ClaimBody | null;
}

/**
 * Offline verification. NOTE — holder binding is not yet implemented: this
 * checks that the credential NAMES `holderDid` as its subject, but does
 * NOT require the presenter to prove they control that DID's key (e.g. by
 * signing a fresh verifier-issued challenge). Until that's added, a copy
 * of this JSON file is as good as the "real" credential to anyone who has
 * it — treat it as a bearer token, not proof of possession.
 */
export async function verifyClaim(vc: ClaimCredential, holderDid: string): Promise<ClaimVerification> {
  const notes: string[] = ['Holder binding not implemented: presenting this JSON is not proof of possession.'];

  const { proof: _proof, anchor: _anchor, ...unsigned } = vc;
  void _anchor;

  const expectedIssuer = addressFromDidPkh(vc.issuer.id);
  const sig = await verifyPayload(canonicalBytes(unsigned), _proof, expectedIssuer ?? undefined);
  notes.push(...sig.notes);

  const holderOk = vc.credentialSubject.id === holderDid;
  if (!holderOk) notes.push(`Issued to ${vc.credentialSubject.id}, presented by ${holderDid}`);

  // The embedded status field can never change after signing (mutating it
  // would invalidate the signature), so "redeemed" is checked against the
  // vault's independent redemption marker, not this static field.
  let statusOk = vc.credentialSubject.status === 'active';
  if (statusOk) {
    try {
      const marker = await redemptionMarkerHash(vc.id);
      const redeemed = await getVault().lookup(marker);
      if (redeemed) {
        statusOk = false;
        notes.push('Already redeemed (found a redemption marker in the vault for this claim ID).');
      }
    } catch (e) {
      notes.push(`Could not check redemption status: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    notes.push(`Status is "${vc.credentialSubject.status}"`);
  }

  const unexpired = !vc.expirationDate || new Date(vc.expirationDate).getTime() > Date.now();
  if (!unexpired) notes.push(`Expired ${vc.expirationDate}`);

  const ok = sig.ok && holderOk && statusOk && unexpired;
  return {
    signatureOk: sig.ok,
    holderOk,
    statusOk,
    unexpired,
    notes,
    entitlement: ok ? vc.credentialSubject.claim : null,
  };
}

export interface Redemption {
  claimId: string;
  claimHash: string;
  redeemedBy: string;
  redeemTxHash: string;
  proofId: string;
  redeemedAt: number;
}

export async function redeemClaim(vc: ClaimCredential, redeemerDid: string): Promise<Redemption> {
  if (vc.credentialSubject.status !== 'active') {
    throw new Error(`Cannot redeem: status is ${vc.credentialSubject.status}`);
  }
  if (vc.credentialSubject.id !== redeemerDid) {
    throw new Error('Credential does not belong to this redeemer.');
  }

  const vault = getVault();
  const marker = await redemptionMarkerHash(vc.id);
  if (await vault.lookup(marker)) {
    throw new Error('This claim has already been redeemed.');
  }

  const { proof: _proof, anchor: _anchor, ...unsigned } = vc;
  void _proof;
  void _anchor;
  const claimHash = await sha256Hex(canonicalBytes(unsigned));

  const { proofId, txHash } = await vault.anchor(marker, `urn:redemption:${vc.id}`, `Redeemed: ${vc.id}`);

  return {
    claimId: vc.id,
    claimHash,
    redeemedBy: redeemerDid,
    redeemTxHash: txHash,
    proofId,
    redeemedAt: Math.floor(Date.now() / 1000),
  };
}

export async function isRedeemed(claimId: string): Promise<boolean> {
  const marker = await redemptionMarkerHash(claimId);
  const rec = await getVault().lookup(marker);
  return rec !== null;
}

export function describeClaim(claim: ClaimBody): string {
  switch (claim.kind) {
    case 'purchase':
      return `Spend up to ${(claim.amountMinor / 100).toLocaleString()} ${claim.currency} at ${claim.merchant} for "${claim.item}"`;
    case 'ownership':
      return `${(claim.basisPoints / 100).toFixed(2)}% of ${claim.assetClass} asset ${claim.assetId} on ${claim.registry}`;
    case 'access':
      return `${claim.scope.join(', ')} on ${claim.service}${
        claim.validUntil ? ` until ${new Date(claim.validUntil * 1000).toLocaleDateString()}` : ''
      }`;
  }
}
