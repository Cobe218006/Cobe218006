import { z } from 'zod';
import { all, get, insert, tx, type DB } from '../db.js';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { invalid, notFound } from '../errors.js';
import { nowIso } from '../ids.js';
import { appendEvent } from './ledger.js';
import { requirePerm } from './permissions.js';
import { ROLES, type Actor } from './types.js';

const phase = z.enum(['SINGLE', 'THREE']);
const code = z.string().regex(/^[A-Z0-9_.:-]{2,60}$/, 'codes use A-Z, 0-9, _ . : -');

export const policyConfigSchema = z
  .object({
    documentCode: z.string().min(1).max(60),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    asset: z.object({
      permittedAssetClasses: z.array(z.object({ code, label: z.string().min(1).max(120), refrigerated: z.boolean() })).min(1),
      /** The stated capability must cover this range (network requirement, not a performance guarantee). */
      requiredStatedTempMinF: z.number().min(-60).max(80),
      requiredStatedTempMaxF: z.number().min(-60).max(80),
      maxInspectionAgeDays: z.number().int().min(1).max(3650),
      requiredClaims: z.array(z.string()),
    }),
    truck: z.object({
      minAutoLiabilityUsd: z.number().int().min(0),
      minCargoCoverageUsd: z.number().int().min(0),
      requiredClaims: z.array(z.string()),
    }),
    power: z.object({
      acceptableConfigs: z
        .array(z.object({ label: z.string().min(1), voltageMin: z.number().int().min(1), voltageMax: z.number().int().min(1), phase }))
        .min(1),
      minGeneratorKwWhenSitePowerUnverified: z.number().min(0).max(500),
      requireFuelPlan: z.boolean(),
      maxCableRunFt: z.number().min(1).max(2000),
      connectorCatalog: z
        .array(z.object({ code, label: z.string().min(1), maxVoltage: z.number().int().min(1), maxAmps: z.number().int().min(1), phase }))
        .min(1),
      requiredClaims: z.array(z.string()),
    }),
    site: z.object({ requiredClaims: z.array(z.string()) }),
    documentRequirements: z.record(z.string(), z.boolean()),
    reviewRules: z.object({
      siteVerifierRoles: z.array(z.enum(ROLES)).min(1),
      allowSameUserSiteConfirmation: z.boolean(),
      requireNoteOnReject: z.boolean(),
      requireBasisForDriverDecision: z.boolean(),
    }),
    invoiceCategories: z.array(z.object({ code, label: z.string().min(1).max(120) })).min(1),
    documentRetentionDays: z.number().int().min(30).max(36500),
  })
  .superRefine((p, ctx) => {
    if (p.asset.requiredStatedTempMinF >= p.asset.requiredStatedTempMaxF)
      ctx.addIssue({ code: 'custom', message: 'asset temperature range min must be below max', path: ['asset'] });
    for (const c of p.power.acceptableConfigs)
      if (c.voltageMin > c.voltageMax) ctx.addIssue({ code: 'custom', message: `power config ${c.label}: voltageMin > voltageMax`, path: ['power'] });
  });

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

/**
 * Defaults drawn from OON-QUAL-2026-V1. These are configurable network policy
 * values — NOT legal determinations. Coverage checks read
 * "meets configured network threshold", never "legally compliant".
 */
export const DEFAULT_POLICY: PolicyConfig = {
  documentCode: 'OON-QUAL-2026-V1',
  effectiveDate: '2026-09-27',
  asset: {
    permittedAssetClasses: [
      { code: 'REEFER_TRAILER_16FT', label: '16-foot towable reefer trailer', refrigerated: true },
      { code: 'REEFER_CONTAINER_20FT', label: '20-foot refrigerated container', refrigerated: true },
      { code: 'POWER_UNIT_ONLY', label: 'Power-unit-only hauler', refrigerated: false },
    ],
    requiredStatedTempMinF: -10,
    requiredStatedTempMaxF: 40,
    maxInspectionAgeDays: 365,
    requiredClaims: ['asset.identity', 'asset.refrigeration', 'asset.transport', 'asset.temp_logger', 'asset.security', 'asset.inspection'],
  },
  truck: {
    minAutoLiabilityUsd: 1_000_000,
    minCargoCoverageUsd: 100_000,
    requiredClaims: [
      'truck.identity',
      'truck.weight_ratings',
      'truck.hitch',
      'truck.registration',
      'truck.auto_liability',
      'truck.cargo_insurance',
      'driver.license',
    ],
  },
  power: {
    acceptableConfigs: [
      { label: '208V–230V single-phase', voltageMin: 208, voltageMax: 230, phase: 'SINGLE' },
      { label: '208V–480V three-phase (where specified)', voltageMin: 208, voltageMax: 480, phase: 'THREE' },
    ],
    minGeneratorKwWhenSitePowerUnverified: 10,
    requireFuelPlan: true,
    maxCableRunFt: 100,
    connectorCatalog: [
      { code: 'NEMA_L14_30', label: 'NEMA L14-30 (30A 125/250V)', maxVoltage: 250, maxAmps: 30, phase: 'SINGLE' },
      { code: 'CS6365', label: 'CS6365 series (50A 250V)', maxVoltage: 250, maxAmps: 50, phase: 'SINGLE' },
      { code: 'NEMA_14_50', label: 'NEMA 14-50 (50A 125/250V)', maxVoltage: 250, maxAmps: 50, phase: 'SINGLE' },
      { code: 'NEMA_L15_30', label: 'NEMA L15-30 (30A 250V 3-phase)', maxVoltage: 250, maxAmps: 30, phase: 'THREE' },
      { code: 'NEMA_L16_30', label: 'NEMA L16-30 (30A 480V 3-phase)', maxVoltage: 480, maxAmps: 30, phase: 'THREE' },
    ],
    requiredClaims: ['asset.power_requirement', 'power.generator', 'power.output'],
  },
  site: {
    requiredClaims: [
      'site.pickup',
      'site.delivery_pin',
      'site.delivery_window',
      'site.contact',
      'site.access',
      'site.setpoint_commodity',
      'site.power',
    ],
  },
  documentRequirements: {
    'driver.license': true,
    'truck.registration': true,
    'truck.auto_liability': true,
    'truck.cargo_insurance': true,
    'asset.temp_logger': true,
    'asset.inspection': true,
    'power.generator': true,
  },
  reviewRules: {
    siteVerifierRoles: ['DISPATCHER', 'QUALIFICATION_OFFICER'],
    allowSameUserSiteConfirmation: true,
    requireNoteOnReject: true,
    requireBasisForDriverDecision: true,
  },
  invoiceCategories: [
    { code: 'EQUIPMENT_PURCHASE', label: 'Equipment purchase' },
    { code: 'EQUIPMENT_LEASE', label: 'Equipment lease' },
    { code: 'UPFIT_INSTALL', label: 'Upfit / installation' },
    { code: 'GENERATOR_POWER', label: 'Generator / power equipment' },
    { code: 'HAUL_SERVICE', label: 'Haul / service' },
    { code: 'OTHER_SERVICE', label: 'Other configured service' },
  ],
  documentRetentionDays: 2555,
};

export interface PolicyVersion {
  version: number;
  documentCode: string;
  effectiveDate: string;
  config: PolicyConfig;
  changeNote: string;
  createdBy: string | null;
  createdAt: string;
  configHash: string;
}

type PolicyRow = {
  version: number;
  document_code: string;
  effective_date: string;
  config_json: string;
  change_note: string;
  created_by: string | null;
  created_at: string;
  config_hash: string;
};

function fromRow(r: PolicyRow): PolicyVersion {
  return {
    version: r.version,
    documentCode: r.document_code,
    effectiveDate: r.effective_date,
    config: JSON.parse(r.config_json),
    changeNote: r.change_note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    configHash: r.config_hash,
  };
}

export function currentPolicy(db: DB): PolicyVersion {
  const r = get<PolicyRow>(db, 'SELECT * FROM policy_versions ORDER BY version DESC LIMIT 1');
  if (!r) throw notFound('Policy version');
  return fromRow(r);
}

export function policyByVersion(db: DB, version: number): PolicyVersion {
  const r = get<PolicyRow>(db, 'SELECT * FROM policy_versions WHERE version = ?', version);
  if (!r) throw notFound(`Policy version ${version}`);
  return fromRow(r);
}

export function listPolicies(db: DB): PolicyVersion[] {
  return all<PolicyRow>(db, 'SELECT * FROM policy_versions ORDER BY version DESC').map(fromRow);
}

function insertVersion(db: DB, config: PolicyConfig, note: string, actorId: string | null): PolicyVersion {
  const last = get<{ v: number | null }>(db, 'SELECT MAX(version) AS v FROM policy_versions');
  const version = (last?.v ?? 0) + 1;
  const configHash = sha256Hex(canonicalJson(config));
  const createdAt = nowIso();
  insert(db, 'policy_versions', {
    version,
    document_code: config.documentCode,
    effective_date: config.effectiveDate,
    config_json: JSON.stringify(config),
    change_note: note,
    created_by: actorId,
    created_at: createdAt,
    config_hash: configHash,
  });
  appendEvent(db, {
    entityType: 'policy',
    entityId: String(version),
    eventType: 'POLICY_VERSION_CREATED',
    actorId,
    policyVersion: version,
    payload: { version, changeNote: note, configHash, documentCode: config.documentCode },
  });
  return policyByVersion(db, version);
}

export function ensureDefaultPolicy(db: DB): PolicyVersion {
  const existing = get(db, 'SELECT version FROM policy_versions LIMIT 1');
  if (existing) return currentPolicy(db);
  return tx(db, () => insertVersion(db, DEFAULT_POLICY, 'Initial defaults from OON-QUAL-2026-V1', null));
}

/** Creates a NEW policy version. Existing versions are never modified; jobs keep the version they were evaluated under. */
export function createPolicyVersion(db: DB, actor: Actor, input: unknown, note: string): PolicyVersion {
  requirePerm(actor, 'policy.manage');
  const parsed = policyConfigSchema.safeParse(input);
  if (!parsed.success) throw invalid('Policy configuration is invalid.', parsed.error.flatten());
  if (!note || note.trim().length < 3) throw invalid('A change note is required for every policy version.');
  return tx(db, () => insertVersion(db, parsed.data, note.trim(), actor.id));
}

export function connectorLabel(p: PolicyConfig, codeValue: string | null | undefined): string {
  if (!codeValue) return 'not provided';
  return p.power.connectorCatalog.find((c) => c.code === codeValue)?.label ?? `${codeValue} (not in catalog)`;
}

export function assetClassLabel(p: PolicyConfig, codeValue: string | null | undefined): string {
  if (!codeValue) return 'not provided';
  return p.asset.permittedAssetClasses.find((c) => c.code === codeValue)?.label ?? `${codeValue} (not permitted by current policy)`;
}
