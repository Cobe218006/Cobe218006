/**
 * DEMO / FICTIONAL fixtures. All names, numbers, VINs, coordinates and contacts are
 * invented for local demonstration and tests. Emails use the reserved `.test` TLD.
 * Phone numbers use the 555-01xx fictional range.
 */
import { all, type DB } from '../db.js';
import { uploadDocument, type StorageAdapter } from '../domain/documents.js';
import { activeClaim, attachDocumentToClaim, CLAIM_DEFS, reviewClaim, subjectClaims, type SubjectType } from '../domain/evidence.js';
import { subjectGateStatus } from '../domain/gates.js';
import { createOwnerOperator, recordGateReview, saveSubject, submitOnboarding } from '../domain/onboarding.js';
import { currentPolicy } from '../domain/policy.js';
import type { Actor, Gate, Role } from '../domain/types.js';
import { createUser, loadActor } from '../domain/users.js';

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-2026';

export function demoPdf(label: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% DEMO / FICTIONAL DOCUMENT - ${label}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

export interface DemoUsers {
  admin: Actor;
  officer: Actor;
  dispatcher: Actor;
  finance: Actor;
  auditor: Actor;
}

export function makeUser(db: DB, email: string, name: string, roles: Role[], ownerOperatorId: string | null = null): Actor {
  const id = createUser(db, null, { email, display_name: name, password: DEMO_PASSWORD, roles, owner_operator_id: ownerOperatorId }, { isDemo: true, bootstrap: true });
  return loadActor(db, id)!;
}

export function makeStaff(db: DB): DemoUsers {
  return {
    admin: makeUser(db, 'admin@oon-demo.test', 'Avery Admin (demo)', ['ADMIN']),
    officer: makeUser(db, 'officer@oon-demo.test', 'Quinn Officer (demo)', ['QUALIFICATION_OFFICER']),
    dispatcher: makeUser(db, 'dispatch@oon-demo.test', 'Dana Dispatcher (demo)', ['DISPATCHER']),
    finance: makeUser(db, 'finance@oon-demo.test', 'Frankie Finance (demo)', ['FINANCE']),
    auditor: makeUser(db, 'auditor@oon-demo.test', 'Ari Auditor (demo)', ['READ_ONLY_AUDITOR']),
  };
}

export interface OperatorFixture {
  ownerOperatorId: string;
  user: Actor;
  driverId: string;
  truckId: string;
  assetId: string;
  powerId: string;
  adapterId: string | null;
}

const isoDate = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

export interface OperatorSpec {
  legalName: string;
  email: string;
  userName: string;
  truck?: Partial<Record<string, unknown>>;
  asset?: Partial<Record<string, unknown>>;
  power?: Partial<Record<string, unknown>>;
  adapter?: Partial<Record<string, unknown>> | null;
}

/** Create an owner-operator with a driver, truck, 16-ft reefer and generator, all entered by the owner-operator user (unverified). */
export function makeOperator(db: DB, staff: DemoUsers, spec: OperatorSpec, storage?: StorageAdapter): OperatorFixture {
  const oo = createOwnerOperator(
    db,
    staff.admin,
    { legal_name: spec.legalName, contact_name: spec.userName, contact_phone: '+1 555-0100', contact_email: spec.email, base_city: 'Demo City', base_state: 'TX', dot_number: '0000001', mc_number: '0000002' },
    { isDemo: true },
  );
  const user = makeUser(db, spec.email, spec.userName, ['OWNER_OPERATOR'], oo.id);
  const driver = saveSubject(db, user, 'driver', oo.id, null, { full_name: spec.userName, license_class: 'A', license_status: 'VALID', license_state: 'TX', license_expires: isoDate(700) });
  const truck = saveSubject(db, user, 'truck', oo.id, null, {
    label: 'Demo Truck 1',
    year: 2021,
    make: 'DemoMake',
    model: 'Hauler 3500',
    vin: '1DEMX0000FXCT0001',
    gvwr_lbs: 14000,
    gcwr_lbs: 30000,
    tow_rating_lbs: 16000,
    hitch_class: 'V',
    hitch_type: 'GOOSENECK',
    registration_state: 'TX',
    registration_number: 'DEMO-REG-1',
    registration_expires: isoDate(300),
    auto_liability_usd: 1_000_000,
    cargo_coverage_usd: 100_000,
    insurance_effective: isoDate(-30),
    insurance_expires: isoDate(335),
    ...spec.truck,
  });
  const asset = saveSubject(db, user, 'cold_asset', oo.id, null, {
    asset_type: 'REEFER_TRAILER_16FT',
    unit_id: 'DEMO-RT16-01',
    reefer_make: 'FictoCool',
    reefer_model: 'FC-16',
    stated_temp_min_f: -20,
    stated_temp_max_f: 50,
    gross_weight_lbs: 9000,
    required_hitch_type: 'GOOSENECK',
    temp_logger_details: 'Demo logger DL-1, 5-minute interval, downloadable CSV',
    security_details: 'Keyed padlock + tamper seal (demo)',
    inspection_date: isoDate(-60),
    registration_info: 'Demo trailer plate DEMO-TR-1',
    req_voltage_min: 208,
    req_voltage_max: 230,
    req_phase: 'SINGLE',
    req_amperage: 30,
    inlet_connector: 'NEMA_L14_30',
    shore_power_capable: true,
    ...spec.asset,
  });
  const power = saveSubject(db, user, 'power_config', oo.id, null, {
    label: 'Demo Generator 12 kW',
    generator_make: 'FictoGen',
    generator_model: 'FG-12',
    continuous_kw: 12,
    fuel_notes: '24 h diesel reserve on board; refuel plan with demo supplier',
    voltage: 230,
    phase: 'SINGLE',
    amperage: 50,
    receptacle_connector: 'CS6365',
    ...spec.power,
  });
  let adapterId: string | null = null;
  if (spec.adapter !== null) {
    const ad = saveSubject(db, user, 'power_adapter', oo.id, null, { power_config_id: power.id, from_connector: 'CS6365', to_connector: 'NEMA_L14_30', rated_amperage: 30, rated_voltage: 250, description: 'Demo 50A→30A adapter', ...(spec.adapter ?? {}) });
    adapterId = String(ad.id);
  }
  if (storage) attachRequiredDocs(db, storage, user, oo.id);
  return { ownerOperatorId: oo.id, user, driverId: String(driver.id), truckId: String(truck.id), assetId: String(asset.id), powerId: String(power.id), adapterId };
}

/** Upload fictional PDFs for every claim that policy requires a document for, and attach them. */
export function attachRequiredDocs(db: DB, storage: StorageAdapter, user: Actor, ownerOperatorId: string) {
  const policy = currentPolicy(db);
  const claims = all<{ id: string; claim_key: string }>(
    db,
    `SELECT c.id, c.claim_key FROM evidence_claims c WHERE c.owner_operator_id = ? AND c.subject_type != 'job' AND NOT EXISTS (SELECT 1 FROM evidence_claims s WHERE s.supersedes_id = c.id)`,
    ownerOperatorId,
  );
  for (const c of claims) {
    if (!policy.config.documentRequirements[c.claim_key]) continue;
    const def = CLAIM_DEFS.find((d) => d.key === c.claim_key)!;
    const doc = uploadDocument(db, storage, user, { ownerOperatorId, category: def.docCategory ?? 'OTHER', filename: `demo-${c.claim_key}.pdf`, declaredMime: 'application/pdf', data: demoPdf(c.claim_key) });
    attachDocumentToClaim(db, user, c.id, doc.id);
  }
}

/** Qualification officer verifies every current onboarding claim and signs off every gate that becomes ready. */
export function verifyOperator(db: DB, fx: OperatorFixture, officer: Actor, opts: { skipKeys?: string[] } = {}) {
  submitOnboarding(db, fx.user, fx.ownerOperatorId);
  const subjects: [SubjectType, string, Gate[]][] = [
    ['driver', fx.driverId, ['TRUCK']],
    ['truck', fx.truckId, ['TRUCK']],
    ['cold_asset', fx.assetId, ['ASSET', 'POWER']],
    ['power_config', fx.powerId, ['POWER']],
  ];
  if (fx.adapterId) subjects.push(['power_adapter', fx.adapterId, []]);
  for (const [st, id] of subjects) {
    for (const c of subjectClaims(db, st, id)) {
      if (opts.skipKeys?.includes(c.def.key)) continue;
      if (c.status === 'VERIFIED') continue;
      reviewClaim(db, officer, c.claim.id, {
        decision: 'VERIFIED',
        note: 'DEMO review: document on file matches entered values.',
        basis: c.def.key === 'driver.license' ? 'DEMO: reviewer determined the recorded class is sufficient for the configured combination (fictional basis).' : null,
      });
    }
  }
  const policy = currentPolicy(db);
  for (const [st, id, gates] of subjects) {
    for (const g of gates) {
      const s = subjectGateStatus(db, policy, g, st, id);
      if (s.readyForSignoff && s.status !== 'VERIFIED') recordGateReview(db, officer, g, st, id, 'VERIFIED', 'DEMO sign-off: all required evidence verified.');
    }
  }
}

export const futureWindow = (hoursFromNow = 24, lengthHours = 4) => ({
  window_start: new Date(Date.now() + hoursFromNow * 3600_000).toISOString(),
  window_end: new Date(Date.now() + (hoursFromNow + lengthHours) * 3600_000).toISOString(),
});

/** A complete job specification (all site fields present, unverified). */
export function fullSpec(overrides: Record<string, unknown> = {}) {
  return {
    customer_name: 'Demo Community Event (fictional)',
    required_asset_class: 'REEFER_TRAILER_16FT',
    pickup_location: 'Demo Yard, 100 Example Rd',
    pickup_lat: 30.1,
    pickup_lng: -97.1,
    delivery_address: 'Demo Fairgrounds Gate C',
    delivery_lat: 30.25,
    delivery_lng: -97.75,
    ...futureWindow(),
    site_contact_name: 'Sam Sitecontact (demo)',
    site_contact_phone: '+1 555-0142',
    site_contact_method: 'Call direct cell; confirm gate code on arrival',
    site_access_notes: 'Gate C, 14 ft clearance, gravel pad',
    cable_run_ft: 40,
    setpoint_f: 35,
    commodity: 'Bottled water & produce (demo)',
    commodity_notes: 'Keep 33–38°F',
    site_power_status: 'UNAVAILABLE',
    ...overrides,
  };
}

/** Verify every current site claim of a job as the given actor. */
export function verifySite(db: DB, actor: Actor, jobId: string, keys?: string[]) {
  for (const c of subjectClaims(db, 'job', jobId)) {
    if (keys && !keys.includes(c.def.key)) continue;
    if (c.status === 'VERIFIED') continue;
    try {
      reviewClaim(db, actor, c.claim.id, { decision: 'VERIFIED', note: c.def.key === 'site.contact' ? 'DEMO: called named contact, confirmed window and gate access.' : 'DEMO: confirmed with site contact.' });
    } catch (e) {
      // Incomplete items cannot be verified; a reviewer records them as unconfirmed instead.
      if ((e as { code?: string }).code !== 'VALIDATION_FAILED') throw e;
      reviewClaim(db, actor, c.claim.id, { decision: 'UNCONFIRMED', note: 'DEMO: values incomplete; could not confirm.' });
    }
  }
}

export function activeClaimId(db: DB, subjectType: SubjectType, subjectId: string, key: string): string {
  const c = activeClaim(db, subjectType, subjectId, key);
  if (!c) throw new Error(`no claim ${key}`);
  return c.id;
}
