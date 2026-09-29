import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { all, get, insert, tx, update, type DB } from '../db.js';
import { sha256Hex } from '../canonical.js';
import { config } from '../config.js';
import { AppError, forbidden, invalid, notFound } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { assertOwnerOperatorAccess } from './evidence.js';
import { appendEvent } from './ledger.js';
import { can, hasRole, isTenantRestricted, requirePerm } from './permissions.js';
import { currentPolicy } from './policy.js';
import type { Actor } from './types.js';

export const DOCUMENT_CATEGORIES = [
  'LICENSE',
  'REGISTRATION',
  'INSURANCE_AUTO',
  'INSURANCE_CARGO',
  'TEMP_LOGGER',
  'INSPECTION',
  'POWER_EVIDENCE',
  'SITE_EVIDENCE',
  'POD',
  'DELIVERY_EVIDENCE',
  'OTHER',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
const JOB_CATEGORIES = new Set<DocumentCategory>(['SITE_EVIDENCE', 'POD', 'DELIVERY_EVIDENCE']);

// ------------------------------------------------------------------ storage adapter
export interface StorageAdapter {
  readonly name: string;
  put(key: string, data: Buffer): void;
  get(key: string): Buffer;
  delete(key: string): void;
}

/** Private local filesystem storage (development). Files are never served statically. */
export class LocalPrivateStorage implements StorageAdapter {
  readonly name = 'local-private-filesystem';
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private resolve(key: string) {
    if (!/^[a-f0-9]{48}$/.test(key)) throw new Error('invalid storage key');
    return path.join(this.dir, key);
  }
  put(key: string, data: Buffer) {
    fs.writeFileSync(this.resolve(key), data, { mode: 0o600, flag: 'wx' });
  }
  get(key: string) {
    return fs.readFileSync(this.resolve(key));
  }
  delete(key: string) {
    fs.rmSync(this.resolve(key), { force: true });
  }
}

/** Placeholder for object storage (e.g. S3 with SSE + presigned GETs). NOT CONNECTED. */
export class NotConnectedObjectStorage implements StorageAdapter {
  readonly name = 'object-storage (not connected)';
  put(): void {
    throw new Error('Object storage is not connected. Configure an adapter before use.');
  }
  get(): Buffer {
    throw new Error('Object storage is not connected.');
  }
  delete(): void {
    throw new Error('Object storage is not connected.');
  }
}

// ------------------------------------------------------------------ type validation
const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
export const ALLOWED_MIME = SIGNATURES.map((s) => s.mime);

export function sniffMime(buf: Buffer): string | null {
  return SIGNATURES.find((s) => s.test(buf))?.mime ?? null;
}

export interface DocumentRow {
  id: string;
  owner_operator_id: string | null;
  job_id: string | null;
  category: DocumentCategory;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  uploaded_by: string;
  uploaded_at: string;
  retention_until: string | null;
  legal_hold: number;
  content_deleted_at: string | null;
  content_deleted_by: string | null;
  scan_status: string;
}

function jobAccess(db: DB, actor: Actor, jobId: string, write: boolean) {
  const job = get<{ assigned_owner_operator_id: string | null }>(db, 'SELECT assigned_owner_operator_id FROM jobs WHERE id = ?', jobId);
  if (!job) throw notFound('Job');
  if (isTenantRestricted(actor)) {
    if (!actor.ownerOperatorId || job.assigned_owner_operator_id !== actor.ownerOperatorId) throw notFound('Job');
    return;
  }
  if (write && !can(actor, 'job.manage') && !can(actor, 'job.progress')) throw forbidden();
}

export interface UploadInput {
  ownerOperatorId?: string | null;
  jobId?: string | null;
  category: string;
  filename: string;
  declaredMime?: string;
  data: Buffer;
}

export function uploadDocument(db: DB, storage: StorageAdapter, actor: Actor, input: UploadInput): DocumentRow {
  if (!DOCUMENT_CATEGORIES.includes(input.category as DocumentCategory)) throw invalid('Unknown document category.');
  const category = input.category as DocumentCategory;
  if (!input.data || input.data.length === 0) throw invalid('Empty file.');
  if (input.data.length > config.maxUploadBytes) throw invalid(`File exceeds ${config.maxUploadBytes} bytes.`);
  const sniffed = sniffMime(input.data);
  if (!sniffed) throw invalid(`Unsupported file type. Allowed: ${ALLOWED_MIME.join(', ')}.`);
  if (input.declaredMime && input.declaredMime !== 'application/octet-stream' && input.declaredMime !== sniffed)
    throw invalid(`Declared type ${input.declaredMime} does not match file content (${sniffed}).`);
  const filename = input.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';

  let ownerOperatorId = input.ownerOperatorId ?? null;
  const jobId = input.jobId ?? null;
  if (JOB_CATEGORIES.has(category)) {
    if (!jobId) throw invalid('This category must be attached to a job.');
    jobAccess(db, actor, jobId, true);
    ownerOperatorId = get<{ o: string | null }>(db, 'SELECT assigned_owner_operator_id o FROM jobs WHERE id = ?', jobId)?.o ?? null;
  } else {
    if (!ownerOperatorId) throw invalid('This category must be attached to an owner-operator.');
    assertOwnerOperatorAccess(actor, ownerOperatorId, true);
  }

  const policy = currentPolicy(db);
  const id = newId('doc');
  const key = randomBytes(24).toString('hex');
  const at = nowIso();
  const retention = new Date(Date.now() + policy.config.documentRetentionDays * 86_400_000).toISOString();
  const sha = sha256Hex(input.data);
  storage.put(key, input.data);
  try {
    return tx(db, () => {
      insert(db, 'documents', {
        id,
        owner_operator_id: ownerOperatorId,
        job_id: jobId,
        category,
        original_filename: filename,
        mime_type: sniffed,
        size_bytes: input.data.length,
        sha256: sha,
        storage_key: key,
        uploaded_by: actor.id,
        uploaded_at: at,
        retention_until: retention,
        scan_status: 'NOT_SCANNED',
      });
      appendEvent(db, {
        entityType: jobId ? 'job' : 'owner_operator',
        entityId: jobId ?? ownerOperatorId!,
        eventType: 'DOCUMENT_UPLOADED',
        actorId: actor.id,
        policyVersion: policy.version,
        // metadata only — never document contents
        payload: { documentId: id, category, mimeType: sniffed, sizeBytes: input.data.length, sha256: sha },
        evidenceRefs: [id],
      });
      return getDocumentRow(db, id);
    });
  } catch (e) {
    storage.delete(key);
    throw e;
  }
}

export function getDocumentRow(db: DB, id: string): DocumentRow {
  const d = get<DocumentRow>(db, 'SELECT * FROM documents WHERE id = ?', id);
  if (!d) throw notFound('Document');
  return d;
}

/** Central authorization rule for reading a private document. */
export function canReadDocument(db: DB, actor: Actor, doc: DocumentRow): boolean {
  if (hasRole(actor, 'QUALIFICATION_OFFICER') || hasRole(actor, 'READ_ONLY_AUDITOR')) return true;
  if (actor.ownerOperatorId && doc.owner_operator_id === actor.ownerOperatorId && hasRole(actor, 'OWNER_OPERATOR')) return true;
  if (doc.job_id) {
    if (hasRole(actor, 'DISPATCHER')) return true;
    if (hasRole(actor, 'FINANCE') && doc.category === 'POD') return true;
    if (hasRole(actor, 'OWNER_OPERATOR') && actor.ownerOperatorId) {
      const j = get<{ o: string | null }>(db, 'SELECT assigned_owner_operator_id o FROM jobs WHERE id = ?', doc.job_id);
      if (j?.o === actor.ownerOperatorId) return true;
    }
  }
  return false;
}

function logAccess(db: DB, docId: string, userId: string | null, action: string, granted: boolean, reason?: string) {
  insert(db, 'document_access_log', { id: newId('dal'), document_id: docId, user_id: userId, action, granted: granted ? 1 : 0, reason: reason ?? null, at: nowIso() });
}

/** Metadata listing respects the same read rule (no filenames leak across tenants). */
export function listDocuments(db: DB, actor: Actor, filter: { ownerOperatorId?: string; jobId?: string }): DocumentRow[] {
  const rows = filter.jobId
    ? all<DocumentRow>(db, 'SELECT * FROM documents WHERE job_id = ? ORDER BY uploaded_at', filter.jobId)
    : filter.ownerOperatorId
      ? all<DocumentRow>(db, 'SELECT * FROM documents WHERE owner_operator_id = ? AND job_id IS NULL ORDER BY uploaded_at', filter.ownerOperatorId)
      : [];
  return rows.filter((d) => canReadDocument(db, actor, d));
}

function sign(payload: string) {
  return createHmac('sha256', config.documentLinkSecret).update(payload).digest('base64url');
}

/** Issue a short-lived link bound to this user and document. Authorization is checked again on every read. */
export function issueDocumentLink(db: DB, actor: Actor, docId: string): { url: string; expiresAt: string } {
  const doc = get<DocumentRow>(db, 'SELECT * FROM documents WHERE id = ?', docId);
  if (!doc || !canReadDocument(db, actor, doc)) {
    logAccess(db, docId, actor.id, 'LINK_REQUEST', false, doc ? 'not permitted' : 'not found');
    throw notFound('Document');
  }
  if (doc.content_deleted_at) throw new AppError('CONFLICT', 'Document content was purged under the retention policy; metadata and hash are retained.');
  const exp = Math.floor(Date.now() / 1000) + config.documentLinkTtlSeconds;
  const payload = Buffer.from(JSON.stringify({ d: docId, u: actor.id, exp })).toString('base64url');
  logAccess(db, docId, actor.id, 'LINK_ISSUED', true);
  return { url: `/documents/${docId}/content?t=${payload}.${sign(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function readDocumentContent(db: DB, storage: StorageAdapter, actor: Actor, docId: string, token: string): { data: Buffer; mime: string; filename: string } {
  const deny = (reason: string): never => {
    logAccess(db, docId, actor.id, 'READ', false, reason);
    throw notFound('Document');
  };
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return deny('missing token');
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return deny('bad signature');
  let parsed: { d: string; u: string; exp: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return deny('malformed token');
  }
  if (parsed.d !== docId || parsed.u !== actor.id) return deny('token not bound to this user/document');
  if (parsed.exp < Math.floor(Date.now() / 1000)) return deny('link expired');
  const doc = get<DocumentRow>(db, 'SELECT * FROM documents WHERE id = ?', docId);
  if (!doc) return deny('not found');
  if (!canReadDocument(db, actor, doc)) return deny('not permitted');
  if (doc.content_deleted_at) return deny('content purged');
  const data = storage.get(doc.storage_key);
  if (sha256Hex(data) !== doc.sha256) {
    logAccess(db, docId, actor.id, 'READ', false, 'stored content hash mismatch');
    throw new AppError('CONFLICT', 'Stored document content does not match its recorded SHA-256. Access blocked; investigate storage integrity.');
  }
  logAccess(db, docId, actor.id, 'READ', true);
  return { data, mime: doc.mime_type, filename: doc.original_filename };
}

export function accessLog(db: DB, actor: Actor, docId: string) {
  if (!hasRole(actor, 'ADMIN') && !hasRole(actor, 'READ_ONLY_AUDITOR')) throw forbidden();
  return all(db, 'SELECT * FROM document_access_log WHERE document_id = ? ORDER BY at', docId);
}

export function setLegalHold(db: DB, actor: Actor, docId: string, hold: boolean, reason: string) {
  requirePerm(actor, 'retention.manage');
  if (!reason?.trim()) throw invalid('Reason required.');
  return tx(db, () => {
    const doc = getDocumentRow(db, docId);
    update(db, 'documents', docId, { legal_hold: hold ? 1 : 0 });
    appendEvent(db, { entityType: 'document', entityId: docId, eventType: hold ? 'LEGAL_HOLD_SET' : 'LEGAL_HOLD_RELEASED', actorId: actor.id, payload: { reason, sha256: doc.sha256 } });
  });
}

/**
 * Retention workflow: purge CONTENT of documents past their retention date, unless on
 * legal hold or referenced by a sealed Proof Vault manifest. Metadata (hash, size,
 * category, uploader, timestamps) and all ledger events are preserved.
 */
export function runRetention(db: DB, storage: StorageAdapter, actor: Actor, asOf = nowIso(), dryRun = false) {
  requirePerm(actor, 'retention.manage');
  const due = all<DocumentRow>(db, 'SELECT * FROM documents WHERE content_deleted_at IS NULL AND retention_until IS NOT NULL AND retention_until < ?', asOf);
  const purged: string[] = [];
  const retained: { id: string; reason: string }[] = [];
  for (const d of due) {
    if (d.legal_hold) {
      retained.push({ id: d.id, reason: 'legal hold' });
      continue;
    }
    const sealedRef = get(db, `SELECT 1 FROM sealed_manifests WHERE manifest_json LIKE ?`, `%${d.id}%`);
    if (sealedRef) {
      retained.push({ id: d.id, reason: 'referenced by a sealed Proof Vault manifest' });
      continue;
    }
    if (dryRun) {
      purged.push(d.id);
      continue;
    }
    tx(db, () => {
      update(db, 'documents', d.id, { content_deleted_at: nowIso(), content_deleted_by: actor.id });
      appendEvent(db, { entityType: 'document', entityId: d.id, eventType: 'DOCUMENT_CONTENT_PURGED', actorId: actor.id, payload: { sha256: d.sha256, retentionUntil: d.retention_until, category: d.category } });
    });
    storage.delete(d.storage_key);
    purged.push(d.id);
  }
  return { asOf, dryRun, purged, retained };
}
