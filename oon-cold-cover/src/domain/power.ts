import type { PolicyConfig } from './policy.js';
import type { EvidenceStatus, Phase, Reason } from './types.js';

/**
 * Structured power compatibility. Connector NAMES are never treated as proof of
 * compatibility: voltage, phase, amperage, connector code, connector rating and
 * approved adapters are all compared. Unknown values produce UNCONFIRMED.
 */

export interface PowerRequirement {
  voltageMin: number | null;
  voltageMax: number | null;
  phase: Phase | null;
  amperage: number | null;
  inletConnector: string | null;
  shorePowerCapable: boolean | null;
  status: EvidenceStatus | 'MISSING';
}

export interface PowerSupply {
  voltage: number | null;
  phase: Phase | null;
  amperage: number | null;
  connector: string | null;
}

export interface SiteSupply extends PowerSupply {
  availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN' | null;
  status: EvidenceStatus | 'MISSING';
  cableRunFt: number | null;
  cableStatus: EvidenceStatus | 'MISSING';
}

export interface GeneratorSupply extends PowerSupply {
  continuousKw: number | null;
  fuelNotes: string | null;
  /** gate status of the power config (onboarding sign-off) */
  gateVerified: boolean;
  gateFailed: boolean;
  present: boolean;
}

export interface Adapter {
  id: string;
  fromConnector: string;
  toConnector: string;
  ratedAmperage: number | null;
  ratedVoltage: number | null;
  approved: boolean;
}

export type PowerResult = 'MATCH' | 'MISMATCH' | 'UNCONFIRMED';

export interface PowerMatch {
  result: PowerResult;
  source: 'SITE' | 'GENERATOR' | null;
  reasons: Reason[];
  checks: { label: string; outcome: 'PASS' | 'FAIL' | 'UNKNOWN'; detail: string }[];
  adapterUsed: string | null;
}

type Check = PowerMatch['checks'][number];

interface SupplyEval {
  ok: boolean;
  unknown: boolean;
  checks: Check[];
  failCodes: string[];
  adapterUsed: string | null;
}

function evalSupply(prefix: string, s: PowerSupply, req: PowerRequirement, adapters: Adapter[], policy: PolicyConfig): SupplyEval {
  const checks: Check[] = [];
  const failCodes: string[] = [];
  let unknown = false;
  const mark = (label: string, outcome: Check['outcome'], detail: string, code?: string) => {
    checks.push({ label: `${prefix}: ${label}`, outcome, detail });
    if (outcome === 'FAIL' && code) failCodes.push(code);
    if (outcome === 'UNKNOWN') unknown = true;
  };

  if (s.voltage == null || req.voltageMin == null || req.voltageMax == null) mark('Voltage', 'UNKNOWN', 'voltage not provided');
  else if (s.voltage < req.voltageMin || s.voltage > req.voltageMax)
    mark('Voltage', 'FAIL', `supply ${s.voltage}V outside required ${req.voltageMin}–${req.voltageMax}V`, 'VOLTAGE_MISMATCH');
  else mark('Voltage', 'PASS', `supply ${s.voltage}V within ${req.voltageMin}–${req.voltageMax}V`);

  if (!s.phase || !req.phase) mark('Phase', 'UNKNOWN', 'phase not provided');
  else if (s.phase !== req.phase) mark('Phase', 'FAIL', `supply ${s.phase} vs required ${req.phase}`, 'PHASE_MISMATCH');
  else mark('Phase', 'PASS', `${s.phase}-phase`);

  if (s.amperage == null || req.amperage == null) mark('Amperage', 'UNKNOWN', 'amperage not provided');
  else if (s.amperage < req.amperage) mark('Amperage', 'FAIL', `supply ${s.amperage}A < required ${req.amperage}A`, 'AMPERAGE_INSUFFICIENT');
  else mark('Amperage', 'PASS', `supply ${s.amperage}A ≥ required ${req.amperage}A`);

  let adapterUsed: string | null = null;
  if (!s.connector || !req.inletConnector) mark('Connector', 'UNKNOWN', 'connector not provided');
  else {
    const cat = policy.power.connectorCatalog.find((c) => c.code === s.connector);
    if (!cat) mark('Connector rating', 'UNKNOWN', `${s.connector} is not in the configured connector catalog`);
    else if ((req.amperage != null && cat.maxAmps < req.amperage) || (s.voltage != null && cat.maxVoltage < s.voltage) || (req.phase && cat.phase !== req.phase))
      mark('Connector rating', 'FAIL', `${cat.label} rating does not cover the required load`, 'CONNECTOR_RATING_INSUFFICIENT');
    else mark('Connector rating', 'PASS', `${cat.label}`);

    if (s.connector === req.inletConnector) mark('Connector', 'PASS', `direct ${s.connector} → ${req.inletConnector}`);
    else {
      const candidates = adapters.filter((a) => a.fromConnector === s.connector && a.toConnector === req.inletConnector);
      const approved = candidates.filter((a) => a.approved);
      const rated = approved.find(
        (a) => a.ratedAmperage != null && a.ratedVoltage != null && (req.amperage == null || a.ratedAmperage >= req.amperage) && (s.voltage == null || a.ratedVoltage >= s.voltage),
      );
      if (rated) {
        adapterUsed = rated.id;
        mark('Connector', 'PASS', `approved adapter ${rated.fromConnector} → ${rated.toConnector} (${rated.ratedAmperage}A/${rated.ratedVoltage}V)`);
      } else if (approved.length) mark('Connector', 'FAIL', 'approved adapter exists but its rating does not cover the load', 'ADAPTER_RATING_INSUFFICIENT');
      else if (candidates.length) mark('Connector', 'UNKNOWN', `adapter ${s.connector} → ${req.inletConnector} is recorded but not approved`);
      else mark('Connector', 'FAIL', `${s.connector} → ${req.inletConnector}: no approved adapter`, 'CONNECTOR_MISMATCH_NO_APPROVED_ADAPTER');
    }
  }
  return { ok: failCodes.length === 0 && !unknown, unknown, checks, failCodes, adapterUsed };
}

export function evaluatePower(
  policy: PolicyConfig,
  req: PowerRequirement,
  site: SiteSupply,
  gen: GeneratorSupply,
  adapters: Adapter[],
): PowerMatch {
  const reasons: Reason[] = [];
  const checks: Check[] = [];
  const red = (code: string, message: string) => reasons.push({ code, severity: 'RED', gate: 'POWER', message });
  const yellow = (code: string, message: string) => reasons.push({ code, severity: 'YELLOW', gate: 'POWER', message });

  // 1. The asset's own power requirement.
  if (req.status === 'MISSING' || req.voltageMin == null || req.voltageMax == null || !req.phase || req.amperage == null || !req.inletConnector) {
    yellow('POWER_REQUIREMENT_UNKNOWN', 'Asset power requirement (voltage range, phase, amperage, inlet connector) is incomplete.');
    return { result: 'UNCONFIRMED', source: null, reasons, checks, adapterUsed: null };
  }
  if (req.status === 'REJECTED') red('POWER_REQUIREMENT_REJECTED', 'Asset power requirement evidence was rejected by a reviewer.');
  else if (req.status !== 'VERIFIED') yellow('POWER_REQUIREMENT_UNVERIFIED', `Asset power requirement is ${req.status}, not verified.`);

  const permitted = policy.power.acceptableConfigs.some((c) => c.phase === req.phase && req.voltageMin! >= c.voltageMin && req.voltageMax! <= c.voltageMax);
  checks.push({ label: 'Policy: acceptable power configuration', outcome: permitted ? 'PASS' : 'FAIL', detail: `${req.voltageMin}–${req.voltageMax}V ${req.phase}-phase` });
  if (!permitted) red('POWER_CONFIG_NOT_PERMITTED', `Required ${req.voltageMin}–${req.voltageMax}V ${req.phase}-phase is not an acceptable configuration under the job's policy.`);

  // 2. Destination (shore) power — only usable when stated available, verified, and the asset can take shore power.
  let siteOk = false;
  let siteKnownMismatch = false;
  let adapterUsed: string | null = null;
  const siteUsable = site.availability === 'AVAILABLE' && req.shorePowerCapable === true;
  if (site.availability === 'AVAILABLE' && req.shorePowerCapable !== true) {
    checks.push({ label: 'Site power', outcome: 'UNKNOWN', detail: 'site power stated available but the asset is not recorded as shore-power capable' });
  }
  if (siteUsable) {
    const ev = evalSupply('Site', site, req, adapters, policy);
    checks.push(...ev.checks);
    if (site.cableRunFt == null) checks.push({ label: 'Site: cable run', outcome: 'UNKNOWN', detail: 'cable-run distance not provided' });
    else if (site.cableRunFt > policy.power.maxCableRunFt) {
      checks.push({ label: 'Site: cable run', outcome: 'FAIL', detail: `${site.cableRunFt} ft > policy max ${policy.power.maxCableRunFt} ft` });
      ev.failCodes.push('CABLE_RUN_EXCEEDS_POLICY');
    } else checks.push({ label: 'Site: cable run', outcome: 'PASS', detail: `${site.cableRunFt} ft ≤ ${policy.power.maxCableRunFt} ft` });
    const cableKnown = site.cableRunFt != null;
    siteKnownMismatch = ev.failCodes.length > 0;
    siteOk = ev.ok && cableKnown && !siteKnownMismatch && site.status === 'VERIFIED' && site.cableStatus === 'VERIFIED';
    if (siteOk) adapterUsed = ev.adapterUsed;
    if (siteKnownMismatch && !gen.present) for (const c of ev.failCodes) red(`SITE_${c}`, `Destination power: ${c.replaceAll('_', ' ').toLowerCase()}.`);
    if (siteKnownMismatch && gen.present)
      reasons.push({ code: 'SITE_POWER_MISMATCH_GENERATOR_REQUIRED', severity: 'INFO', gate: 'POWER', message: `Destination power does not match (${ev.failCodes.join(', ')}); generator must carry the load.` });
  }

  if (siteOk && reasons.every((r) => r.severity !== 'RED')) {
    return { result: reasons.length ? 'UNCONFIRMED' : 'MATCH', source: 'SITE', reasons, checks, adapterUsed };
  }

  // 3. Generator — required when destination power is unavailable, unverified, or mismatched.
  const why = site.availability === 'UNAVAILABLE' ? 'destination power unavailable' : siteKnownMismatch ? 'destination power does not match' : 'destination power unverified';
  if (!gen.present) {
    if (!siteKnownMismatch) yellow('GENERATOR_REQUIRED_NOT_ASSIGNED', `Generator required (${why}) but no power configuration is assigned.`);
    return { result: reasons.some((r) => r.severity === 'RED') ? 'MISMATCH' : 'UNCONFIRMED', source: null, reasons, checks, adapterUsed: null };
  }
  const minKw = policy.power.minGeneratorKwWhenSitePowerUnverified;
  if (gen.continuousKw == null) {
    checks.push({ label: 'Generator: continuous rating', outcome: 'UNKNOWN', detail: 'continuous kW not provided' });
    yellow('GENERATOR_RATING_UNKNOWN', 'Generator continuous kW rating not provided.');
  } else if (gen.continuousKw < minKw) {
    checks.push({ label: 'Generator: continuous rating', outcome: 'FAIL', detail: `${gen.continuousKw} kW < policy minimum ${minKw} kW` });
    red('GENERATOR_BELOW_MIN_KW', `Generator ${gen.continuousKw} kW continuous is below the configured ${minKw} kW minimum (${why}).`);
  } else checks.push({ label: 'Generator: continuous rating', outcome: 'PASS', detail: `${gen.continuousKw} kW ≥ ${minKw} kW (stated; verified via evidence review)` });

  if (policy.power.requireFuelPlan && !gen.fuelNotes) yellow('FUEL_PLAN_MISSING', 'Policy requires a generator fuel reserve/availability plan.');

  const ev = evalSupply('Generator', gen, req, adapters, policy);
  checks.push(...ev.checks);
  for (const c of ev.failCodes) red(`GENERATOR_${c}`, `Generator output: ${c.replaceAll('_', ' ').toLowerCase()}.`);
  if (ev.unknown) yellow('GENERATOR_OUTPUT_UNCONFIRMED', 'One or more generator output values or adapters are unknown or unapproved.');
  if (gen.gateFailed) red('POWER_GATE_FAILED', 'The power configuration failed qualification review.');
  else if (!gen.gateVerified) yellow('POWER_GATE_NOT_VERIFIED', 'Power configuration has not completed qualification review.');

  const hasRed = reasons.some((r) => r.severity === 'RED');
  const hasYellow = reasons.some((r) => r.severity === 'YELLOW');
  return {
    result: hasRed ? 'MISMATCH' : hasYellow ? 'UNCONFIRMED' : 'MATCH',
    source: 'GENERATOR',
    reasons,
    checks,
    adapterUsed: ev.adapterUsed,
  };
}
