import { z } from 'zod';
import { all, get, insert, tx, update, type DB } from '../db.js';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { syncClaimsFromRow, subjectClaims } from './evidence.js';
import { evaluateJob, type JobEvaluation, type JobRow } from './gates.js';
import { appendEvent, eventsFor } from './ledger.js';
import { subjectOwner } from './onboarding.js';
import { can, isTenantRestricted, requirePerm } from './permissions.js';
import { currentPolicy, policyByVersion, type PolicyConfig } from './policy.js';
import type { Actor, JobStage } from './types.js';

const blankToNull = (v: unknown) => (v === '' || v === undefined ? null : typeof v === 'string' ? v.trim() : v);
const optStr = (max: number) => z.preprocess(blankToNull, z.string().max(max).nullable());
const optNum = (min: number, max: number) => z.preprocess(blankToNull, z.coerce.number().min(min).max(max).nullable());
const optInt = (min: number, max: number) => z.preprocess(blankToNull, z.coerce.number().int().min(min).max(max).nullable());
const optDateTime = z.preprocess(
  (v) => {
    const b = blankToNull(v);
    if (typeof b !== 'string') return b;
    // accept <input type="datetime-local"> values (assumed UTC unless offset provided)
    const withZone = /[zZ]|[+-]\d{2}:\d{2}$/.test(b) ? b : `${b.length === 16 ? `${b}:00` : b}Z`;
    const t = Date.parse(withZone);
    return Number.isNaN(t) ? b : new Date(t).toISOString();
  },
  z.string().datetime({ message: 'use an ISO-8601 date/time' }).nullable(),
);

export const jobSpecSchema = (p: PolicyConfig) =>
  z
    .object({
      customer_name: z.preprocess(blankToNull, z.string().min(2).max(200)),
      required_asset_class: z.preprocess(blankToNull, z.string().refine((v) => p.asset.permittedAssetClasses.some((c) => c.code === v), 'not a configured asset class').nullable()),
      pickup_location: optStr(300),
      pickup_lat: optNum(-90, 90),
      pickup_lng: optNum(-180, 180),
      delivery_address: optStr(300),
      delivery_lat: optNum(-90, 90),
      delivery_lng: optNum(-180, 180),
      window_start: optDateTime,
      window_end: optDateTime,
      site_contact_name: optStr(120),
      site_contact_phone: z.preprocess(blankToNull, z.string().regex(/^[+0-9 ().-]{7,25}$/, 'invalid phone').nullable()),
      site_contact_method: optStr(200),
      site_access_notes: optStr(1000),
      cable_run_ft: optNum(0, 2000),
      setpoint_f: optNum(-60, 80),
      commodity: optStr(120),
      commodity_notes: optStr(500),
      site_power_status: z.preprocess(blankToNull, z.enum(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']).nullable()),
      site_voltage: optInt(100, 600),
      site_phase: z.preprocess(blankToNull, z.enum(['SINGLE', 'THREE']).nullable()),
      site_amperage: optInt(1, 400),
      site_connector: z.preprocess(blankToNull, z.string().refine((v) => p.power.connectorCatalog.some((c) => c.code === v), 'connector is not in the configured catalog').nullable()),
    })
    .superRefine((j, ctx) => {
      if (j.window_start && j.window_end && j.window_end <= j.window_start) ctx.addIssue({ code: 'custom', path: ['window_end'], message: 'window end must be after start' });
      if ((j.delivery_lat == null) !== (j.delivery_lng == null)) ctx.addIssue({ code: 'custom', path: ['delivery_lng'], message: 'provide both latitude and longitude' });
    });

const PRE_DISPATCH: JobStage[] = ['QUOTE', 'SPEC', 'SET'];

export function getJobRow(db: DB, id: string): JobRow {
  const j = get<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', id);
  if (!j) throw notFound('Job');
  return j;
}

/** Tenant-aware read. Owner-operators only see jobs assigned to them. */
export function getJob(db: DB, actor: Actor, id: string): JobRow {
  const j = get<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', id);
  if (!j) throw notFound('Job');
  if (isTenantRestricted(actor)) {
    if (!actor.ownerOperatorId || j.assigned_owner_operator_id !== actor.ownerOperatorId) throw notFound('Job');
  } else requirePerm(actor, 'job.read_all');
  return j;
}

export function listJobs(db: DB, actor: Actor): JobRow[] {
  if (isTenantRestricted(actor)) return actor.ownerOperatorId ? all<JobRow>(db, 'SELECT * FROM jobs WHERE assigned_owner_operator_id = ? ORDER BY created_at DESC', actor.ownerOperatorId) : [];
  requirePerm(actor, 'job.read_all');
  return all<JobRow>(db, 'SELECT * FROM jobs ORDER BY created_at DESC');
}

function parseSpec(db: DB, job: Pick<JobRow, 'policy_version'> | null, input: unknown) {
  const p = job ? policyByVersion(db, job.policy_version) : currentPolicy(db);
  const r = jobSpecSchema(p.config).safeParse(input);
  if (!r.success) throw invalid('Validation failed.', r.error.flatten());
  return r.data;
}

function redact(field: string, v: unknown) {
  return field === 'site_contact_phone' && typeof v === 'string' ? `***${v.slice(-4)}` : v;
}

export function createJob(db: DB, actor: Actor, input: unknown, opts: { isDemo?: boolean } = {}): JobRow {
  requirePerm(actor, 'job.manage');
  const data = parseSpec(db, null, input);
  return tx(db, () => {
    const policy = currentPolicy(db);
    const id = newId('job');
    const count = get<{ n: number }>(db, 'SELECT COUNT(*) n FROM jobs')!.n + 1;
    const quoteRef = `Q-${new Date().getUTCFullYear()}-${String(count).padStart(4, '0')}-${id.slice(-4).toUpperCase()}`;
    const at = nowIso();
    const hasSpec = Object.entries(data).some(([k, v]) => k !== 'customer_name' && v != null);
    insert(db, 'jobs', { id, quote_ref: quoteRef, stage: hasSpec ? 'SPEC' : 'QUOTE', policy_version: policy.version, ...data, is_demo: opts.isDemo ? 1 : 0, created_by: actor.id, created_at: at, updated_at: at });
    appendEvent(db, { entityType: 'job', entityId: id, eventType: 'QUOTE_CREATED', actorId: actor.id, policyVersion: policy.version, payload: { quoteRef, customer: data.customer_name, policyVersion: policy.version } });
    if (hasSpec) appendEvent(db, { entityType: 'job', entityId: id, eventType: 'SPEC_RECORDED', actorId: actor.id, policyVersion: policy.version, payload: { fields: Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] != null) } });
    const job = getJobRow(db, id);
    syncClaimsFromRow(db, actor, 'job', id, job as unknown as Record<string, unknown>, null);
    return job;
  });
}

function invalidateSet(db: DB, actor: Actor, job: JobRow, why: string) {
  if (job.stage === 'SET') {
    update(db, 'jobs', job.id, { stage: 'SPEC' });
    appendEvent(db, { entityType: 'job', entityId: job.id, eventType: 'SET_INVALIDATED', actorId: actor.id, policyVersion: job.policy_version, payload: { reason: why } });
  }
}

export function updateJobSpec(db: DB, actor: Actor, jobId: string, input: unknown): JobRow {
  requirePerm(actor, 'job.manage');
  return tx(db, () => {
    const job = getJobRow(db, jobId);
    if (!PRE_DISPATCH.includes(job.stage as JobStage)) throw conflict('Job specification is locked after dispatch. Record a correction event instead.');
    const data = parseSpec(db, job, input);
    const before = job as unknown as Record<string, unknown>;
    const changes = Object.entries(data)
      .filter(([k, v]) => before[k] !== v)
      .map(([k, v]) => ({ field: k, before: redact(k, before[k]), after: redact(k, v) }));
    if (changes.length === 0) return job;
    update(db, 'jobs', jobId, { ...data, stage: job.stage === 'QUOTE' ? 'SPEC' : job.stage, updated_at: nowIso() });
    appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'SPEC_UPDATED', actorId: actor.id, policyVersion: job.policy_version, payload: { changes } });
    invalidateSet(db, actor, job, 'specification changed');
    const updated = getJobRow(db, jobId);
    syncClaimsFromRow(db, actor, 'job', jobId, updated as unknown as Record<string, unknown>, null);
    return updated;
  });
}

export const assignmentSchema = z.object({
  owner_operator_id: z.string().min(1),
  driver_id: z.preprocess(blankToNull, z.string().nullable()),
  truck_id: z.preprocess(blankToNull, z.string().nullable()),
  asset_id: z.preprocess(blankToNull, z.string().nullable()),
  power_id: z.preprocess(blankToNull, z.string().nullable()),
});

export function assignJob(db: DB, actor: Actor, jobId: string, input: unknown): JobRow {
  requirePerm(actor, 'job.manage');
  const r = assignmentSchema.safeParse(input);
  if (!r.success) throw invalid('Validation failed.', r.error.flatten());
  const a = r.data;
  return tx(db, () => {
    const job = getJobRow(db, jobId);
    if (!PRE_DISPATCH.includes(job.stage as JobStage)) throw conflict('Assignment is locked after dispatch.');
    if (!get(db, 'SELECT 1 FROM owner_operators WHERE id = ?', a.owner_operator_id)) throw notFound('Owner-operator');
    for (const [id, st] of [
      [a.driver_id, 'driver'],
      [a.truck_id, 'truck'],
      [a.asset_id, 'cold_asset'],
      [a.power_id, 'power_config'],
    ] as const) {
      if (id && subjectOwner(db, st, id) !== a.owner_operator_id) throw invalid(`${st} does not belong to the selected owner-operator.`);
    }
    update(db, 'jobs', jobId, {
      assigned_owner_operator_id: a.owner_operator_id,
      assigned_driver_id: a.driver_id,
      assigned_truck_id: a.truck_id,
      assigned_asset_id: a.asset_id,
      assigned_power_id: a.power_id,
      updated_at: nowIso(),
    });
    appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'ASSIGNED', actorId: actor.id, policyVersion: job.policy_version, payload: { ...a } });
    invalidateSet(db, actor, job, 'assignment changed');
    return getJobRow(db, jobId);
  });
}

/** Explicitly move an undispatched job to the current policy version. Never automatic. */
export function repinPolicy(db: DB, actor: Actor, jobId: string): JobRow {
  requirePerm(actor, 'job.manage');
  return tx(db, () => {
    const job = getJobRow(db, jobId);
    if (!PRE_DISPATCH.includes(job.stage as JobStage)) throw conflict('Policy version is fixed once a job is dispatched.');
    const cur = currentPolicy(db);
    if (cur.version === job.policy_version) return job;
    update(db, 'jobs', jobId, { policy_version: cur.version, updated_at: nowIso() });
    appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'POLICY_REPINNED', actorId: actor.id, policyVersion: cur.version, payload: { from: job.policy_version, to: cur.version } });
    invalidateSet(db, actor, job, 'policy version changed');
    return getJobRow(db, jobId);
  });
}

export function evaluate(db: DB, actor: Actor, jobId: string): JobEvaluation {
  const job = getJob(db, actor, jobId);
  return evaluateJob(db, job, policyByVersion(db, job.policy_version));
}

const summarize = (e: JobEvaluation) => ({
  status: e.status,
  siteUnconfirmed: e.siteUnconfirmed,
  gates: Object.fromEntries(Object.values(e.gates).map((g) => [g.gate, g.status])),
  reasons: e.reasons.filter((r) => r.severity !== 'INFO').map((r) => ({ code: r.code, severity: r.severity, gate: r.gate, message: r.message })),
  power: { result: e.power.result, source: e.power.source, adapterUsed: e.power.adapterUsed },
  policyVersion: e.policyVersion,
  evaluatedAt: e.evaluatedAt,
});

/**
 * SET attempt. Always recorded (SET_ATTEMPTED), whatever the outcome; blocked
 * attempts record the exact failing gates and, for site gaps, SITE_UNCONFIRMED.
 * Later information never erases an attempt — it only adds new events.
 */
export function attemptSet(db: DB, actor: Actor, jobId: string): JobEvaluation {
  requirePerm(actor, 'job.manage');
  return tx(db, () => {
    const job = getJobRow(db, jobId);
    if (!PRE_DISPATCH.includes(job.stage as JobStage)) throw conflict(`SET cannot be attempted from stage ${job.stage}.`);
    const policy = policyByVersion(db, job.policy_version);
    const ev = evaluateJob(db, job, policy);
    const s = summarize(ev);
    const attempt = appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'SET_ATTEMPTED', actorId: actor.id, policyVersion: policy.version, payload: s, evidenceRefs: ev.evidenceRefs });
    if (ev.siteUnconfirmed) {
      appendEvent(db, {
        entityType: 'job',
        entityId: jobId,
        eventType: 'SITE_UNCONFIRMED',
        actorId: actor.id,
        policyVersion: policy.version,
        payload: { reasons: ev.gates.SITE.reasons.map((r) => ({ code: r.code, message: r.message })) },
        relatedEventId: attempt.event_id,
      });
    }
    if (ev.status === 'GREEN') {
      update(db, 'jobs', jobId, { stage: 'SET', last_evaluation_json: JSON.stringify(s), updated_at: nowIso() });
      appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'SET_PASSED', actorId: actor.id, policyVersion: policy.version, payload: { status: 'GREEN' }, relatedEventId: attempt.event_id, evidenceRefs: ev.evidenceRefs });
    } else {
      update(db, 'jobs', jobId, { last_evaluation_json: JSON.stringify(s), updated_at: nowIso() });
      appendEvent(db, {
        entityType: 'job',
        entityId: jobId,
        eventType: 'SET_BLOCKED',
        actorId: actor.id,
        policyVersion: policy.version,
        payload: { status: ev.status, failedGates: Object.values(ev.gates).filter((g) => g.status !== 'VERIFIED').map((g) => ({ gate: g.gate, status: g.status })), reasonCodes: s.reasons.map((r) => r.code) },
        relatedEventId: attempt.event_id,
      });
    }
    return ev;
  });
}

export function jobPacket(db: DB, job: JobRow, ev: JobEvaluation) {
  const name = (table: string, id: string | null, col: string) => (id ? (get<Record<string, unknown>>(db, `SELECT ${col} AS v FROM ${table} WHERE id = ?`, id)?.v ?? null) : null);
  const siteClaims = subjectClaims(db, 'job', job.id);
  const contact = siteClaims.find((c) => c.def.key === 'site.contact');
  return {
    jobId: job.id,
    quoteRef: job.quote_ref,
    customer: job.customer_name,
    pickup: { location: job.pickup_location, lat: job.pickup_lat, lng: job.pickup_lng },
    delivery: { address: job.delivery_address, lat: job.delivery_lat, lng: job.delivery_lng },
    deliveryWindow: { start: job.window_start, end: job.window_end },
    ownerOperator: name('owner_operators', job.assigned_owner_operator_id, 'legal_name'),
    driver: { id: job.assigned_driver_id, name: name('drivers', job.assigned_driver_id, 'full_name') },
    truck: { id: job.assigned_truck_id, label: name('trucks', job.assigned_truck_id, 'label') },
    asset: { id: job.assigned_asset_id, unitId: name('cold_assets', job.assigned_asset_id, 'unit_id'), assetClass: name('cold_assets', job.assigned_asset_id, 'asset_type') },
    powerConfig: { id: job.assigned_power_id, label: name('power_configs', job.assigned_power_id, 'label') },
    truckAssetCompatibility: ev.gates.TRUCK.reasons.filter((r) => /HITCH|TOW|WEIGHT/.test(r.code)).map((r) => `${r.severity}: ${r.message}`),
    power: {
      required: job.assigned_asset_id ? (subjectClaims(db, 'cold_asset', job.assigned_asset_id).find((c) => c.def.key === 'asset.power_requirement')?.values ?? null) : null,
      siteStatus: job.site_power_status,
      site: { voltage: job.site_voltage, phase: job.site_phase, amperage: job.site_amperage, connector: job.site_connector },
      result: ev.power.result,
      source: ev.power.source,
      checks: ev.power.checks,
    },
    setpointF: job.setpoint_f,
    commodity: job.commodity,
    commodityNotes: job.commodity_notes,
    siteAccessNotes: job.site_access_notes,
    cableRunFt: job.cable_run_ft,
    siteContact: { name: job.site_contact_name, method: job.site_contact_method, confirmation: contact?.status ?? 'MISSING', confirmedBy: contact?.reviewedByName ?? null, confirmedAt: contact?.status === 'VERIFIED' ? contact.lastStatus?.at : null },
    gates: Object.values(ev.gates).map((g) => ({ gate: g.gate, status: g.status, reasons: g.reasons.map((r) => `${r.code}: ${r.message}`) })),
    status: ev.status,
    policyVersion: ev.policyVersion,
    evaluatedAt: ev.evaluatedAt,
    dispatchedBy: job.dispatched_by,
    dispatchedAt: job.dispatched_at,
  };
}

/**
 * Dispatch: server recomputes status. Only GREEN jobs that passed SET may be
 * dispatched, only by an actor holding job.dispatch. Refusals are recorded.
 */
export function dispatchJob(db: DB, actor: Actor, jobId: string) {
  requirePerm(actor, 'job.dispatch');
  const outcome = tx(db, () => {
    const job = getJobRow(db, jobId);
    const policy = policyByVersion(db, job.policy_version);
    if (job.stage !== 'SET') {
      appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'DISPATCH_REFUSED', actorId: actor.id, policyVersion: policy.version, payload: { reason: `stage is ${job.stage}; a passing SET is required` } });
      return { ok: false as const, error: new AppError('NOT_ELIGIBLE', `Job cannot be dispatched from stage ${job.stage}. A passing SET (GREEN) is required first.`) };
    }
    const ev = evaluateJob(db, job, policy);
    if (ev.status !== 'GREEN') {
      const s = summarize(ev);
      appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'DISPATCH_REFUSED', actorId: actor.id, policyVersion: policy.version, payload: { status: ev.status, reasonCodes: s.reasons.map((r) => r.code) } });
      update(db, 'jobs', jobId, { stage: 'SPEC', last_evaluation_json: JSON.stringify(s), updated_at: nowIso() });
      appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'SET_INVALIDATED', actorId: actor.id, policyVersion: policy.version, payload: { reason: `re-evaluation at dispatch returned ${ev.status}` } });
      return { ok: false as const, error: new AppError('NOT_ELIGIBLE', `Job is ${ev.status}; only GREEN jobs can be dispatched.`, s.reasons) };
    }
    const at = nowIso();
    const packet = { ...jobPacket(db, job, ev), dispatchedBy: actor.id, dispatchedAt: at };
    update(db, 'jobs', jobId, { stage: 'DISPATCHED', dispatched_at: at, dispatched_by: actor.id, last_evaluation_json: JSON.stringify(summarize(ev)), updated_at: at });
    const evt = appendEvent(db, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'DISPATCHED',
      actorId: actor.id,
      occurredAt: at,
      policyVersion: policy.version,
      payload: { packetHash: sha256Hex(canonicalJson(packet)), packet },
      evidenceRefs: ev.evidenceRefs,
    });
    return { ok: true as const, packet, event: evt };
  });
  if (!outcome.ok) throw outcome.error;
  return outcome;
}

function progressAccess(db: DB, actor: Actor, job: JobRow) {
  requirePerm(actor, 'job.progress');
  if (isTenantRestricted(actor) && job.assigned_owner_operator_id !== actor.ownerOperatorId) throw notFound('Job');
}

const optionalTime = (v: unknown) => {
  if (v === undefined || v === null || v === '') return nowIso();
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw invalid('Invalid timestamp.');
  if (t > Date.now() + 5 * 60_000) throw invalid('Timestamp cannot be in the future.');
  return new Date(t).toISOString();
};

export function markArrived(db: DB, actor: Actor, jobId: string, occurredAt?: unknown, note?: string) {
  return tx(db, () => {
    const job = getJobRow(db, jobId);
    progressAccess(db, actor, job);
    if (job.stage !== 'DISPATCHED') throw conflict(`Cannot record arrival from stage ${job.stage}.`);
    const at = optionalTime(occurredAt);
    update(db, 'jobs', jobId, { stage: 'ARRIVED', arrived_at: at, updated_at: nowIso() });
    appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'ARRIVED', actorId: actor.id, occurredAt: at, policyVersion: job.policy_version, payload: { note: note ?? null } });
    return getJobRow(db, jobId);
  });
}

export function markDelivered(db: DB, actor: Actor, jobId: string, occurredAt?: unknown, note?: string, loggedTempF?: unknown) {
  return tx(db, () => {
    const job = getJobRow(db, jobId);
    progressAccess(db, actor, job);
    if (job.stage !== 'ARRIVED') throw conflict(`Cannot record delivery from stage ${job.stage}.`);
    const at = optionalTime(occurredAt);
    const temp = loggedTempF === undefined || loggedTempF === '' || loggedTempF === null ? null : Number(loggedTempF);
    if (temp !== null && (!Number.isFinite(temp) || temp < -60 || temp > 120)) throw invalid('Logged temperature out of range.');
    update(db, 'jobs', jobId, { stage: 'DELIVERED', delivered_at: at, updated_at: nowIso() });
    appendEvent(db, { entityType: 'job', entityId: jobId, eventType: 'DELIVERED', actorId: actor.id, occurredAt: at, policyVersion: job.policy_version, payload: { note: note ?? null, operatorReportedTempF: temp } });
    return getJobRow(db, jobId);
  });
}

export const podSchema = z.object({
  receiver_name: z.string().trim().min(2).max(120),
  received_at: z.string().min(1),
  delivered_temp_f: z.preprocess(blankToNull, z.coerce.number().min(-60).max(120).nullable()),
  notes: z.preprocess(blankToNull, z.string().max(1000).nullable()),
  document_ids: z.array(z.string()).default([]),
});

export function recordPod(db: DB, actor: Actor, jobId: string, input: unknown) {
  const r = podSchema.safeParse(input);
  if (!r.success) throw invalid('Validation failed.', r.error.flatten());
  const p = r.data;
  return tx(db, () => {
    const job = getJobRow(db, jobId);
    progressAccess(db, actor, job);
    if (job.stage !== 'DELIVERED') throw conflict(`POD can be recorded only after delivery (stage is ${job.stage}).`);
    for (const d of p.document_ids) {
      const doc = get<{ job_id: string | null; category: string }>(db, 'SELECT job_id, category FROM documents WHERE id = ?', d);
      if (!doc || doc.job_id !== jobId) throw invalid('POD documents must be uploaded to this job.');
    }
    const at = optionalTime(p.received_at);
    const id = newId('pod');
    insert(db, 'pods', { id, job_id: jobId, receiver_name: p.receiver_name, received_at: at, delivered_temp_f: p.delivered_temp_f, notes: p.notes, document_ids_json: JSON.stringify(p.document_ids), recorded_by: actor.id, recorded_at: nowIso() });
    update(db, 'jobs', jobId, { stage: 'POD_RECORDED', pod_recorded_at: nowIso(), updated_at: nowIso() });
    appendEvent(db, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'POD_RECORDED',
      actorId: actor.id,
      occurredAt: at,
      policyVersion: job.policy_version,
      // Recording a POD documents what was submitted; it is not independent proof of delivery conditions.
      payload: { podId: id, receiverName: p.receiver_name, deliveredTempF: p.delivered_temp_f, documentIds: p.document_ids, notes: p.notes },
      evidenceRefs: [id, ...p.document_ids],
    });
    return get(db, 'SELECT * FROM pods WHERE id = ?', id);
  });
}

export function jobPods(db: DB, jobId: string) {
  return all<Record<string, unknown>>(db, 'SELECT * FROM pods WHERE job_id = ? ORDER BY recorded_at', jobId);
}

export function jobTimeline(db: DB, actor: Actor, jobId: string) {
  getJob(db, actor, jobId);
  return eventsFor(db, 'job', jobId);
}

export function canManageJobs(actor: Actor) {
  return can(actor, 'job.manage');
}

export function assertNotTenantForbidden(actor: Actor) {
  if (isTenantRestricted(actor)) throw forbidden();
}
