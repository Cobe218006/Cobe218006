/**
 * Local record of credentials this browser holds (issued to the user,
 * imported, or self-attested). The divinity score (lib/divinity.ts) reads
 * from here. This is a convenience index, not a source of truth — the
 * actual credential JSON (`raw`) is what a verifier checks.
 */
const KEY = 'codexz99.credentials.v1';
const EVENT = 'codexz99:credentials:changed';

export type CredentialDomain = 'defi' | 'ai' | 'finance' | 'engineering' | 'other';

export interface HeldCredential {
  id: string;
  type: string; // 'AssessedSkillCredential' | 'SelfAttestedCovenant' | 'EntitlementCredential'
  label: string;
  domain: CredentialDomain;
  issuedAt: number;
  status: 'active' | 'redeemed' | 'revoked';
  humanReviewed: boolean;
  postQuantum: boolean;
  proofId?: string;
  raw: unknown;
}

function read(): HeldCredential[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

function write(items: HeldCredential[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event(EVENT));
}

export function listCredentials(): HeldCredential[] {
  return read();
}

export function recordCredential(c: HeldCredential): void {
  const items = read();
  const i = items.findIndex((x) => x.id === c.id);
  if (i === -1) items.unshift(c);
  else items[i] = c;
  write(items);
}

export function updateCredentialStatus(id: string, status: HeldCredential['status']): void {
  const items = read();
  const i = items.findIndex((x) => x.id === id);
  if (i === -1) return;
  items[i] = { ...items[i], status };
  write(items);
}

export function onCredentialsChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
