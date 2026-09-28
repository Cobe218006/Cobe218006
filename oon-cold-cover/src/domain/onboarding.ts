import { z } from 'zod';
import { all, get, insert, tx, update, type DB } from '../db.js';
import { forbidden, invalid, notFound } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { assertOwnerOperatorAccess, submitForReview, subjectClaims, syncClaimsFromRow, type ClaimView, type SubjectType } from './evidence.js';
import { currentClaimIdsForSignoff, gateReviewHistory, subjectGateStatus, type SubjectGateResult } from './gates.js';
import { appendEvent } from './ledger.js';
import { can, isTenantRestricted, requirePerm } from './permissions.js';
import { currentPolicy, type PolicyConfig } from './policy.js';
import type { Actor, Gate } from './types.js';

// ------------------------------------------------------------------ validation helpers
const blankToNull = (v: unknown) => (v === '' || v === undefined ? null : typeof v === 'string' ? v.trim() : v);
const optStr = (max = 200) => z.preprocess(blankToNull, z.string().max(max).nullable());
const optInt = (min: number, max: number) => z.preprocess(blankToNull, z.coerce.number().int().min(min).max(max).nullable());
const optNum = (min: number, max: number) => z.preprocess(blankToNull, z.coerce.number().min(min).max(max).nullable());
const optDate = z.preprocess(blankToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').nullable());
const optEnum = <T extends [string, ...string[]]>(vals: T) => z.preprocess(blankToNull, z.enum(vals).nullable());
const optBool = z.preprocess((v) => (v === '' || v === undefined || v === null ? null : v === true || v === 'true' || v === 'on' || v === '1' ? true : v === false || v === 'false' || v === '0' ? false : v), z.boolean().nullable());

export const HITCH_TYPES = ['BALL_2_5_16', 'PINTLE', 'GOOSENECK', 'FIFTH_WHEEL', 'CONTAINER_CHASSIS'] as const;
export const LICENSE_STATUSES = ['VALID', 'SUSPENDED', 'EXPIRED', 'UNKNOWN'] as const;

export const ownerOperatorSchema = z.object({
  legal_name: z.preprocess(blankToNull, z.string().min(2).max(200)),
  contact_name: optStr(120),
  contact_phone: z.preprocess(blankToNull, z.string().regex(/^[+0-9 ().-]{7,25}$/, 'invalid phone').nullable()),
  contact_email: z.preprocess(blankToNull, z.string().email().max(200).nullable()),
  base_city: optStr(120),
  base_state: z.preprocess(blankToNull, z.string().regex(/^[A-Z]{2}$/, 'two-letter state code').nullable()),
  dot_number: z.preprocess(blankToNull, z.string().regex(/^\d{1,8}$/, 'digits only').nullable()),
  mc_number: z.preprocess(blankToNull, z.string().regex(/^\d{1,8}$/, 'digits only').nullable()),
});

export const driverSchema = z.object({
  full_name: z.preprocess(blankToNull, z.string().min(2).max(120)),
  license_class: optStr(20),
  license_status: optEnum([...LICENSE_STATUSES]),
  license_state: z.preprocess(blankToNull, z.string().regex(/^[A-Z]{2}$/).nullable()),
  license_expires: optDate,
});

export const truckSchema = z
  .object({
    label: z.preprocess(blankToNull, z.string().min(1).max(80)),
    year: optInt(1980, 2100),
    make: optStr(60),
    model: optStr(60),
    vin: z.preprocess((v) => (typeof v === 'string' ? blankToNull(v.toUpperCase()) : blankToNull(v)), z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'VIN must be 17 characters (no I, O, Q)').nullable()),
    gvwr_lbs: optInt(1000, 200000),
    gcwr_lbs: optInt(1000, 200000),
    tow_rating_lbs: optInt(0, 200000),
    hitch_class: optStr(20),
    hitch_type: optEnum([...HITCH_TYPES]),
    registration_state: z.preprocess(blankToNull, z.string().regex(/^[A-Z]{2}$/).nullable()),
    registration_number: optStr(40),
    registration_expires: optDate,
    auto_liability_usd: optInt(0, 100_000_000),
    cargo_coverage_usd: optInt(0, 100_000_000),
    insurance_effective: optDate,
    insurance_expires: optDate,
  })
  .superRefine((t, ctx) => {
    if (t.gvwr_lbs != null && t.gcwr_lbs != null && t.gcwr_lbs < t.gvwr_lbs) ctx.addIssue({ code: 'custom', path: ['gcwr_lbs'], message: 'GCWR must be ≥ GVWR' });
    if (t.insurance_effective && t.insurance_expires && t.insurance_expires <= t.insurance_effective) ctx.addIssue({ code: 'custom', path: ['insurance_expires'], message: 'expiration must be after effective date' });
  });

const powerReqFields = {
  req_voltage_min: optInt(100, 600),
  req_voltage_max: optInt(100, 600),
  req_phase: optEnum(['SINGLE', 'THREE']),
  req_amperage: optInt(1, 400),
  inlet_connector: optStr(40),
  shore_power_capable: optBool,
};

export const assetSchema = (p: PolicyConfig) =>
  z
    .object({
      asset_type: z.preprocess(blankToNull, z.string().refine((v) => p.asset.permittedAssetClasses.some((c) => c.code === v), 'asset type is not a configured class')),
      unit_id: z.preprocess(blankToNull, z.string().min(1).max(40)),
      reefer_make: optStr(60),
      reefer_model: optStr(60),
      stated_temp_min_f: optNum(-60, 80),
      stated_temp_max_f: optNum(-60, 80),
      gross_weight_lbs: optInt(0, 100000),
      required_hitch_type: optEnum([...HITCH_TYPES]),
      temp_logger_details: optStr(500),
      security_details: optStr(500),
      inspection_date: optDate,
      registration_info: optStr(200),
      ...powerReqFields,
    })
    .superRefine((a, ctx) => {
      if (a.stated_temp_min_f != null && a.stated_temp_max_f != null && a.stated_temp_min_f >= a.stated_temp_max_f) ctx.addIssue({ code: 'custom', path: ['stated_temp_max_f'], message: 'max must be above min' });
      if (a.req_voltage_min != null && a.req_voltage_max != null && a.req_voltage_min > a.req_voltage_max) ctx.addIssue({ code: 'custom', path: ['req_voltage_max'], message: 'max voltage must be ≥ min' });
      if (a.inlet_connector && !p.power.connectorCatalog.some((c) => c.code === a.inlet_connector)) ctx.addIssue({ code: 'custom', path: ['inlet_connector'], message: 'connector is not in the configured catalog' });
    });

export const powerSchema = (p: PolicyConfig) =>
  z
    .object({
      label: z.preprocess(blankToNull, z.string().min(1).max(80)),
      generator_make: optStr(60),
      generator_model: optStr(60),
      continuous_kw: optNum(0, 500),
      fuel_notes: optStr(500),
      voltage: optInt(100, 600),
      phase: optEnum(['SINGLE', 'THREE']),
      amperage: optInt(1, 400),
      receptacle_connector: optStr(40),
    })
    .superRefine((g, ctx) => {
      if (g.receptacle_connector && !p.power.connectorCatalog.some((c) => c.code === g.receptacle_connector)) ctx.addIssue({ code: 'custom', path: ['receptacle_connector'], message: 'connector is not in the configured catalog' });
    });

export const adapterSchema = (p: PolicyConfig) =>
  z
    .object({
      power_config_id: optStr(40),
      from_connector: z.string().min(1),
      to_connector: z.string().min(1),
      rated_amperage: optInt(1, 400),
      rated_voltage: optInt(100, 600),
      description: optStr(300),
    })
    .superRefine((a, ctx) => {
      for (const k of ['from_connector', 'to_connector'] as const)
        if (!p.power.connectorCatalog.some((c) => c.code === a[k])) ctx.addIssue({ code: 'custom', path: [k], message: 'connector is not in the configured catalog' });
      if (a.from_connector === a.to_connector) ctx.addIssue({ code: 'custom', path: ['to_connector'], message: 'adapter must change connector type' });
    });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw invalid('Validation failed.', r.error.flatten());
  return r.data;
}

// ------------------------------------------------------------------ owner-operators
export interface OwnerOperatorRow {
  id: string;
  legal_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  base_city: string | null;
  base_state: string | null;
  dot_number: string | null;
  mc_number: string | null;
  submitted_at: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export function getOwnerOperator(db: DB, actor: Actor, id: string): OwnerOperatorRow {
  assertOwnerOperatorAccess(actor, id);
  const r = get<OwnerOperatorRow>(db, 'SELECT * FROM owner_operators WHERE id = ?', id);
  if (!r) throw notFound('Owner-operator');
  return r;
}

export function listOwnerOperators(db: DB, actor: Actor): OwnerOperatorRow[] {
  if (isTenantRestricted(actor)) return actor.ownerOperatorId ? all<OwnerOperatorRow>(db, 'SELECT * FROM owner_operators WHERE id = ?', actor.ownerOperatorId) : [];
  requirePerm(actor, 'owner_operator.read_all');
  return all<OwnerOperatorRow>(db, 'SELECT * FROM owner_operators ORDER BY legal_name');
}

export function createOwnerOperator(db: DB, actor: Actor, input: unknown, opts: { isDemo?: boolean } = {}): OwnerOperatorRow {
  const allowedSelf = isTenantRestricted(actor) && !actor.ownerOperatorId;
  if (!allowedSelf) requirePerm(actor, 'owner_operator.create');
  const data = parse(ownerOperatorSchema, input);
  return tx(db, () => {
    const id = newId('oo');
    const at = nowIso();
    insert(db, 'owner_operators', { id, ...data, is_demo: opts.isDemo ? 1 : 0, created_by: actor.id, created_at: at, updated_at: at });
    if (allowedSelf) {
      update(db, 'users', actor.id, { owner_operator_id: id });
      actor.ownerOperatorId = id;
    }
    appendEvent(db, { entityType: 'owner_operator', entityId: id, eventType: 'OWNER_OPERATOR_CREATED', actorId: actor.id, policyVersion: currentPolicy(db).version, payload: { legalName: data.legal_name, isDemo: !!opts.isDemo } });
    return get<OwnerOperatorRow>(db, 'SELECT * FROM owner_operators WHERE id = ?', id)!;
  });
}

export function updateOwnerOperator(db: DB, actor: Actor, id: string, input: unknown): OwnerOperatorRow {
  assertOwnerOperatorAccess(actor, id, true);
  const data = parse(ownerOperatorSchema, input);
  return tx(db, () => {
    const before = getOwnerOperator(db, actor, id);
    const changed = Object.keys(data).filter((k) => (before as unknown as Record<string, unknown>)[k] !== (data as Record<string, unknown>)[k]);
    update(db, 'owner_operators', id, { ...data, updated_at: nowIso() });
    if (changed.length) appendEvent(db, { entityType: 'owner_operator', entityId: id, eventType: 'PROFILE_UPDATED', actorId: actor.id, policyVersion: currentPolicy(db).version, payload: { changedFields: changed } });
    return getOwnerOperator(db, actor, id);
  });
}

// ------------------------------------------------------------------ subjects (driver, truck, asset, power, adapter)
const TABLES: Record<Exclude<SubjectType, 'job'>, string> = {
  driver: 'drivers',
  truck: 'trucks',
  cold_asset: 'cold_assets',
  power_config: 'power_configs',
  power_adapter: 'power_adapters',
};

export function subjectOwner(db: DB, subjectType: SubjectType, id: string): string {
  if (subjectType === 'job') throw invalid('Jobs are not onboarding subjects');
  const r = get<{ owner_operator_id: string }>(db, `SELECT owner_operator_id FROM ${TABLES[subjectType]} WHERE id = ?`, id);
  if (!r) throw notFound(subjectType.replace('_', ' '));
  return r.owner_operator_id;
}

function schemaFor(subjectType: Exclude<SubjectType, 'job'>, p: PolicyConfig): z.ZodType<Record<string, unknown>> {
  switch (subjectType) {
    case 'driver':
      return driverSchema as z.ZodType<Record<string, unknown>>;
    case 'truck':
      return truckSchema as z.ZodType<Record<string, unknown>>;
    case 'cold_asset':
      return assetSchema(p) as z.ZodType<Record<string, unknown>>;
    case 'power_config':
      return powerSchema(p) as z.ZodType<Record<string, unknown>>;
    case 'power_adapter':
      return adapterSchema(p) as z.ZodType<Record<string, unknown>>;
  }
}

/** Create or update an onboarding subject. Changed evidence-bearing values become new (unverified) claims. */
export function saveSubject(db: DB, actor: Actor, subjectType: Exclude<SubjectType, 'job'>, ownerOperatorId: string, id: string | null, input: unknown): Record<string, unknown> {
  assertOwnerOperatorAccess(actor, ownerOperatorId, true);
  const policy = currentPolicy(db);
  const data = parse(schemaFor(subjectType, policy.config), input);
  const table = TABLES[subjectType];
  return tx(db, () => {
    if (!get(db, 'SELECT 1 FROM owner_operators WHERE id = ?', ownerOperatorId)) throw notFound('Owner-operator');
    if (subjectType === 'power_adapter' && data.power_config_id) {
      if (subjectOwner(db, 'power_config', String(data.power_config_id)) !== ownerOperatorId) throw forbidden('Power configuration belongs to another owner-operator.');
    }
    const at = nowIso();
    let rowId = id;
    if (rowId) {
      if (subjectOwner(db, subjectType, rowId) !== ownerOperatorId) throw notFound(subjectType);
      update(db, table, rowId, subjectType === 'power_adapter' ? data : { ...data, updated_at: at });
    } else {
      rowId = newId(subjectType === 'cold_asset' ? 'ast' : subjectType === 'power_config' ? 'pwr' : subjectType === 'power_adapter' ? 'adp' : subjectType === 'truck' ? 'trk' : 'drv');
      insert(db, table, { id: rowId, owner_operator_id: ownerOperatorId, ...data, created_at: at, ...(subjectType === 'power_adapter' ? {} : { updated_at: at }) });
      appendEvent(db, { entityType: 'owner_operator', entityId: ownerOperatorId, eventType: `${subjectType.toUpperCase()}_ADDED`, actorId: actor.id, policyVersion: policy.version, payload: { subjectType, subjectId: rowId } });
    }
    const row = get<Record<string, unknown>>(db, `SELECT * FROM ${table} WHERE id = ?`, rowId)!;
    syncClaimsFromRow(db, actor, subjectType, rowId, row, ownerOperatorId);
    return row;
  });
}

export function submitOnboarding(db: DB, actor: Actor, ownerOperatorId: string): number {
  assertOwnerOperatorAccess(actor, ownerOperatorId, true);
  return tx(db, () => {
    const ids = all<{ id: string }>(
      db,
      `SELECT c.id FROM evidence_claims c WHERE c.owner_operator_id = ? AND c.subject_type != 'job'
       AND NOT EXISTS (SELECT 1 FROM evidence_claims s WHERE s.supersedes_id = c.id)`,
      ownerOperatorId,
    ).map((r) => r.id);
    const n = submitForReview(db, actor, ids);
    update(db, 'owner_operators', ownerOperatorId, { submitted_at: nowIso(), updated_at: nowIso() });
    appendEvent(db, { entityType: 'owner_operator', entityId: ownerOperatorId, eventType: 'ONBOARDING_SUBMITTED', actorId: actor.id, policyVersion: currentPolicy(db).version, payload: { itemsSubmitted: n } });
    return n;
  });
}

/** Qualification officer sign-off for one gate on one subject. The review references the exact claim ids it covers. */
export function recordGateReview(db: DB, actor: Actor, gate: Gate, subjectType: SubjectType, subjectId: string, decision: 'VERIFIED' | 'FAILED', note: string) {
  requirePerm(actor, 'gate.review');
  if (gate === 'SITE') throw invalid('SITE is evaluated per job from verified site evidence.');
  const owner = subjectOwner(db, subjectType, subjectId);
  if (actor.ownerOperatorId && actor.ownerOperatorId === owner) throw forbidden('You cannot review your own owner-operator business.');
  if (!note || note.trim().length < 3) throw invalid('A reviewer note is required for gate decisions.');
  return tx(db, () => {
    const policy = currentPolicy(db);
    const status = subjectGateStatus(db, policy, gate, subjectType, subjectId);
    if (decision === 'VERIFIED' && !status.readyForSignoff)
      throw invalid('Gate cannot be verified until all required evidence is verified and policy thresholds are met.', status.reasons);
    const row = {
      id: newId('grv'),
      gate,
      subject_type: subjectType,
      subject_id: subjectId,
      decision,
      reviewer_id: actor.id,
      note: note.trim(),
      policy_version: policy.version,
      claim_ids_json: currentClaimIdsForSignoff(db, policy, gate, subjectType, subjectId),
      at: nowIso(),
      seq: (get<{ s: number | null }>(db, 'SELECT MAX(seq) s FROM gate_reviews')?.s ?? 0) + 1,
    };
    insert(db, 'gate_reviews', row);
    appendEvent(db, {
      entityType: 'owner_operator',
      entityId: owner,
      eventType: `GATE_${decision}`,
      actorId: actor.id,
      policyVersion: policy.version,
      payload: { gate, subjectType, subjectId, decision, note: row.note },
      evidenceRefs: JSON.parse(row.claim_ids_json),
    });
    return row;
  });
}

// ------------------------------------------------------------------ bundle / progress
export interface SubjectBundle {
  subjectType: SubjectType;
  row: Record<string, unknown>;
  gates: SubjectGateResult[];
  claims: ClaimView[];
  gateHistory: ReturnType<typeof gateReviewHistory>;
}

const GATES_FOR: Record<Exclude<SubjectType, 'job'>, Gate[]> = {
  driver: ['TRUCK'],
  truck: ['TRUCK'],
  cold_asset: ['ASSET', 'POWER'],
  power_config: ['POWER'],
  power_adapter: ['POWER'],
};

export function ownerOperatorBundle(db: DB, actor: Actor, id: string) {
  const oo = getOwnerOperator(db, actor, id);
  const policy = currentPolicy(db);
  const subjects = (st: Exclude<SubjectType, 'job'>): SubjectBundle[] =>
    all<Record<string, unknown>>(db, `SELECT * FROM ${TABLES[st]} WHERE owner_operator_id = ? ORDER BY created_at`, id).map((row) => ({
      subjectType: st,
      row,
      gates: st === 'power_adapter' ? [] : GATES_FOR[st].map((g) => subjectGateStatus(db, policy, g, st, String(row.id))),
      claims: subjectClaims(db, st, String(row.id)),
      gateHistory: gateReviewHistory(db, st, String(row.id)),
    }));
  const drivers = subjects('driver');
  const trucks = subjects('truck');
  const assets = subjects('cold_asset');
  const powers = subjects('power_config');
  const adapters = subjects('power_adapter');
  const allClaims = [...drivers, ...trucks, ...assets, ...powers, ...adapters].flatMap((s) => s.claims);
  const missing: string[] = [];
  if (!oo.contact_name || !oo.contact_phone || !oo.contact_email) missing.push('Primary contact name, phone and email');
  if (!oo.base_city || !oo.base_state) missing.push('Operating base city/state');
  if (drivers.length === 0) missing.push('At least one driver');
  if (trucks.length === 0) missing.push('At least one truck');
  if (assets.length === 0) missing.push('At least one cold asset');
  for (const s of [...drivers, ...trucks, ...assets, ...powers])
    for (const g of s.gates) for (const k of g.missingKeys) missing.push(`${String(s.row.label ?? s.row.unit_id ?? s.row.full_name)}: ${k}`);
  for (const c of allClaims) {
    const need = policy.config.documentRequirements[c.def.key];
    if (need && c.documentIds.length === 0) missing.push(`${c.def.label}: supporting document required by policy`);
    const empty = c.def.fields.filter((f) => c.values[f] === null);
    if (empty.length) missing.push(`${c.def.label}: not provided — ${empty.join(', ')}`);
  }
  const verified = allClaims.filter((c) => c.status === 'VERIFIED').length;
  return {
    ownerOperator: oo,
    policy,
    drivers,
    trucks,
    assets,
    powers,
    adapters,
    progress: { totalItems: allClaims.length, verifiedItems: verified, pendingItems: allClaims.filter((c) => c.status === 'PENDING').length, missing },
    canEdit: (isTenantRestricted(actor) && actor.ownerOperatorId === id) || can(actor, 'owner_operator.create'),
  };
}
