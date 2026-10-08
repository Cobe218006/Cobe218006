/**
 * Trust Score: a transparent, auditable number computed from real local
 * state (credentials held, proofs anchored, identity statement sealed).
 * No hidden weights — read this file and you can compute your own score
 * by hand. Gates nothing about truth, only about how much verifiable
 * history exists behind an account before it can reach higher-risk
 * modules (Market, Claims).
 */
import { listCredentials, type CredentialDomain, type HeldCredential } from './credentials';
import { getVault } from './store';
import { sha256Hex } from './crypto';

export const TRUST_THRESHOLD = 81;

export interface TrustInput {
  credentials: HeldCredential[];
  proofCount: number;
  revokedProofCount: number;
  identitySealed: boolean;
  identityAnchored: boolean;
}

export interface TrustFactor {
  id: string;
  label: string;
  earned: number;
  max: number;
  detail: string;
  action?: { label: string; tab: 'proofs' | 'identity' | 'certify' | 'market' | 'claims'; pointsAvailable: number };
}

export interface TrustScore {
  total: number;
  threshold: number;
  pass: boolean;
  factors: TrustFactor[];
  gaps: TrustFactor[];
  computedAt: number;
}

export function computeTrust(input: TrustInput): TrustScore {
  const active = input.credentials.filter((c) => c.status === 'active');

  const identityEarned = (input.identitySealed ? 10 : 0) + (input.identityAnchored ? 5 : 0);
  const identity: TrustFactor = {
    id: 'identity',
    label: 'Identity',
    earned: identityEarned,
    max: 15,
    detail: !input.identitySealed
      ? 'No sealed identity statement'
      : input.identityAnchored
        ? 'Identity statement sealed and anchored'
        : 'Identity statement sealed, not yet anchored',
    ...(identityEarned < 15
      ? {
          action: {
            label: input.identitySealed ? 'Anchor your identity statement' : 'Seal your identity statement',
            tab: 'identity' as const,
            pointsAvailable: 15 - identityEarned,
          },
        }
      : {}),
  };

  const credCount = active.length;
  const credEarned = credCount >= 3 ? 45 : credCount === 2 ? 35 : credCount === 1 ? 25 : 0;
  const credentials: TrustFactor = {
    id: 'credentials',
    label: 'Verified credentials held',
    earned: credEarned,
    max: 45,
    detail: `${credCount} active credential${credCount === 1 ? '' : 's'}`,
    ...(credEarned < 45
      ? {
          action: {
            label: credCount === 0 ? 'Earn your first credential' : `Earn ${3 - credCount} more`,
            tab: 'certify' as const,
            pointsAvailable: 45 - credEarned,
          },
        }
      : {}),
  };

  const domains = new Set<CredentialDomain>(active.map((c) => c.domain));
  const diversityEarned = domains.size >= 3 ? 10 : domains.size === 2 ? 5 : 0;
  const diversity: TrustFactor = {
    id: 'diversity',
    label: 'Domain diversity',
    earned: diversityEarned,
    max: 10,
    detail: `${domains.size} domain${domains.size === 1 ? '' : 's'}: ${domains.size ? [...domains].join(', ') : 'none'}`,
    ...(diversityEarned < 10
      ? {
          action: {
            label:
              domains.size < 2
                ? 'Earn a credential in a second domain (AI, finance, or engineering)'
                : 'Earn a credential in a third domain',
            tab: 'certify' as const,
            pointsAvailable: 10 - diversityEarned,
          },
        }
      : {}),
  };

  const proofEarned = input.proofCount >= 5 ? 10 : input.proofCount >= 3 ? 6 : input.proofCount >= 1 ? 3 : 0;
  const evidence: TrustFactor = {
    id: 'evidence',
    label: 'Anchored evidence',
    earned: proofEarned,
    max: 10,
    detail: `${input.proofCount} active proof${input.proofCount === 1 ? '' : 's'}`,
    ...(proofEarned < 10
      ? {
          action: {
            label: `Anchor ${input.proofCount < 3 ? '3' : '5'} proofs`,
            tab: 'proofs' as const,
            pointsAvailable: 10 - proofEarned,
          },
        }
      : {}),
  };

  const humanReviewed = active.some((c) => c.humanReviewed);
  const postQuantum = active.some((c) => c.postQuantum);
  const qualityEarned = (humanReviewed ? 10 : 0) + (postQuantum ? 5 : 0);
  const quality: TrustFactor = {
    id: 'quality',
    label: 'Quality signals',
    earned: qualityEarned,
    max: 15,
    detail: [
      humanReviewed ? '✓ human-reviewed' : 'no human-reviewed credential',
      postQuantum ? '✓ post-quantum signed' : 'no post-quantum signature',
    ].join(' · '),
    ...(qualityEarned < 15
      ? {
          action: {
            label: !humanReviewed ? 'Earn a credential that triggers human review' : 'Earn a post-quantum signed credential',
            tab: 'certify' as const,
            pointsAvailable: 15 - qualityEarned,
          },
        }
      : {}),
  };

  const integrityEarned = input.revokedProofCount === 0 ? 5 : 0;
  const integrity: TrustFactor = {
    id: 'integrity',
    label: 'Integrity',
    earned: integrityEarned,
    max: 5,
    detail:
      input.revokedProofCount === 0
        ? 'No revoked proofs'
        : `${input.revokedProofCount} revoked proof${input.revokedProofCount === 1 ? '' : 's'}`,
  };

  const factors = [identity, credentials, diversity, evidence, quality, integrity];
  const total = Math.min(100, factors.reduce((sum, f) => sum + f.earned, 0));
  const gaps = factors
    .filter((f) => f.earned < f.max && f.action)
    .sort((a, b) => (b.action?.pointsAvailable ?? 0) - (a.action?.pointsAvailable ?? 0));

  return { total, threshold: TRUST_THRESHOLD, pass: total >= TRUST_THRESHOLD, factors, gaps, computedAt: Date.now() };
}

export async function loadTrust(address: string): Promise<TrustScore> {
  const vault = getVault();
  let proofs: Awaited<ReturnType<typeof vault.list>> = [];
  try {
    proofs = await vault.list(address);
  } catch {
    /* empty on read failure — scored as zero evidence, not an error state */
  }

  const activeProofs = proofs.filter((p) => !p.revoked);
  const revokedProofs = proofs.filter((p) => p.revoked);

  const identitySealed = localStorage.getItem('codexz99.identity.sealed') === '1';
  const identityAnchored = localStorage.getItem('codexz99.identity.anchored') === '1';

  return computeTrust({
    credentials: listCredentials(),
    proofCount: activeProofs.length,
    revokedProofCount: revokedProofs.length,
    identitySealed,
    identityAnchored,
  });
}

/** Anchor a hash of the score at a point in time — a counterparty can
 * verify "this account scored >= threshold on date X" without seeing
 * which factors contributed. */
export async function anchorTrustSnapshot(score: TrustScore): Promise<{ proofId: string; txHash: string; contentHash: string }> {
  const body = JSON.stringify({
    total: score.total,
    threshold: score.threshold,
    pass: score.pass,
    factors: score.factors.map((f) => ({ id: f.id, earned: f.earned, max: f.max })),
    computedAt: score.computedAt,
  });
  const contentHash = await sha256Hex(body);
  const vault = getVault();
  const { proofId, txHash } = await vault.anchor(
    contentHash,
    `urn:trust-score:${score.total}`,
    `Trust score ${score.total}/100 · ${score.pass ? 'eligible' : 'ineligible'}`,
  );
  return { proofId, txHash, contentHash };
}
