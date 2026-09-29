import { all, get, insert, tx, type DB } from '../db.js';
import { canonicalJson } from '../canonical.js';
import { conflict, forbidden, invalid, notFound } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { appendEvent } from './ledger.js';
import { can, hasRole, isTenantRestricted, requirePerm } from './permissions.js';
import { currentPolicy, policyByVersion } from './policy.js';
import type { Actor, EvidenceStatus, Gate, Role } from './types.js';

export type SubjectType = 'driver' | 'truck' | 'cold_asset' | 'power_config' | 'power_adapter' | 'job';

export interface ClaimDef {
  key: string;
  gate: Gate;
  subjectType: SubjectType;
  label: string;
  fields: string[];
  docCategory?: string;
}

/** Registry of evidence requirements. Each claim snapshots a group of entered fields. */
export const CLAIM_DEFS: ClaimDef[] = [
  { key: 'driver.license', gate: 'TRUCK', subjectType: 'driver', label: 'Driver license / qualification', fields: ['full_name', 'license_class', 'license_status', 'license_state', 'license_expires'], docCategory: 'LICENSE' },
  { key: 'truck.identity', gate: 'TRUCK', subjectType: 'truck', label: 'Truck identity (year/make/model/VIN)', fields: ['year', 'make', 'model', 'vin'] },
  { key: 'truck.weight_ratings', gate: 'TRUCK', subjectType: 'truck', label: 'Weight ratings (GVWR/GCWR/tow)', fields: ['gvwr_lbs', 'gcwr_lbs', 'tow_rating_lbs'] },
  { key: 'truck.hitch', gate: 'TRUCK', subjectType: 'truck', label: 'Hitch class / type', fields: ['hitch_class', 'hitch_type'] },
  { key: 'truck.registration', gate: 'TRUCK', subjectType: 'truck', label: 'Truck registration', fields: ['registration_state', 'registration_number', 'registration_expires'], docCategory: 'REGISTRATION' },
  { key: 'truck.auto_liability', gate: 'TRUCK', subjectType: 'truck', label: 'Commercial auto insurance (stated coverage)', fields: ['auto_liability_usd', 'insurance_effective', 'insurance_expires'], docCategory: 'INSURANCE_AUTO' },
  { key: 'truck.cargo_insurance', gate: 'TRUCK', subjectType: 'truck', label: 'Cargo insurance (stated coverage)', fields: ['cargo_coverage_usd', 'insurance_effective', 'insurance_expires'], docCategory: 'INSURANCE_CARGO' },
  { key: 'asset.identity', gate: 'ASSET', subjectType: 'cold_asset', label: 'Asset identity / registration', fields: ['asset_type', 'unit_id', 'registration_info'] },
  { key: 'asset.refrigeration', gate: 'ASSET', subjectType: 'cold_asset', label: 'Refrigeration unit & stated temperature capability', fields: ['reefer_make', 'reefer_model', 'stated_temp_min_f', 'stated_temp_max_f'] },
  { key: 'asset.transport', gate: 'ASSET', subjectType: 'cold_asset', label: 'Transport configuration (weight, required hitch)', fields: ['gross_weight_lbs', 'required_hitch_type'] },
  { key: 'asset.temp_logger', gate: 'ASSET', subjectType: 'cold_asset', label: 'Temperature logger', fields: ['temp_logger_details'], docCategory: 'TEMP_LOGGER' },
  { key: 'asset.security', gate: 'ASSET', subjectType: 'cold_asset', label: 'Security / lock hardware', fields: ['security_details'] },
  { key: 'asset.inspection', gate: 'ASSET', subjectType: 'cold_asset', label: 'Inspection record', fields: ['inspection_date'], docCategory: 'INSPECTION' },
  { key: 'asset.power_requirement', gate: 'POWER', subjectType: 'cold_asset', label: 'Reefer power requirement (V / phase / A / inlet)', fields: ['req_voltage_min', 'req_voltage_max', 'req_phase', 'req_amperage', 'inlet_connector', 'shore_power_capable'] },
  { key: 'power.generator', gate: 'POWER', subjectType: 'power_config', label: 'Generator (make/model, continuous kW, fuel plan)', fields: ['generator_make', 'generator_model', 'continuous_kw', 'fuel_notes'], docCategory: 'POWER_EVIDENCE' },
  { key: 'power.output', gate: 'POWER', subjectType: 'power_config', label: 'Generator output (V / phase / A / receptacle)', fields: ['voltage', 'phase', 'amperage', 'receptacle_connector'] },
  { key: 'power.adapter', gate: 'POWER', subjectType: 'power_adapter', label: 'Adapter (from → to, rating)', fields: ['from_connector', 'to_connector', 'rated_amperage', 'rated_voltage'] },
  { key: 'site.pickup', gate: 'SITE', subjectType: 'job', label: 'Pickup location', fields: ['pickup_location', 'pickup_lat', 'pickup_lng'] },
  { key: 'site.delivery_pin', gate: 'SITE', subjectType: 'job', label: 'Exact delivery pin', fields: ['delivery_address', 'delivery_lat', 'delivery_lng'] },
  { key: 'site.delivery_window', gate: 'SITE', subjectType: 'job', label: 'Delivery window', fields: ['window_start', 'window_end'] },
  { key: 'site.contact', gate: 'SITE', subjectType: 'job', label: 'Named site contact & direct contact method', fields: ['site_contact_name', 'site_contact_phone', 'site_contact_method'] },
  { key: 'site.access', gate: 'SITE', subjectType: 'job', label: 'Site access / clearance & cable run', fields: ['site_access_notes', 'cable_run_ft'] },
  { key: 'site.setpoint_commodity', gate: 'SITE', subjectType: 'job', label: 'Setpoint & commodity', fields: ['setpoint_f', 'commodity', 'commodity_notes'] },
  { key: 'site.power', gate: 'SITE', subjectType: 'job', label: 'Destination power', fields: ['site_power_status', 'site_voltage', 'site_phase', 'site_amperage', 'site_connector'] },
];

export const claimDef = (key: string) => {
  const d = CLAIM_DEFS.find((c) => c.key === key);
  if (!d) throw notFound(`Claim definition ${key}`);
  return d;
};

export interface ClaimRow {
  id: string;
  owner_operator_id: string | null;
  gate: Gate;
  subject_type: SubjectType;
  subject_id: string;
  claim_key: string;
  claimed_json: string;
  document_ids_json: string;
  supersedes_id: string | null;
  entered_by: string;
  entered_at: string;
  policy_version: number;
}

export interface StatusRow {
  id: string;
  claim_id: string;
  status: EvidenceStatus;
  actor_id: string;
  actor_role: string;
  note: string | null;
  basis: string | null;
  supporting_message_id: string | null;
  policy_version: number;
  at: string;
  seq: number;
}

export interface ClaimView {
  claim: ClaimRow;
  def: ClaimDef;
  values: Record<string, unknown>;
  documentIds: string[];
  status: EvidenceStatus;
  lastStatus: StatusRow | null;
  history: StatusRow[];
  enteredByName: string | null;
  reviewedByName: string | null;
}

export function activeClaim(db: DB, subjectType: string, subjectId: string, key: string): ClaimRow | undefined {
  return get<ClaimRow>(
    db,
    `SELECT c.* FROM evidence_claims c
     WHERE c.subject_type = ? AND c.subject_id = ? AND c.claim_key = ?
       AND NOT EXISTS (SELECT 1 FROM evidence_claims s WHERE s.supersedes_id = c.id)
     ORDER BY c.entered_at DESC, c.rowid DESC LIMIT 1`,
    subjectType,
    subjectId,
    key,
  );
}

export function claimById(db: DB, id: string): ClaimRow {
  const c = get<ClaimRow>(db, 'SELECT * FROM evidence_claims WHERE id = ?', id);
  if (!c) throw notFound('Evidence item');
  return c;
}

export function isSuperseded(db: DB, id: string): boolean {
  return !!get(db, 'SELECT 1 FROM evidence_claims WHERE supersedes_id = ?', id);
}

function statusHistory(db: DB, claimId: string): StatusRow[] {
  return all<StatusRow>(db, 'SELECT * FROM evidence_status_events WHERE claim_id = ? ORDER BY seq', claimId);
}

const userName = (db: DB, id: string | null | undefined) =>
  id ? (get<{ display_name: string }>(db, 'SELECT display_name FROM users WHERE id = ?', id)?.display_name ?? id) : null;

export function viewClaim(db: DB, claim: ClaimRow): ClaimView {
  const history = statusHistory(db, claim.id);
  const last = history.at(-1) ?? null;
  const reviewer = [...history].reverse().find((h) => h.status !== 'OPERATOR_ENTERED' && h.actor_id !== claim.entered_by);
  return {
    claim,
    def: claimDef(claim.claim_key),
    values: JSON.parse(claim.claimed_json),
    documentIds: JSON.parse(claim.document_ids_json),
    status: last?.status ?? 'OPERATOR_ENTERED',
    lastStatus: last,
    history,
    enteredByName: userName(db, claim.entered_by),
    reviewedByName: reviewer ? userName(db, reviewer.actor_id) : null,
  };
}

/** Active claims (views) for one subject, one per definition that has any claim. */
export function subjectClaims(db: DB, subjectType: SubjectType, subjectId: string): ClaimView[] {
  return CLAIM_DEFS.filter((d) => d.subjectType === subjectType)
    .map((d) => activeClaim(db, subjectType, subjectId, d.key))
    .filter((c): c is ClaimRow => !!c)
    .map((c) => viewClaim(db, c));
}

function nextStatusSeq(db: DB): number {
  return (get<{ s: number | null }>(db, 'SELECT MAX(seq) AS s FROM evidence_status_events')?.s ?? 0) + 1;
}

function ledgerEntityFor(claim: Pick<ClaimRow, 'subject_type' | 'subject_id' | 'owner_operator_id'>) {
  return claim.subject_type === 'job'
    ? { entityType: 'job', entityId: claim.subject_id }
    : { entityType: 'owner_operator', entityId: claim.owner_operator_id ?? 'unknown' };
}

function primaryRole(actor: Actor): Role {
  return actor.roles[0];
}

/**
 * Snapshot the evidence-bearing fields of a subject row into claims.
 * A new claim (superseding the previous one) is created only when values change.
 * Existing claims and their review history are never modified.
 */
export function syncClaimsFromRow(
  db: DB,
  actor: Actor,
  subjectType: SubjectType,
  subjectId: string,
  row: Record<string, unknown>,
  ownerOperatorId: string | null,
): ClaimRow[] {
  const policy = currentPolicy(db);
  const created: ClaimRow[] = [];
  for (const def of CLAIM_DEFS.filter((d) => d.subjectType === subjectType)) {
    const values: Record<string, unknown> = {};
    for (const f of def.fields) values[f] = row[f] ?? null;
    const hasAny = Object.values(values).some((v) => v !== null && v !== '');
    const prev = activeClaim(db, subjectType, subjectId, def.key);
    if (!prev && !hasAny) continue;
    if (prev && prev.claimed_json === canonicalJson(values)) continue;
    const docIds = prev ? (JSON.parse(prev.document_ids_json) as string[]) : [];
    created.push(createClaim(db, actor, def, subjectId, values, docIds, prev ?? null, ownerOperatorId, policy.version));
  }
  return created;
}

function createClaim(
  db: DB,
  actor: Actor,
  def: ClaimDef,
  subjectId: string,
  values: Record<string, unknown>,
  documentIds: string[],
  prev: ClaimRow | null,
  ownerOperatorId: string | null,
  policyVersion: number,
): ClaimRow {
  const id = newId('clm');
  const at = nowIso();
  insert(db, 'evidence_claims', {
    id,
    owner_operator_id: ownerOperatorId,
    gate: def.gate,
    subject_type: def.subjectType,
    subject_id: subjectId,
    claim_key: def.key,
    claimed_json: canonicalJson(values),
    document_ids_json: canonicalJson(documentIds),
    supersedes_id: prev?.id ?? null,
    entered_by: actor.id,
    entered_at: at,
    policy_version: policyVersion,
  });
  insert(db, 'evidence_status_events', {
    id: newId('evs'),
    claim_id: id,
    status: 'OPERATOR_ENTERED',
    actor_id: actor.id,
    actor_role: primaryRole(actor),
    note: prev ? 'Correction: values changed; previous entry preserved and superseded.' : null,
    basis: null,
    supporting_message_id: null,
    policy_version: policyVersion,
    at,
    seq: nextStatusSeq(db),
  });
  const claim = claimById(db, id);
  appendEvent(db, {
    ...ledgerEntityFor(claim),
    eventType: prev ? 'EVIDENCE_CORRECTED' : 'EVIDENCE_ENTERED',
    actorId: actor.id,
    policyVersion,
    payload: {
      claimId: id,
      claimKey: def.key,
      gate: def.gate,
      subjectType: def.subjectType,
      subjectId,
      supersedes: prev?.id ?? null,
      // Values are recorded as entered; they are NOT verified by being recorded.
      values: redactForLedger(def.key, values),
      documentIds,
    },
    evidenceRefs: [id, ...documentIds],
  });
  return claim;
}

/** Contact details are sensitive: keep the ledger payload free of direct phone numbers. */
function redactForLedger(key: string, values: Record<string, unknown>) {
  if (key === 'site.contact' && typeof values.site_contact_phone === 'string') {
    const p = values.site_contact_phone;
    return { ...values, site_contact_phone: p.length > 4 ? `***${p.slice(-4)}` : '***' };
  }
  return values;
}

export function assertOwnerOperatorAccess(actor: Actor, ownerOperatorId: string | null, write = false): void {
  if (isTenantRestricted(actor)) {
    if (!ownerOperatorId || actor.ownerOperatorId !== ownerOperatorId) throw notFound('Owner-operator');
    if (write) requirePerm(actor, 'profile.own.write');
    return;
  }
  if (write) {
    if (actor.ownerOperatorId === ownerOperatorId && hasRole(actor, 'OWNER_OPERATOR')) return;
    if (!can(actor, 'owner_operator.create')) throw forbidden('Only the owner-operator or an onboarding administrator may edit this profile.');
    return;
  }
  if (!can(actor, 'owner_operator.read_all') && actor.ownerOperatorId !== ownerOperatorId) throw notFound('Owner-operator');
}

/** Attaching a document creates a new claim version with the same values plus the document. */
export function attachDocumentToClaim(db: DB, actor: Actor, claimId: string, documentId: string): ClaimRow {
  return tx(db, () => {
    const claim = claimById(db, claimId);
    if (claim.subject_type === 'job') {
      if (!can(actor, 'job.manage') && !can(actor, 'job.progress')) throw forbidden();
    } else {
      assertOwnerOperatorAccess(actor, claim.owner_operator_id, true);
    }
    if (isSuperseded(db, claimId)) throw conflict('This evidence item has been superseded; attach to the current version.');
    const doc = get<{ id: string; owner_operator_id: string | null; job_id: string | null }>(db, 'SELECT id, owner_operator_id, job_id FROM documents WHERE id = ?', documentId);
    if (!doc) throw notFound('Document');
    const sameTenant = claim.subject_type === 'job' ? doc.job_id === claim.subject_id : doc.owner_operator_id === claim.owner_operator_id;
    if (!sameTenant) throw forbidden('Document does not belong to this record.');
    const docs = JSON.parse(claim.document_ids_json) as string[];
    if (docs.includes(documentId)) return claim;
    const policy = currentPolicy(db);
    return createClaim(db, actor, claimDef(claim.claim_key), claim.subject_id, JSON.parse(claim.claimed_json), [...docs, documentId], claim, claim.owner_operator_id, policy.version);
  });
}

/** Owner-operator (or dispatcher for site items) marks entered items as ready for review. Does not verify anything. */
export function submitForReview(db: DB, actor: Actor, claimIds: string[]): number {
  return tx(db, () => {
    const policy = currentPolicy(db);
    let n = 0;
    for (const id of claimIds) {
      const claim = claimById(db, id);
      if (claim.subject_type === 'job') {
        if (!can(actor, 'job.manage')) throw forbidden();
      } else {
        assertOwnerOperatorAccess(actor, claim.owner_operator_id, true);
      }
      if (isSuperseded(db, id)) continue;
      const v = viewClaim(db, claim);
      if (v.status !== 'OPERATOR_ENTERED' && v.status !== 'UNCONFIRMED') continue;
      insert(db, 'evidence_status_events', {
        id: newId('evs'),
        claim_id: id,
        status: 'PENDING',
        actor_id: actor.id,
        actor_role: primaryRole(actor),
        note: 'Submitted for review',
        basis: null,
        supporting_message_id: null,
        policy_version: policy.version,
        at: nowIso(),
        seq: nextStatusSeq(db),
      });
      appendEvent(db, {
        ...ledgerEntityFor(claim),
        eventType: 'EVIDENCE_SUBMITTED',
        actorId: actor.id,
        policyVersion: policy.version,
        payload: { claimId: id, claimKey: claim.claim_key },
        evidenceRefs: [id],
      });
      n++;
    }
    return n;
  });
}

export type ReviewDecision = 'VERIFIED' | 'UNCONFIRMED' | 'REJECTED' | 'PENDING';

export interface ReviewInput {
  decision: ReviewDecision;
  note?: string | null;
  basis?: string | null;
  supportingMessageId?: string | null;
}

/**
 * Record a reviewer decision as a NEW status event. The operator-entered claim
 * is never rewritten. Self-verification is rejected server-side.
 */
export function reviewClaim(db: DB, actor: Actor, claimId: string, input: ReviewInput): StatusRow {
  return tx(db, () => {
    const claim = claimById(db, claimId);
    const policy = currentPolicy(db);
    const rules = policy.config.reviewRules;
    let role: Role;
    if (claim.gate === 'SITE') {
      requirePerm(actor, 'site.verify');
      const allowedRole = actor.roles.find((r) => rules.siteVerifierRoles.includes(r));
      if (!allowedRole) throw forbidden('Your role is not configured to verify site evidence.');
      role = allowedRole;
      if (!rules.allowSameUserSiteConfirmation && claim.entered_by === actor.id)
        throw forbidden('Policy requires a different user to confirm site evidence you entered.');
    } else {
      // A dispatcher (or anyone else) needs the qualification-review permission.
      requirePerm(actor, 'evidence.review');
      role = 'QUALIFICATION_OFFICER';
      if (claim.entered_by === actor.id) throw forbidden('You cannot verify evidence you entered yourself.');
      if (actor.ownerOperatorId && actor.ownerOperatorId === claim.owner_operator_id)
        throw forbidden('You cannot review evidence for your own owner-operator business.');
    }
    if (isSuperseded(db, claimId)) throw conflict('This evidence item has been superseded by a newer entry; review the current version.');
    const note = input.note?.trim() || null;
    const basis = input.basis?.trim() || null;
    if (input.decision === 'REJECTED' && rules.requireNoteOnReject && !note) throw invalid('A reviewer note is required when rejecting evidence.');
    if (input.decision === 'VERIFIED') {
      const docs = JSON.parse(claim.document_ids_json) as string[];
      if (policy.config.documentRequirements[claim.claim_key] && docs.length === 0)
        throw invalid(`Policy v${policy.version} requires a supporting document before "${claim.claim_key}" can be verified.`);
      if (claim.claim_key === 'driver.license' && rules.requireBasisForDriverDecision && !basis)
        throw invalid('Record the basis for the driver qualification decision (e.g. which license class the reviewer determined is required and why).');
      const values = JSON.parse(claim.claimed_json) as Record<string, unknown>;
      const missing = claimDef(claim.claim_key).fields.filter((f) => values[f] === null || values[f] === '');
      const optional = new Set(['commodity_notes', 'registration_info', 'site_voltage', 'site_phase', 'site_amperage', 'site_connector', 'license_expires']);
      const reallyMissing = missing.filter((f) => !optional.has(f));
      if (reallyMissing.length) throw invalid(`Cannot verify an item with missing values: ${reallyMissing.join(', ')}. Mark it UNCONFIRMED instead.`);
    }
    if (input.supportingMessageId) {
      const msg = get<{ job_id: string }>(db, 'SELECT job_id FROM job_messages WHERE id = ?', input.supportingMessageId);
      if (!msg || claim.subject_type !== 'job' || msg.job_id !== claim.subject_id) throw invalid('Supporting message must belong to this job thread.');
    }
    const row = {
      id: newId('evs'),
      claim_id: claimId,
      status: input.decision,
      actor_id: actor.id,
      actor_role: role,
      note,
      basis,
      supporting_message_id: input.supportingMessageId ?? null,
      policy_version: policy.version,
      at: nowIso(),
      seq: nextStatusSeq(db),
    };
    insert(db, 'evidence_status_events', row);
    const humanConfirmed = claim.claim_key === 'site.contact' && input.decision === 'VERIFIED';
    appendEvent(db, {
      ...ledgerEntityFor(claim),
      eventType: humanConfirmed ? 'HUMAN_CONFIRMED' : `EVIDENCE_${input.decision}`,
      actorId: actor.id,
      policyVersion: policy.version,
      payload: { claimId, claimKey: claim.claim_key, gate: claim.gate, decision: input.decision, note, basis, reviewerRole: role, supportingMessageId: input.supportingMessageId ?? null },
      evidenceRefs: [claimId, ...(JSON.parse(claim.document_ids_json) as string[])],
    });
    return row as StatusRow;
  });
}

export function claimHistory(db: DB, subjectType: string, subjectId: string, key: string): ClaimView[] {
  return all<ClaimRow>(db, 'SELECT * FROM evidence_claims WHERE subject_type = ? AND subject_id = ? AND claim_key = ? ORDER BY entered_at, rowid', subjectType, subjectId, key).map((c) =>
    viewClaim(db, c),
  );
}

export function policyForClaim(db: DB, claim: ClaimRow) {
  return policyByVersion(db, claim.policy_version);
}
