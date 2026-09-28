import { all, get, insert, type DB } from '../db.js';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { newId, nowIso } from '../ids.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface AppendInput {
  entityType: string;
  entityId: string;
  eventType: string;
  actorId: string | null;
  occurredAt?: string;
  policyVersion?: number | null;
  payload?: Record<string, unknown>;
  evidenceRefs?: string[];
  relatedEventId?: string | null;
}

export interface LedgerEvent {
  seq: number;
  event_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor_user_id: string | null;
  occurred_at: string;
  recorded_at: string;
  policy_version: number | null;
  payload_json: string;
  evidence_reference_ids: string;
  related_event_id: string | null;
  previous_event_hash: string;
  event_hash: string;
}

/**
 * EXACT fields included in each event hash (canonical JSON, see canonical.ts):
 *   event_id, entity_type, entity_id, event_type, actor_user_id, occurred_at,
 *   recorded_at, policy_version, payload (parsed JSON), evidence_reference_ids
 *   (array), related_event_id, previous_event_hash.
 * `seq` and `event_hash` itself are excluded.
 */
export function hashableEvent(e: Omit<LedgerEvent, 'seq' | 'event_hash'>) {
  return {
    event_id: e.event_id,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    event_type: e.event_type,
    actor_user_id: e.actor_user_id,
    occurred_at: e.occurred_at,
    recorded_at: e.recorded_at,
    policy_version: e.policy_version,
    payload: JSON.parse(e.payload_json),
    evidence_reference_ids: JSON.parse(e.evidence_reference_ids),
    related_event_id: e.related_event_id,
    previous_event_hash: e.previous_event_hash,
  };
}

export function computeEventHash(e: Omit<LedgerEvent, 'seq' | 'event_hash'>): string {
  return sha256Hex(canonicalJson(hashableEvent(e)));
}

/** Append one event to the global hash chain. Must be called inside the caller's transaction when combined with other writes. */
export function appendEvent(db: DB, input: AppendInput): LedgerEvent {
  const prev = get<{ event_hash: string }>(db, 'SELECT event_hash FROM ledger_events ORDER BY seq DESC LIMIT 1');
  const recordedAt = nowIso();
  const base = {
    event_id: newId('evt'),
    entity_type: input.entityType,
    entity_id: input.entityId,
    event_type: input.eventType,
    actor_user_id: input.actorId,
    occurred_at: input.occurredAt ?? recordedAt,
    recorded_at: recordedAt,
    policy_version: input.policyVersion ?? null,
    payload_json: canonicalJson(input.payload ?? {}),
    evidence_reference_ids: canonicalJson(input.evidenceRefs ?? []),
    related_event_id: input.relatedEventId ?? null,
    previous_event_hash: prev?.event_hash ?? GENESIS_HASH,
  };
  const event_hash = computeEventHash(base);
  insert(db, 'ledger_events', { ...base, event_hash });
  return get<LedgerEvent>(db, 'SELECT * FROM ledger_events WHERE event_hash = ?', event_hash)!;
}

export function eventsFor(db: DB, entityType: string, entityId: string): LedgerEvent[] {
  return all<LedgerEvent>(db, 'SELECT * FROM ledger_events WHERE entity_type = ? AND entity_id = ? ORDER BY seq', entityType, entityId);
}

export interface ChainProblem {
  seq: number;
  eventId: string;
  problem: 'HASH_MISMATCH' | 'CHAIN_BROKEN';
  expected: string;
  found: string;
}

/** Recompute every event hash and the chain links. Returns an empty list when the ledger is intact. */
export function verifyLedger(db: DB): { checked: number; problems: ChainProblem[] } {
  const rows = all<LedgerEvent>(db, 'SELECT * FROM ledger_events ORDER BY seq');
  const problems: ChainProblem[] = [];
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.previous_event_hash !== prev) {
      problems.push({ seq: r.seq, eventId: r.event_id, problem: 'CHAIN_BROKEN', expected: prev, found: r.previous_event_hash });
    }
    const recomputed = computeEventHash(r);
    if (recomputed !== r.event_hash) {
      problems.push({ seq: r.seq, eventId: r.event_id, problem: 'HASH_MISMATCH', expected: recomputed, found: r.event_hash });
    }
    prev = r.event_hash;
  }
  return { checked: rows.length, problems };
}
