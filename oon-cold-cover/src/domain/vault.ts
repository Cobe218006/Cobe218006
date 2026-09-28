import { z } from 'zod';
import { all, get, insert, tx, update, type DB } from '../db.js';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { conflict, invalid, notFound } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { subjectClaims } from './evidence.js';
import { evaluateJob, type JobRow } from './gates.js';
import { getJob, getJobRow, jobPods } from './jobs.js';
import { appendEvent, eventsFor, verifyLedger, type LedgerEvent } from './ledger.js';
import { requirePerm } from './permissions.js';
import { policyByVersion } from './policy.js';
import type { Actor } from './types.js';

export const HASH_DISCLAIMER =
  'The SHA-256 manifest hash shows only whether this manifest has changed since it was sealed. ' +
  'It does not prove that the recorded claims are true, that any event occurred as described, or that any legal or regulatory requirement is met. ' +
  'Verification status reflects reviewer decisions recorded in the system.';

export interface ManifestRow {
  id: string;
  job_id: string;
  version: number;
  supersedes_manifest_id: string | null;
  manifest_json: string;
  manifest_hash: string;
  last_event_hash: string;
  sealed_by: string;
  sealed_at: string;
  policy_version: number;
}

function firstAt(events: LedgerEvent[], type: string) {
  return events.find((e) => e.event_type === type)?.occurred_at ?? null;
}

/** Build the evidence manifest (snapshot) for a job from recorded data and ledger events. */
export function buildManifest(db: DB, job: JobRow, sealedBy: string, sealedAt: string, version: number, supersedes: string | null) {
  const events = eventsFor(db, 'job', job.id);
  const lastEvent = events.at(-1);
  const policy = policyByVersion(db, job.policy_version);
  const lastSet = [...events].reverse().find((e) => e.event_type === 'SET_PASSED');
  const dispatched = events.find((e) => e.event_type === 'DISPATCHED');
  const packet = dispatched ? (JSON.parse(dispatched.payload_json).packet as Record<string, unknown>) : null;
  // Gate results as recorded at dispatch (not recomputed under later data or policy).
  const dispatchEval = job.last_evaluation_json ? JSON.parse(job.last_evaluation_json) : null;
  const siteClaims = subjectClaims(db, 'job', job.id);
  const contact = siteClaims.find((c) => c.def.key === 'site.contact');
  const evidenceIds = new Set<string>();
  for (const e of events) for (const id of JSON.parse(e.evidence_reference_ids) as string[]) evidenceIds.add(id);
  const docs = all<{ id: string; sha256: string; category: string }>(db, 'SELECT id, sha256, category FROM documents WHERE job_id = ? ORDER BY uploaded_at', job.id);
  const pods = jobPods(db, job.id).map((p) => ({ id: p.id, receiverName: p.receiver_name, receivedAt: p.received_at, deliveredTempF: p.delivered_temp_f, documentIds: JSON.parse(String(p.document_ids_json)), recordedBy: p.recorded_by }));
  const reviewerIds = new Set<string>();
  for (const c of siteClaims) for (const h of c.history) if (h.status !== 'OPERATOR_ENTERED') reviewerIds.add(h.actor_id);
  const actorIds = new Set(events.map((e) => e.actor_user_id).filter((x): x is string => !!x));

  return {
    manifestVersion: version,
    supersedesManifestId: supersedes,
    jobId: job.id,
    quoteRef: job.quote_ref,
    customer: job.customer_name,
    pickup: { location: job.pickup_location, lat: job.pickup_lat, lng: job.pickup_lng },
    deliveryPin: { address: job.delivery_address, lat: job.delivery_lat, lng: job.delivery_lng },
    deliveryWindow: { start: job.window_start, end: job.window_end },
    ownerOperatorId: job.assigned_owner_operator_id,
    driverId: job.assigned_driver_id,
    truckId: job.assigned_truck_id,
    assetId: job.assigned_asset_id,
    powerConfigId: job.assigned_power_id,
    assetClass: (packet?.asset as { assetClass?: string } | undefined)?.assetClass ?? null,
    power: {
      requirement: (packet?.power as { required?: unknown } | undefined)?.required ?? null,
      siteStatus: job.site_power_status,
      site: { voltage: job.site_voltage, phase: job.site_phase, amperage: job.site_amperage, connector: job.site_connector },
      matchResultAtDispatch: dispatchEval?.power ?? null,
    },
    setpointF: job.setpoint_f,
    commodity: job.commodity,
    commodityNotes: job.commodity_notes,
    gateResultsAtDispatch: dispatchEval?.gates ?? null,
    jobStatusAtDispatch: dispatchEval?.status ?? null,
    evidenceReferences: [...evidenceIds].sort(),
    documents: docs.map((d) => ({ id: d.id, category: d.category, sha256: d.sha256 })),
    siteContact: {
      name: job.site_contact_name,
      confirmationState: contact?.status ?? 'MISSING',
      confirmedBy: contact?.status === 'VERIFIED' ? (contact.lastStatus?.actor_id ?? null) : null,
      confirmedAt: contact?.status === 'VERIFIED' ? (contact.lastStatus?.at ?? null) : null,
    },
    timestamps: {
      setPassedAt: lastSet?.occurred_at ?? null,
      dispatchedAt: job.dispatched_at ?? firstAt(events, 'DISPATCHED'),
      arrivedAt: job.arrived_at ?? firstAt(events, 'ARRIVED'),
      deliveredAt: job.delivered_at ?? firstAt(events, 'DELIVERED'),
      podRecordedAt: job.pod_recorded_at ?? firstAt(events, 'POD_RECORDED'),
      sealedAt,
    },
    pods,
    corrections: events
      .filter((e) => e.event_type === 'CORRECTION_RECORDED')
      .map((e) => ({ eventId: e.event_id, relatedEventId: e.related_event_id, payload: JSON.parse(e.payload_json), at: e.occurred_at })),
    operatorAndReviewerIds: { actors: [...actorIds].sort(), siteReviewers: [...reviewerIds].sort(), dispatchedBy: job.dispatched_by, sealedBy },
    policy: { version: policy.version, documentCode: policy.documentCode, configHash: policy.configHash },
    previousEvent: lastEvent ? { eventId: lastEvent.event_id, eventHash: lastEvent.event_hash } : null,
    eventCount: events.length,
  };
}

export function manifestsFor(db: DB, jobId: string): ManifestRow[] {
  return all<ManifestRow>(db, 'SELECT * FROM sealed_manifests WHERE job_id = ? ORDER BY version', jobId);
}

/**
 * Seal a job's evidence package. Creates a NEW sealed manifest; existing manifests
 * are never altered. After corrections, sealing again creates a supplemental manifest
 * that references (supersedes) the previous one while preserving it.
 */
export function sealJob(db: DB, actor: Actor, jobId: string) {
  requirePerm(actor, 'vault.seal');
  return tx(db, () => {
    const job = getJobRow(db, jobId);
    const prior = manifestsFor(db, jobId);
    const last = prior.at(-1) ?? null;
    if (!last && job.stage !== 'POD_RECORDED') throw conflict(`A job can be sealed after POD is recorded (stage is ${job.stage}).`);
    if (last) {
      const events = eventsFor(db, 'job', jobId);
      const sealEvt = events.find((e) => e.event_type.endsWith('SEALED') && JSON.parse(e.payload_json).manifestId === last.id);
      const after = events.filter((e) => sealEvt && e.seq > sealEvt.seq && e.event_type === 'CORRECTION_RECORDED');
      if (after.length === 0) throw conflict('Already sealed. Record a correction before creating a supplemental manifest.');
    }
    const id = newId('mfs');
    const sealedAt = nowIso();
    const version = (last?.version ?? 0) + 1;
    const manifest = buildManifest(db, job, actor.id, sealedAt, version, last?.id ?? null);
    const manifestHash = sha256Hex(canonicalJson(manifest));
    insert(db, 'sealed_manifests', {
      id,
      job_id: jobId,
      version,
      supersedes_manifest_id: last?.id ?? null,
      manifest_json: canonicalJson(manifest),
      manifest_hash: manifestHash,
      last_event_hash: manifest.previousEvent?.eventHash ?? '',
      sealed_by: actor.id,
      sealed_at: sealedAt,
      policy_version: job.policy_version,
    });
    if (!last) update(db, 'jobs', jobId, { stage: 'SEALED', sealed_at: sealedAt, updated_at: sealedAt });
    const evt = appendEvent(db, {
      entityType: 'job',
      entityId: jobId,
      eventType: last ? 'SUPPLEMENTAL_SEALED' : 'SEALED',
      actorId: actor.id,
      occurredAt: sealedAt,
      policyVersion: job.policy_version,
      payload: { manifestId: id, manifestVersion: version, manifestHash, supersedesManifestId: last?.id ?? null },
      evidenceRefs: [id],
    });
    return { manifest: get<ManifestRow>(db, 'SELECT * FROM sealed_manifests WHERE id = ?', id)!, event: evt };
  });
}

export const correctionSchema = z.object({
  field: z.string().trim().min(1).max(100),
  corrected_value: z.string().trim().max(1000),
  reason: z.string().trim().min(5).max(1000),
});

/** Corrections never edit earlier events or manifests; they are new linked events. */
export function recordCorrection(db: DB, actor: Actor, jobId: string, input: unknown) {
  requirePerm(actor, 'vault.correct');
  const r = correctionSchema.safeParse(input);
  if (!r.success) throw invalid('Validation failed.', r.error.flatten());
  return tx(db, () => {
    const job = getJobRow(db, jobId);
    if (['QUOTE', 'SPEC', 'SET'].includes(job.stage)) throw conflict('Before dispatch, update the job specification instead (changes are recorded as events).');
    const events = eventsFor(db, 'job', jobId);
    const lastSeal = [...events].reverse().find((e) => e.event_type === 'SEALED' || e.event_type === 'SUPPLEMENTAL_SEALED');
    return appendEvent(db, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'CORRECTION_RECORDED',
      actorId: actor.id,
      policyVersion: job.policy_version,
      payload: { ...r.data, correctsManifestId: lastSeal ? JSON.parse(lastSeal.payload_json).manifestId : null, note: 'Original records are preserved unchanged.' },
      relatedEventId: lastSeal?.event_id ?? events.at(-1)?.event_id ?? null,
    });
  });
}

export interface ManifestVerification {
  manifestId: string;
  storedHash: string;
  recomputedHash: string;
  manifestHashMatches: boolean;
  ledgerAnchorHash: string | null;
  ledgerAnchorMatches: boolean;
  ledgerChainIntact: boolean;
  ok: boolean;
  disclaimer: string;
}

/** Recompute the manifest hash and cross-check it against the SEALED ledger event and the ledger chain. */
export function verifyManifest(db: DB, manifestId: string): ManifestVerification {
  const m = get<ManifestRow>(db, 'SELECT * FROM sealed_manifests WHERE id = ?', manifestId);
  if (!m) throw notFound('Sealed manifest');
  const recomputed = sha256Hex(canonicalJson(JSON.parse(m.manifest_json)));
  const anchor = all<LedgerEvent>(db, `SELECT * FROM ledger_events WHERE entity_type = 'job' AND entity_id = ? AND event_type IN ('SEALED','SUPPLEMENTAL_SEALED')`, m.job_id).find(
    (e) => JSON.parse(e.payload_json).manifestId === m.id,
  );
  const anchorHash = anchor ? (JSON.parse(anchor.payload_json).manifestHash as string) : null;
  const chain = verifyLedger(db);
  const res = {
    manifestId,
    storedHash: m.manifest_hash,
    recomputedHash: recomputed,
    manifestHashMatches: recomputed === m.manifest_hash,
    ledgerAnchorHash: anchorHash,
    ledgerAnchorMatches: anchorHash === recomputed,
    ledgerChainIntact: chain.problems.length === 0,
    disclaimer: HASH_DISCLAIMER,
  };
  return { ...res, ok: res.manifestHashMatches && res.ledgerAnchorMatches && res.ledgerChainIntact };
}

export function verifyManifestFor(db: DB, actor: Actor, manifestId: string) {
  requirePerm(actor, 'vault.verify');
  return verifyManifest(db, manifestId);
}

/** Verify an exported package offline-style: recompute hash of the provided manifest vs. the provided hash (and the stored record, if present). */
export function verifyExportedPackage(db: DB, actor: Actor, pkg: unknown) {
  requirePerm(actor, 'vault.verify');
  const p = pkg as { manifest?: unknown; manifestHash?: string; manifestId?: string };
  if (!p || typeof p !== 'object' || !p.manifest || typeof p.manifestHash !== 'string') throw invalid('Package must include "manifest" and "manifestHash".');
  const recomputed = sha256Hex(canonicalJson(p.manifest));
  const stored = p.manifestId ? get<ManifestRow>(db, 'SELECT manifest_hash FROM sealed_manifests WHERE id = ?', p.manifestId) : undefined;
  return {
    recomputedHash: recomputed,
    providedHash: p.manifestHash,
    matchesProvidedHash: recomputed === p.manifestHash,
    matchesStoredRecord: stored ? stored.manifest_hash === recomputed : null,
    ok: recomputed === p.manifestHash && (stored ? stored.manifest_hash === recomputed : true),
    disclaimer: HASH_DISCLAIMER,
  };
}

export function exportPackage(db: DB, actor: Actor, jobId: string, manifestId?: string) {
  requirePerm(actor, 'vault.export');
  const job = getJob(db, actor, jobId);
  const manifests = manifestsFor(db, jobId);
  const m = manifestId ? manifests.find((x) => x.id === manifestId) : manifests.at(-1);
  if (!m) throw notFound('Sealed manifest');
  const events = eventsFor(db, 'job', jobId);
  appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'EVIDENCE_EXPORTED', actorId: actor.id, policyVersion: job.policy_version, payload: { manifestId: m.id } });
  return {
    exportedAt: nowIso(),
    exportedBy: actor.id,
    disclaimer: HASH_DISCLAIMER,
    hashAlgorithm: 'SHA-256 over canonical JSON (sorted keys, no whitespace)',
    manifestId: m.id,
    manifestVersion: m.version,
    supersedesManifestId: m.supersedes_manifest_id,
    manifestHash: m.manifest_hash,
    manifest: JSON.parse(m.manifest_json),
    verification: verifyManifest(db, m.id),
    jobSummary: { quoteRef: job.quote_ref, customer: job.customer_name, stage: job.stage, isDemo: !!job.is_demo },
    timeline: events.map((e) => ({ seq: e.seq, eventId: e.event_id, type: e.event_type, actor: e.actor_user_id, occurredAt: e.occurred_at, recordedAt: e.recorded_at, policyVersion: e.policy_version, payload: JSON.parse(e.payload_json), previousEventHash: e.previous_event_hash, eventHash: e.event_hash })),
  };
}

/** Live evaluation using the job's pinned policy (for comparing with the recorded decision). */
export function historicalDecisionCheck(db: DB, jobId: string) {
  const job = getJobRow(db, jobId);
  return evaluateJob(db, job, policyByVersion(db, job.policy_version));
}
