import { all, insert, type DB } from '../db.js';
import { invalid } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { getJob } from './jobs.js';
import { appendEvent } from './ledger.js';
import { requirePerm } from './permissions.js';
import type { Actor } from './types.js';

/** Messages are communications, not verification evidence, unless a reviewer explicitly cites one in a review. */
export function listMessages(db: DB, actor: Actor, jobId: string) {
  getJob(db, actor, jobId);
  return all<{ id: string; job_id: string; author_id: string; body: string; created_at: string; author_name: string }>(
    db,
    'SELECT m.*, u.display_name AS author_name FROM job_messages m JOIN users u ON u.id = m.author_id WHERE job_id = ? ORDER BY m.created_at, m.rowid',
    jobId,
  );
}

export function postMessage(db: DB, actor: Actor, jobId: string, body: unknown) {
  requirePerm(actor, 'message.post');
  const job = getJob(db, actor, jobId);
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length < 1 || text.length > 2000) throw invalid('Message must be 1–2000 characters.');
  const id = newId('msg');
  insert(db, 'job_messages', { id, job_id: jobId, author_id: actor.id, body: text, created_at: nowIso() });
  appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'MESSAGE_POSTED', actorId: actor.id, policyVersion: job.policy_version, payload: { messageId: id, length: text.length } });
  return id;
}
