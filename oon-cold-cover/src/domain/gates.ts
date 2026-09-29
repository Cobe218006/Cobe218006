import { all, get, type DB } from '../db.js';
import { canonicalJson } from '../canonical.js';
import { activeClaim, CLAIM_DEFS, subjectClaims, viewClaim, type ClaimView, type SubjectType } from './evidence.js';
import type { PolicyConfig, PolicyVersion } from './policy.js';
import { evaluatePower, type Adapter, type PowerMatch } from './power.js';
import type { EvidenceStatus, Gate, GateStatus, JobStatus, Phase, Reason } from './types.js';

export interface GateReviewRow {
  id: string;
  gate: Gate;
  subject_type: string;
  subject_id: string;
  decision: 'VERIFIED' | 'FAILED';
  reviewer_id: string;
  note: string;
  policy_version: number;
  claim_ids_json: string;
  at: string;
  seq: number;
}

export interface SubjectGateResult {
  gate: Gate;
  subjectType: SubjectType;
  subjectId: string;
  status: GateStatus;
  reasons: Reason[];
  claims: ClaimView[];
  missingKeys: string[];
  requiredKeys: string[];
  lastReview: GateReviewRow | null;
  /** true when every required item is verified and threshold checks pass; sign-off may still be pending */
  readyForSignoff: boolean;
}

export function requiredKeysFor(policy: PolicyConfig, gate: Gate, subjectType: SubjectType): string[] {
  const list = gate === 'ASSET' ? policy.asset.requiredClaims : gate === 'TRUCK' ? policy.truck.requiredClaims : gate === 'POWER' ? policy.power.requiredClaims : policy.site.requiredClaims;
  return CLAIM_DEFS.filter((d) => d.gate === gate && d.subjectType === subjectType && list.includes(d.key)).map((d) => d.key);
}

export function latestGateReview(db: DB, gate: Gate, subjectType: string, subjectId: string): GateReviewRow | null {
  return get<GateReviewRow>(db, 'SELECT * FROM gate_reviews WHERE gate = ? AND subject_type = ? AND subject_id = ? ORDER BY seq DESC LIMIT 1', gate, subjectType, subjectId) ?? null;
}

export function gateReviewHistory(db: DB, subjectType: string, subjectId: string): GateReviewRow[] {
  return all<GateReviewRow>(db, 'SELECT * FROM gate_reviews WHERE subject_type = ? AND subject_id = ? ORDER BY seq', subjectType, subjectId);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function daysBetween(aIso: string, bIso: string) {
  return (Date.parse(bIso) - Date.parse(aIso)) / 86_400_000;
}

/** Policy threshold / expiry checks against claimed values. These describe configured network thresholds, not legal compliance. */
function thresholdChecks(policy: PolicyConfig, gate: Gate, claims: ClaimView[], asOf: string): Reason[] {
  const out: Reason[] = [];
  const by = (k: string) => claims.find((c) => c.def.key === k)?.values;
  if (gate === 'TRUCK') {
    const auto = by('truck.auto_liability');
    const cargo = by('truck.cargo_insurance');
    const autoUsd = num(auto?.auto_liability_usd);
    if (autoUsd != null && autoUsd < policy.truck.minAutoLiabilityUsd)
      out.push({ code: 'AUTO_LIABILITY_BELOW_NETWORK_THRESHOLD', severity: 'RED', gate, message: `Stated commercial auto coverage $${autoUsd.toLocaleString()} does not meet the configured network threshold of $${policy.truck.minAutoLiabilityUsd.toLocaleString()}.` });
    const cargoUsd = num(cargo?.cargo_coverage_usd);
    if (cargoUsd != null && cargoUsd < policy.truck.minCargoCoverageUsd)
      out.push({ code: 'CARGO_BELOW_NETWORK_THRESHOLD', severity: 'RED', gate, message: `Stated cargo coverage $${cargoUsd.toLocaleString()} does not meet the configured network threshold of $${policy.truck.minCargoCoverageUsd.toLocaleString()}.` });
    for (const [label, v] of [['Insurance', str(auto?.insurance_expires) ?? str(cargo?.insurance_expires)], ['Registration', str(by('truck.registration')?.registration_expires)], ['Driver license', str(by('driver.license')?.license_expires)]] as const) {
      if (v && Date.parse(v) < Date.parse(asOf)) out.push({ code: `${label.toUpperCase().replace(' ', '_')}_EXPIRED`, severity: 'RED', gate, message: `${label} expired ${v} (checked as of ${asOf.slice(0, 10)}).` });
    }
    const lic = by('driver.license');
    if (lic && str(lic.license_status) && String(lic.license_status).toUpperCase() !== 'VALID')
      out.push({ code: 'DRIVER_LICENSE_NOT_VALID', severity: 'RED', gate, message: `Driver license status recorded as "${lic.license_status}".` });
  }
  if (gate === 'ASSET') {
    const ident = by('asset.identity');
    const assetType = str(ident?.asset_type);
    const cls = policy.asset.permittedAssetClasses.find((c) => c.code === assetType);
    if (assetType && !cls) out.push({ code: 'ASSET_CLASS_NOT_PERMITTED', severity: 'RED', gate, message: `Asset class ${assetType} is not permitted by the policy.` });
    const refr = by('asset.refrigeration');
    if (cls?.refrigerated && refr) {
      const min = num(refr.stated_temp_min_f);
      const max = num(refr.stated_temp_max_f);
      if (min != null && max != null && (min > policy.asset.requiredStatedTempMinF || max < policy.asset.requiredStatedTempMaxF))
        out.push({ code: 'STATED_TEMP_RANGE_INSUFFICIENT', severity: 'RED', gate, message: `Stated range ${min}°F to ${max}°F does not cover the configured ${policy.asset.requiredStatedTempMinF}°F to ${policy.asset.requiredStatedTempMaxF}°F. (A stated range is not proof of full-load performance.)` });
    }
    const insp = str(by('asset.inspection')?.inspection_date);
    if (insp && daysBetween(insp, asOf) > policy.asset.maxInspectionAgeDays)
      out.push({ code: 'INSPECTION_EXPIRED', severity: 'RED', gate, message: `Inspection dated ${insp} is older than ${policy.asset.maxInspectionAgeDays} days.` });
  }
  return out;
}

const EXPIRY_CODES = new Set(['INSURANCE_EXPIRED', 'REGISTRATION_EXPIRED', 'DRIVER_LICENSE_EXPIRED', 'INSPECTION_EXPIRED']);

/** Compute a gate status for one onboarding subject (truck, driver, cold asset, power config). */
export function subjectGateStatus(db: DB, policy: PolicyVersion, gate: Gate, subjectType: SubjectType, subjectId: string, asOf = new Date().toISOString()): SubjectGateResult {
  const required = requiredKeysFor(policy.config, gate, subjectType);
  const claims = subjectClaims(db, subjectType, subjectId).filter((c) => c.def.gate === gate);
  const reasons: Reason[] = [];
  const missing = required.filter((k) => !claims.some((c) => c.def.key === k));
  const lastReview = latestGateReview(db, gate, subjectType, subjectId);
  const base = { gate, subjectType, subjectId, claims, missingKeys: missing, requiredKeys: required, lastReview };

  if (claims.length === 0) {
    reasons.push({ code: `${gate}_NOT_STARTED`, severity: 'YELLOW', gate, message: `No ${gate.toLowerCase()} evidence has been entered for this ${subjectType.replace('_', ' ')}.` });
    return { ...base, status: 'NOT_STARTED', reasons, readyForSignoff: false };
  }
  for (const k of missing) reasons.push({ code: 'EVIDENCE_MISSING', severity: 'YELLOW', gate, message: `Missing: ${k}` });
  for (const c of claims.filter((c) => required.includes(c.def.key))) {
    if (c.status === 'REJECTED') reasons.push({ code: 'EVIDENCE_REJECTED', severity: 'RED', gate, message: `${c.def.label}: rejected${c.lastStatus?.note ? ` — ${c.lastStatus.note}` : ''}` });
    else if (c.status !== 'VERIFIED') reasons.push({ code: `EVIDENCE_${c.status}`, severity: 'YELLOW', gate, message: `${c.def.label}: ${c.status.replace('_', ' ').toLowerCase()}` });
  }
  const thresholds = thresholdChecks(policy.config, gate, claims, asOf);
  reasons.push(...thresholds);

  const hasRed = reasons.some((r) => r.severity === 'RED');
  if (hasRed) {
    const onlyExpiry = reasons.filter((r) => r.severity === 'RED').every((r) => EXPIRY_CODES.has(r.code));
    return { ...base, status: onlyExpiry ? 'EXPIRED' : 'FAILED', reasons, readyForSignoff: false };
  }
  if (reasons.length) return { ...base, status: 'PENDING_REVIEW', reasons, readyForSignoff: false };

  // All required evidence verified and thresholds met: a gate sign-off must cover exactly the current claims.
  const currentIds = canonicalJson(claims.filter((c) => required.includes(c.def.key)).map((c) => c.claim.id).sort());
  if (lastReview && lastReview.claim_ids_json === currentIds) {
    if (lastReview.decision === 'VERIFIED') return { ...base, status: 'VERIFIED', reasons, readyForSignoff: true };
    return { ...base, status: 'FAILED', reasons: [{ code: 'GATE_REVIEW_FAILED', severity: 'RED', gate, message: `Reviewer marked gate failed: ${lastReview.note}` }], readyForSignoff: true };
  }
  reasons.push({ code: 'GATE_SIGNOFF_PENDING', severity: 'YELLOW', gate, message: lastReview ? 'Evidence changed since the last gate sign-off; re-review required.' : 'Awaiting qualification officer gate sign-off.' });
  return { ...base, status: 'PENDING_REVIEW', reasons, readyForSignoff: true };
}

export function currentClaimIdsForSignoff(db: DB, policy: PolicyVersion, gate: Gate, subjectType: SubjectType, subjectId: string): string {
  const required = requiredKeysFor(policy.config, gate, subjectType);
  return canonicalJson(subjectClaims(db, subjectType, subjectId).filter((c) => c.def.gate === gate && required.includes(c.def.key)).map((c) => c.claim.id).sort());
}

// ---------------------------------------------------------------------------- job evaluation

export interface JobRow {
  id: string;
  quote_ref: string;
  stage: string;
  policy_version: number;
  customer_name: string;
  required_asset_class: string | null;
  pickup_location: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  delivery_address: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  window_start: string | null;
  window_end: string | null;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  site_contact_method: string | null;
  site_access_notes: string | null;
  cable_run_ft: number | null;
  setpoint_f: number | null;
  commodity: string | null;
  commodity_notes: string | null;
  site_power_status: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN' | null;
  site_voltage: number | null;
  site_phase: Phase | null;
  site_amperage: number | null;
  site_connector: string | null;
  assigned_owner_operator_id: string | null;
  assigned_driver_id: string | null;
  assigned_truck_id: string | null;
  assigned_asset_id: string | null;
  assigned_power_id: string | null;
  last_evaluation_json: string | null;
  dispatched_at: string | null;
  dispatched_by: string | null;
  arrived_at: string | null;
  delivered_at: string | null;
  pod_recorded_at: string | null;
  sealed_at: string | null;
  is_demo: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface GateSummary {
  gate: Gate;
  status: GateStatus;
  reasons: Reason[];
  subjects: { subjectType: SubjectType; subjectId: string; status: GateStatus }[];
}

export interface JobEvaluation {
  jobId: string;
  status: JobStatus;
  siteUnconfirmed: boolean;
  evaluatedAt: string;
  policyVersion: number;
  gates: Record<Gate, GateSummary>;
  reasons: Reason[];
  power: PowerMatch;
  evidenceRefs: string[];
}

const SITE_CODES: Record<string, string> = {
  'site.pickup': 'PICKUP',
  'site.delivery_pin': 'DELIVERY_PIN',
  'site.delivery_window': 'DELIVERY_WINDOW',
  'site.contact': 'CONTACT',
  'site.access': 'ACCESS',
  'site.setpoint_commodity': 'SETPOINT_COMMODITY',
  'site.power': 'POWER',
};

function worst(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('FAILED')) return 'FAILED';
  if (statuses.includes('EXPIRED')) return 'EXPIRED';
  if (statuses.includes('NOT_STARTED')) return statuses.every((s) => s === 'NOT_STARTED') ? 'NOT_STARTED' : 'PENDING_REVIEW';
  if (statuses.includes('PENDING_REVIEW')) return 'PENDING_REVIEW';
  return 'VERIFIED';
}

function gateFromReasons(reasons: Reason[], fallback: GateStatus): GateStatus {
  if (reasons.some((r) => r.severity === 'RED')) return fallback === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
  if (reasons.some((r) => r.severity === 'YELLOW')) return fallback === 'NOT_STARTED' ? 'NOT_STARTED' : 'PENDING_REVIEW';
  return 'VERIFIED';
}

const claimStatus = (db: DB, subjectType: SubjectType, id: string, key: string): { status: EvidenceStatus | 'MISSING'; values: Record<string, unknown>; claimId: string | null } => {
  const c = activeClaim(db, subjectType, id, key);
  if (!c) return { status: 'MISSING', values: {}, claimId: null };
  const v = viewClaim(db, c);
  return { status: v.status, values: v.values, claimId: c.id };
};

/**
 * Server-side job status. GREEN only when every applicable gate passes for this
 * specific job and assignment. Never accepts a client-supplied status.
 */
export function evaluateJob(db: DB, job: JobRow, policy: PolicyVersion, now = new Date().toISOString()): JobEvaluation {
  const reasons: Reason[] = [];
  const evidenceRefs: string[] = [];
  const asOf = job.window_end && job.window_end > now ? job.window_end : now;
  const P = policy.config;

  // ---- assignment
  const missingAssign = (
    [
      ['assigned_driver_id', 'driver'],
      ['assigned_truck_id', 'truck'],
      ['assigned_asset_id', 'cold asset'],
    ] as const
  ).filter(([k]) => !job[k]);
  for (const [, label] of missingAssign) reasons.push({ code: 'ASSIGNMENT_MISSING', severity: 'YELLOW', gate: 'ASSIGNMENT', message: `No ${label} assigned.` });
  const oo = job.assigned_owner_operator_id;
  for (const [col, table] of [
    ['assigned_driver_id', 'drivers'],
    ['assigned_truck_id', 'trucks'],
    ['assigned_asset_id', 'cold_assets'],
    ['assigned_power_id', 'power_configs'],
  ] as const) {
    const id = job[col];
    if (!id) continue;
    const r = get<{ owner_operator_id: string }>(db, `SELECT owner_operator_id FROM ${table} WHERE id = ?`, id);
    if (!r || r.owner_operator_id !== oo) reasons.push({ code: 'ASSIGNMENT_TENANT_MISMATCH', severity: 'RED', gate: 'ASSIGNMENT', message: `Assigned ${table.replace('_', ' ')} does not belong to the assigned owner-operator.` });
  }

  const collect = (r: SubjectGateResult) => {
    for (const c of r.claims) evidenceRefs.push(c.claim.id, ...c.documentIds);
    return r;
  };

  // ---- ASSET gate
  const assetReasons: Reason[] = [];
  const assetSubjects: GateSummary['subjects'] = [];
  let assetFallback: GateStatus = 'NOT_STARTED';
  if (job.assigned_asset_id) {
    const r = collect(subjectGateStatus(db, policy, 'ASSET', 'cold_asset', job.assigned_asset_id, asOf));
    assetSubjects.push({ subjectType: 'cold_asset', subjectId: job.assigned_asset_id, status: r.status });
    assetFallback = r.status;
    assetReasons.push(...r.reasons);
    const ident = claimStatus(db, 'cold_asset', job.assigned_asset_id, 'asset.identity').values;
    const refr = claimStatus(db, 'cold_asset', job.assigned_asset_id, 'asset.refrigeration').values;
    if (job.required_asset_class && ident.asset_type && ident.asset_type !== job.required_asset_class)
      assetReasons.push({ code: 'ASSET_CLASS_MISMATCH', severity: 'RED', gate: 'ASSET', message: `Job requires ${job.required_asset_class}; assigned asset is ${ident.asset_type}.` });
    if (!job.required_asset_class) assetReasons.push({ code: 'JOB_ASSET_CLASS_MISSING', severity: 'YELLOW', gate: 'ASSET', message: 'Job does not specify the required asset class.' });
    const min = num(refr.stated_temp_min_f);
    const max = num(refr.stated_temp_max_f);
    if (job.setpoint_f != null && min != null && max != null && (job.setpoint_f < min || job.setpoint_f > max))
      assetReasons.push({ code: 'SETPOINT_OUTSIDE_STATED_RANGE', severity: 'RED', gate: 'ASSET', message: `Setpoint ${job.setpoint_f}°F is outside the asset's stated range ${min}°F to ${max}°F.` });
  } else assetReasons.push({ code: 'ASSET_NOT_ASSIGNED', severity: 'YELLOW', gate: 'ASSET', message: 'No cold asset assigned.' });

  // ---- TRUCK gate (truck + driver)
  const truckReasons: Reason[] = [];
  const truckSubjects: GateSummary['subjects'] = [];
  const truckStatuses: GateStatus[] = [];
  for (const [col, st] of [
    ['assigned_truck_id', 'truck'],
    ['assigned_driver_id', 'driver'],
  ] as const) {
    const id = job[col];
    if (!id) {
      truckReasons.push({ code: `${st.toUpperCase()}_NOT_ASSIGNED`, severity: 'YELLOW', gate: 'TRUCK', message: `No ${st} assigned.` });
      truckStatuses.push('NOT_STARTED');
      continue;
    }
    const r = collect(subjectGateStatus(db, policy, 'TRUCK', st, id, asOf));
    truckSubjects.push({ subjectType: st, subjectId: id, status: r.status });
    truckStatuses.push(r.status);
    truckReasons.push(...r.reasons.map((x) => ({ ...x, message: `${st === 'truck' ? 'Truck' : 'Driver'}: ${x.message}` })));
  }
  if (job.assigned_truck_id && job.assigned_asset_id) {
    const tw = claimStatus(db, 'truck', job.assigned_truck_id, 'truck.weight_ratings').values;
    const th = claimStatus(db, 'truck', job.assigned_truck_id, 'truck.hitch').values;
    const at = claimStatus(db, 'cold_asset', job.assigned_asset_id, 'asset.transport').values;
    const tow = num(tw.tow_rating_lbs);
    const gross = num(at.gross_weight_lbs);
    if (tow == null || gross == null) truckReasons.push({ code: 'TRUCK_ASSET_WEIGHT_UNCONFIRMED', severity: 'YELLOW', gate: 'TRUCK', message: 'Truck tow rating or asset gross weight not provided; compatibility unconfirmed.' });
    else if (gross > tow) truckReasons.push({ code: 'TRUCK_TOW_RATING_EXCEEDED', severity: 'RED', gate: 'TRUCK', message: `Asset gross weight ${gross} lbs exceeds truck tow rating ${tow} lbs.` });
    const req = str(at.required_hitch_type);
    const have = str(th.hitch_type);
    if (!req || !have) truckReasons.push({ code: 'HITCH_COMPATIBILITY_UNCONFIRMED', severity: 'YELLOW', gate: 'TRUCK', message: 'Hitch type or asset hitch requirement not provided.' });
    else if (req !== have) truckReasons.push({ code: 'HITCH_MISMATCH', severity: 'RED', gate: 'TRUCK', message: `Asset requires ${req}; truck hitch is ${have}.` });
  }

  // ---- SITE gate (job-specific sub-requirements)
  const siteReasons: Reason[] = [];
  for (const key of requiredKeysFor(P, 'SITE', 'job')) {
    const code = SITE_CODES[key] ?? key.toUpperCase();
    const c = claimStatus(db, 'job', job.id, key);
    if (c.claimId) evidenceRefs.push(c.claimId);
    const label = CLAIM_DEFS.find((d) => d.key === key)!.label;
    if (c.status === 'MISSING') siteReasons.push({ code: `SITE_${code}_MISSING`, severity: 'YELLOW', gate: 'SITE', message: `${label}: not provided.` });
    else if (c.status === 'REJECTED') siteReasons.push({ code: `SITE_${code}_REJECTED`, severity: 'RED', gate: 'SITE', message: `${label}: rejected by reviewer.` });
    else if (c.status !== 'VERIFIED') siteReasons.push({ code: `SITE_${code}_UNCONFIRMED`, severity: 'YELLOW', gate: 'SITE', message: `${label}: ${c.status.replace('_', ' ').toLowerCase()}, not verified.` });
  }
  if (job.delivery_lat == null || job.delivery_lng == null) siteReasons.push({ code: 'SITE_DELIVERY_PIN_MISSING', severity: 'YELLOW', gate: 'SITE', message: 'Exact delivery coordinates are required.' });
  if (!job.window_start || !job.window_end) siteReasons.push({ code: 'SITE_DELIVERY_WINDOW_MISSING', severity: 'YELLOW', gate: 'SITE', message: 'Delivery window start and end are required.' });
  else if (job.window_end <= job.window_start) siteReasons.push({ code: 'SITE_DELIVERY_WINDOW_INVALID', severity: 'RED', gate: 'SITE', message: 'Delivery window ends before it starts.' });
  else if (['QUOTE', 'SPEC', 'SET'].includes(job.stage) && job.window_end < now) siteReasons.push({ code: 'SITE_DELIVERY_WINDOW_PASSED', severity: 'RED', gate: 'SITE', message: 'Delivery window has already ended.' });
  if (!job.site_contact_name || !(job.site_contact_phone || job.site_contact_method)) siteReasons.push({ code: 'SITE_CONTACT_MISSING', severity: 'YELLOW', gate: 'SITE', message: 'A named human site contact with a direct contact method is required.' });
  if (job.setpoint_f == null || !job.commodity) siteReasons.push({ code: 'SITE_SETPOINT_COMMODITY_MISSING', severity: 'YELLOW', gate: 'SITE', message: 'Target setpoint and commodity are required.' });
  else if (job.setpoint_f < P.asset.requiredStatedTempMinF || job.setpoint_f > P.asset.requiredStatedTempMaxF)
    siteReasons.push({ code: 'SETPOINT_OUTSIDE_NETWORK_RANGE', severity: 'RED', gate: 'SITE', message: `Setpoint ${job.setpoint_f}°F is outside the network range ${P.asset.requiredStatedTempMinF}°F to ${P.asset.requiredStatedTempMaxF}°F.` });
  // de-duplicate by code
  const siteDedup = siteReasons.filter((r, i) => siteReasons.findIndex((x) => x.code === r.code) === i);

  // ---- POWER gate
  const reqC = job.assigned_asset_id ? claimStatus(db, 'cold_asset', job.assigned_asset_id, 'asset.power_requirement') : { status: 'MISSING' as const, values: {} as Record<string, unknown>, claimId: null };
  const siteP = claimStatus(db, 'job', job.id, 'site.power');
  const siteA = claimStatus(db, 'job', job.id, 'site.access');
  let genPresent = false;
  let genGate: SubjectGateResult | null = null;
  let genValues: Record<string, unknown> = {};
  if (job.assigned_power_id) {
    genPresent = true;
    genGate = collect(subjectGateStatus(db, policy, 'POWER', 'power_config', job.assigned_power_id, asOf));
    genValues = { ...claimStatus(db, 'power_config', job.assigned_power_id, 'power.generator').values, ...claimStatus(db, 'power_config', job.assigned_power_id, 'power.output').values };
  }
  const adapters: Adapter[] = oo
    ? all<{ id: string }>(db, 'SELECT id FROM power_adapters WHERE owner_operator_id = ?', oo)
        .map((a) => {
          const c = claimStatus(db, 'power_adapter', a.id, 'power.adapter');
          if (c.claimId) evidenceRefs.push(c.claimId);
          return {
            id: a.id,
            fromConnector: String(c.values.from_connector ?? ''),
            toConnector: String(c.values.to_connector ?? ''),
            ratedAmperage: num(c.values.rated_amperage),
            ratedVoltage: num(c.values.rated_voltage),
            approved: c.status === 'VERIFIED',
          };
        })
    : [];
  if (reqC.claimId) evidenceRefs.push(reqC.claimId);
  const power = evaluatePower(
    P,
    {
      voltageMin: num(reqC.values.req_voltage_min),
      voltageMax: num(reqC.values.req_voltage_max),
      phase: (str(reqC.values.req_phase) as Phase) ?? null,
      amperage: num(reqC.values.req_amperage),
      inletConnector: str(reqC.values.inlet_connector),
      shorePowerCapable: reqC.values.shore_power_capable == null ? null : Boolean(reqC.values.shore_power_capable),
      status: reqC.status,
    },
    {
      availability: (str(siteP.values.site_power_status) as 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN') ?? null,
      voltage: num(siteP.values.site_voltage),
      phase: (str(siteP.values.site_phase) as Phase) ?? null,
      amperage: num(siteP.values.site_amperage),
      connector: str(siteP.values.site_connector),
      status: siteP.status,
      cableRunFt: num(siteA.values.cable_run_ft),
      cableStatus: siteA.status,
    },
    {
      present: genPresent,
      continuousKw: num(genValues.continuous_kw),
      fuelNotes: str(genValues.fuel_notes),
      voltage: num(genValues.voltage),
      phase: (str(genValues.phase) as Phase) ?? null,
      amperage: num(genValues.amperage),
      connector: str(genValues.receptacle_connector),
      gateVerified: genGate?.status === 'VERIFIED',
      gateFailed: genGate?.status === 'FAILED' || genGate?.status === 'EXPIRED',
    },
    adapters,
  );
  const powerReasons = [...power.reasons];
  if (power.source === 'GENERATOR' && genGate) powerReasons.push(...genGate.reasons.filter((r) => r.severity !== 'YELLOW' || r.code !== 'GATE_SIGNOFF_PENDING').map((r) => ({ ...r, message: `Power config: ${r.message}` })));

  const gates: Record<Gate, GateSummary> = {
    ASSET: { gate: 'ASSET', status: gateFromReasons(assetReasons, assetFallback), reasons: assetReasons, subjects: assetSubjects },
    TRUCK: { gate: 'TRUCK', status: gateFromReasons(truckReasons, worst(truckStatuses)), reasons: truckReasons, subjects: truckSubjects },
    POWER: {
      gate: 'POWER',
      status: power.result === 'MATCH' && powerReasons.every((r) => r.severity === 'INFO') ? 'VERIFIED' : gateFromReasons(powerReasons, genGate?.status ?? 'PENDING_REVIEW'),
      reasons: powerReasons,
      subjects: job.assigned_power_id ? [{ subjectType: 'power_config', subjectId: job.assigned_power_id, status: genGate!.status }] : [],
    },
    SITE: { gate: 'SITE', status: gateFromReasons(siteDedup, 'PENDING_REVIEW'), reasons: siteDedup, subjects: [{ subjectType: 'job', subjectId: job.id, status: gateFromReasons(siteDedup, 'PENDING_REVIEW') }] },
  };
  // If power evaluation had a MATCH but a reason list with only INFO, gate is VERIFIED.
  if (power.result !== 'MATCH' && gates.POWER.status === 'VERIFIED') gates.POWER.status = 'PENDING_REVIEW';

  const all_ = [...reasons, ...assetReasons, ...truckReasons, ...powerReasons, ...siteDedup];
  const status: JobStatus = all_.some((r) => r.severity === 'RED') ? 'RED' : all_.some((r) => r.severity === 'YELLOW') || gates.POWER.status !== 'VERIFIED' ? 'YELLOW' : 'GREEN';
  return {
    jobId: job.id,
    status,
    siteUnconfirmed: siteDedup.length > 0,
    evaluatedAt: now,
    policyVersion: policy.version,
    gates,
    reasons: all_,
    power,
    evidenceRefs: [...new Set(evidenceRefs)],
  };
}
