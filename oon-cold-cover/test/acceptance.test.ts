/**
 * Acceptance criteria 1–12 from the master build prompt. Each `describe` maps to one criterion.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, sha256Hex } from '../src/canonical.js';
import { get } from '../src/db.js';
import { issueDocumentLink, readDocumentContent, uploadDocument } from '../src/domain/documents.js';
import { activeClaim, claimHistory, reviewClaim, subjectClaims, viewClaim } from '../src/domain/evidence.js';
import { evaluateJob, subjectGateStatus } from '../src/domain/gates.js';
import { assignJob, attemptSet, createJob, dispatchJob, getJobRow, markArrived, markDelivered, recordPod, repinPolicy, updateJobSpec } from '../src/domain/jobs.js';
import { eventsFor, verifyLedger } from '../src/domain/ledger.js';
import { saveSubject, submitOnboarding } from '../src/domain/onboarding.js';
import { createPolicyVersion, currentPolicy, policyByVersion } from '../src/domain/policy.js';
import { exportPackage, recordCorrection, sealJob, verifyExportedPackage, verifyManifest } from '../src/domain/vault.js';
import { demoPdf, fullSpec, makeOperator, makeUser, verifyOperator, verifySite } from '../src/demo/fixtures.js';
import { assignmentFor, greenReadyJob, ledgerSnapshot, loginAgent, world } from './helpers.js';

const codes = (ev: { reasons: { code: string }[] }) => ev.reasons.map((r) => r.code);

describe('1. An owner-operator cannot verify their own submitted evidence', () => {
  it('rejects self-verification in the service layer and via the API', async () => {
    const w = world();
    const fx = makeOperator(w.db, w.staff, { legalName: 'Self Verify Co (FICTIONAL)', email: 'self@t.test', userName: 'Self Op' }, w.storage);
    const claimId = activeClaim(w.db, 'truck', fx.truckId, 'truck.identity')!.id;
    assert.throws(() => reviewClaim(w.db, fx.user, claimId, { decision: 'VERIFIED', note: 'mine' }), { code: 'FORBIDDEN' });
    const { agent, csrf } = await loginAgent(w.app, 'self@t.test');
    const res = await agent.post(`/api/evidence/${claimId}/review`).set('x-csrf-token', csrf).send({ decision: 'VERIFIED', note: 'mine' });
    assert.equal(res.status, 403);
    assert.equal(viewClaim(w.db, activeClaim(w.db, 'truck', fx.truckId, 'truck.identity')!).status, 'OPERATOR_ENTERED');
  });

  it('a qualification officer who is also linked to the business cannot review it, and a dispatcher without review permission cannot verify onboarding evidence', () => {
    const w = world();
    const fx = makeOperator(w.db, w.staff, { legalName: 'Mixed Role Co (FICTIONAL)', email: 'mixed-op@t.test', userName: 'Op' }, w.storage);
    const insider = makeUser(w.db, 'insider@t.test', 'Insider QO', ['QUALIFICATION_OFFICER'], fx.ownerOperatorId);
    const claimId = activeClaim(w.db, 'truck', fx.truckId, 'truck.identity')!.id;
    assert.throws(() => reviewClaim(w.db, insider, claimId, { decision: 'VERIFIED' }), { code: 'FORBIDDEN' });
    assert.throws(() => reviewClaim(w.db, w.staff.dispatcher, claimId, { decision: 'VERIFIED' }), { code: 'FORBIDDEN' });
    const dualRole = makeUser(w.db, 'dual@t.test', 'Dispatcher + QO', ['DISPATCHER', 'QUALIFICATION_OFFICER']);
    reviewClaim(w.db, dualRole, claimId, { decision: 'VERIFIED', note: 'checked registration card' });
    assert.equal(viewClaim(w.db, activeClaim(w.db, 'truck', fx.truckId, 'truck.identity')!).status, 'VERIFIED');
  });
});

describe('2. Operator-entered information is not automatically verified', () => {
  it('entered values stay OPERATOR_ENTERED/PENDING and gates stay unverified until a reviewer acts', () => {
    const w = world();
    const fx = makeOperator(w.db, w.staff, { legalName: 'Fresh Co (FICTIONAL)', email: 'fresh@t.test', userName: 'Fresh Op' }, w.storage);
    const claims = subjectClaims(w.db, 'truck', fx.truckId);
    assert.ok(claims.length > 0);
    assert.ok(claims.every((c) => c.status === 'OPERATOR_ENTERED'));
    submitOnboarding(w.db, fx.user, fx.ownerOperatorId);
    assert.ok(subjectClaims(w.db, 'truck', fx.truckId).every((c) => c.status === 'PENDING'));
    const gate = subjectGateStatus(w.db, currentPolicy(w.db), 'TRUCK', 'truck', fx.truckId);
    assert.notEqual(gate.status, 'VERIFIED');
  });

  it('a client-supplied status field is ignored by the API', async () => {
    const w = world();
    const { agent, csrf } = await loginAgent(w.app, 'good@t.test');
    const res = await agent
      .put(`/api/owner-operators/${w.good.ownerOperatorId}/trucks/${w.good.truckId}`)
      .set('x-csrf-token', csrf)
      .send({ label: 'Renamed', year: 2022, make: 'DemoMake', model: 'Hauler 3500', vin: '1DEMX0000FXCT0009', status: 'VERIFIED', gvwr_lbs: 14000, gcwr_lbs: 30000, tow_rating_lbs: 16000, hitch_class: 'V', hitch_type: 'GOOSENECK' });
    assert.equal(res.status, 200);
    const ident = viewClaim(w.db, activeClaim(w.db, 'truck', w.good.truckId, 'truck.identity')!);
    assert.equal(ident.status, 'OPERATOR_ENTERED');
    assert.equal(ident.values.vin, '1DEMX0000FXCT0009');
  });
});

describe('3. A job missing its delivery pin, window, named contact, or required power evidence cannot become GREEN', () => {
  it('baseline: the fully specified and verified job is GREEN', () => {
    const w = world();
    const job = greenReadyJob(w);
    assert.equal(evaluateJob(w.db, getJobRow(w.db, job.id), currentPolicy(w.db)).status, 'GREEN');
  });

  for (const [label, overrides, expected] of [
    ['delivery pin', { delivery_lat: null, delivery_lng: null }, 'SITE_DELIVERY_PIN_MISSING'],
    ['delivery window', { window_start: null, window_end: null }, 'SITE_DELIVERY_WINDOW_MISSING'],
    ['named contact', { site_contact_name: null, site_contact_phone: null, site_contact_method: null }, 'SITE_CONTACT_MISSING'],
  ] as const) {
    it(`missing ${label} → not GREEN (${expected})`, () => {
      const w = world();
      const job = greenReadyJob(w, overrides);
      const ev = attemptSet(w.db, w.staff.dispatcher, job.id);
      assert.notEqual(ev.status, 'GREEN');
      assert.ok(codes(ev).includes(expected), codes(ev).join(','));
      assert.equal(getJobRow(w.db, job.id).stage, 'SPEC');
    });
  }

  it('named contact entered but not confirmed by a person → SITE_CONTACT_UNCONFIRMED', () => {
    const w = world();
    const job = createJob(w.db, w.staff.dispatcher, fullSpec());
    assignJob(w.db, w.staff.dispatcher, job.id, assignmentFor(w.good));
    verifySite(w.db, w.staff.dispatcher, job.id, ['site.pickup', 'site.delivery_pin', 'site.delivery_window', 'site.access', 'site.setpoint_commodity', 'site.power']);
    const ev = attemptSet(w.db, w.staff.dispatcher, job.id);
    assert.equal(ev.status, 'YELLOW');
    assert.ok(codes(ev).includes('SITE_CONTACT_UNCONFIRMED'));
  });

  it('missing required power evidence (generator not verified) → not GREEN', () => {
    const w = world();
    const fx = makeOperator(w.db, w.staff, { legalName: 'Unverified Power Co (FICTIONAL)', email: 'pw@t.test', userName: 'Pw Op' }, w.storage);
    verifyOperator(w.db, fx, w.staff.officer, { skipKeys: ['power.generator'] });
    const job = createJob(w.db, w.staff.dispatcher, fullSpec());
    assignJob(w.db, w.staff.dispatcher, job.id, assignmentFor(fx));
    verifySite(w.db, w.staff.dispatcher, job.id);
    const ev = attemptSet(w.db, w.staff.dispatcher, job.id);
    assert.equal(ev.status, 'YELLOW');
    assert.ok(codes(ev).includes('POWER_GATE_NOT_VERIFIED'), codes(ev).join(','));
  });

  it('no generator assigned while destination power is unavailable → not GREEN', () => {
    const w = world();
    const job = greenReadyJob(w);
    assignJob(w.db, w.staff.dispatcher, job.id, assignmentFor(w.good, { power_id: null }));
    const ev = attemptSet(w.db, w.staff.dispatcher, job.id);
    assert.notEqual(ev.status, 'GREEN');
    assert.ok(codes(ev).includes('GENERATOR_REQUIRED_NOT_ASSIGNED'));
  });
});

describe('4. A known truck/asset/power incompatibility produces RED with a reason code', () => {
  it('generator below the configured minimum kW with destination power unavailable → RED GENERATOR_BELOW_MIN_KW', () => {
    const w = world();
    const fx = makeOperator(w.db, w.staff, { legalName: 'Small Gen Co (FICTIONAL)', email: 'small@t.test', userName: 'Small Op', power: { label: '6 kW', continuous_kw: 6 } }, w.storage);
    verifyOperator(w.db, fx, w.staff.officer);
    const job = createJob(w.db, w.staff.dispatcher, fullSpec());
    assignJob(w.db, w.staff.dispatcher, job.id, assignmentFor(fx));
    verifySite(w.db, w.staff.dispatcher, job.id);
    const ev = attemptSet(w.db, w.staff.dispatcher, job.id);
    assert.equal(ev.status, 'RED');
    assert.ok(codes(ev).includes('GENERATOR_BELOW_MIN_KW'));
  });

  it('hitch mismatch and tow-rating exceedance → RED HITCH_MISMATCH / TRUCK_TOW_RATING_EXCEEDED', () => {
    const w = world();
    const fx = makeOperator(w.db, w.staff, { legalName: 'Pickup Co (FICTIONAL)', email: 'pickup@t.test', userName: 'Pickup Op', truck: { hitch_type: 'BALL_2_5_16', tow_rating_lbs: 5000 } }, w.storage);
    verifyOperator(w.db, fx, w.staff.officer);
    const job = createJob(w.db, w.staff.dispatcher, fullSpec());
    assignJob(w.db, w.staff.dispatcher, job.id, assignmentFor(fx));
    verifySite(w.db, w.staff.dispatcher, job.id);
    const ev = evaluateJob(w.db, getJobRow(w.db, job.id), currentPolicy(w.db));
    assert.equal(ev.status, 'RED');
    assert.ok(codes(ev).includes('HITCH_MISMATCH'));
    assert.ok(codes(ev).includes('TRUCK_TOW_RATING_EXCEEDED'));
  });

  it('verified site power with the wrong phase and no generator → RED (connector names are not treated as compatibility)', () => {
    const w = world();
    const job = greenReadyJob(w, { site_power_status: 'AVAILABLE', site_voltage: 208, site_phase: 'THREE', site_amperage: 30, site_connector: 'NEMA_L14_30' });
    assignJob(w.db, w.staff.dispatcher, job.id, assignmentFor(w.good, { power_id: null }));
    const ev = evaluateJob(w.db, getJobRow(w.db, job.id), currentPolicy(w.db));
    assert.equal(ev.status, 'RED');
    assert.ok(codes(ev).includes('SITE_PHASE_MISMATCH'), codes(ev).join(','));
  });

  it('asset class mismatch → RED ASSET_CLASS_MISMATCH', () => {
    const w = world();
    const job = greenReadyJob(w, { required_asset_class: 'REEFER_CONTAINER_20FT' });
    const ev = evaluateJob(w.db, getJobRow(w.db, job.id), currentPolicy(w.db));
    assert.equal(ev.status, 'RED');
    assert.ok(codes(ev).includes('ASSET_CLASS_MISMATCH'));
  });
});

describe('5. A YELLOW or RED job cannot be dispatched, including through a direct API request', () => {
  it('direct API dispatch of a YELLOW job (with a forged GREEN status in the body) is refused and recorded', async () => {
    const w = world();
    const job = createJob(w.db, w.staff.dispatcher, fullSpec());
    assignJob(w.db, w.staff.dispatcher, job.id, assignmentFor(w.good));
    const { agent, csrf } = await loginAgent(w.app, 'dispatch@oon-demo.test');
    const res = await agent.post(`/api/jobs/${job.id}/dispatch`).set('x-csrf-token', csrf).send({ status: 'GREEN', stage: 'SET' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NOT_ELIGIBLE');
    assert.equal(getJobRow(w.db, job.id).stage, 'SPEC');
    assert.ok(eventsFor(w.db, 'job', job.id).some((e) => e.event_type === 'DISPATCH_REFUSED'));
  });

  it('a job that passed SET but became RED is re-evaluated at dispatch and refused', async () => {
    const w = world();
    const job = greenReadyJob(w);
    assert.equal(attemptSet(w.db, w.staff.dispatcher, job.id).status, 'GREEN');
    // The site contact is later found to be wrong.
    const contact = activeClaim(w.db, 'job', job.id, 'site.contact')!;
    reviewClaim(w.db, w.staff.dispatcher, contact.id, { decision: 'REJECTED', note: 'Contact no longer at venue' });
    const { agent, csrf } = await loginAgent(w.app, 'dispatch@oon-demo.test');
    const res = await agent.post(`/api/jobs/${job.id}/dispatch`).set('x-csrf-token', csrf).send({});
    assert.equal(res.status, 409);
    assert.ok(res.body.error.details.some((r: { code: string }) => r.code === 'SITE_CONTACT_REJECTED'));
    assert.equal(getJobRow(w.db, job.id).stage, 'SPEC');
    assert.equal(getJobRow(w.db, job.id).dispatched_at, null);
  });
});

describe('6. A GREEN job can be dispatched only by an authorized dispatcher', () => {
  it('officer, finance, admin, auditor and owner-operator are refused; dispatcher succeeds', async () => {
    const w = world();
    const job = greenReadyJob(w);
    assert.equal(attemptSet(w.db, w.staff.dispatcher, job.id).status, 'GREEN');
    for (const email of ['officer@oon-demo.test', 'finance@oon-demo.test', 'admin@oon-demo.test', 'auditor@oon-demo.test', 'good@t.test']) {
      const { agent, csrf } = await loginAgent(w.app, email);
      const res = await agent.post(`/api/jobs/${job.id}/dispatch`).set('x-csrf-token', csrf).send({});
      assert.equal(res.status, 403, email);
    }
    const { agent, csrf } = await loginAgent(w.app, 'dispatch@oon-demo.test');
    const noCsrf = await agent.post(`/api/jobs/${job.id}/dispatch`).send({});
    assert.equal(noCsrf.status, 403, 'CSRF token required');
    const res = await agent.post(`/api/jobs/${job.id}/dispatch`).set('x-csrf-token', csrf).send({});
    assert.equal(res.status, 200);
    const j = getJobRow(w.db, job.id);
    assert.equal(j.stage, 'DISPATCHED');
    assert.equal(j.dispatched_by, w.staff.dispatcher.id);
    const evt = eventsFor(w.db, 'job', job.id).find((e) => e.event_type === 'DISPATCHED')!;
    const packet = JSON.parse(evt.payload_json).packet;
    assert.equal(packet.status, 'GREEN');
    assert.equal(packet.siteContact.confirmation, 'VERIFIED');
    assert.ok(packet.delivery.lat !== null && packet.deliveryWindow.start);
  });
});

describe('7. A SET attempt with missing site evidence records SITE_UNCONFIRMED and preserves the attempt', () => {
  it('attempt + SITE_UNCONFIRMED survive later confirmation and a passing SET', () => {
    const w = world();
    const job = createJob(w.db, w.staff.dispatcher, fullSpec());
    assignJob(w.db, w.staff.dispatcher, job.id, assignmentFor(w.good));
    verifySite(w.db, w.staff.dispatcher, job.id, ['site.pickup', 'site.delivery_pin', 'site.delivery_window', 'site.access', 'site.setpoint_commodity', 'site.power']);
    const ev1 = attemptSet(w.db, w.staff.dispatcher, job.id);
    assert.equal(ev1.status, 'YELLOW');
    assert.ok(ev1.siteUnconfirmed);
    const before = eventsFor(w.db, 'job', job.id).filter((e) => ['SET_ATTEMPTED', 'SITE_UNCONFIRMED', 'SET_BLOCKED'].includes(e.event_type));
    assert.deepEqual(before.map((e) => e.event_type), ['SET_ATTEMPTED', 'SITE_UNCONFIRMED', 'SET_BLOCKED']);
    const siteEvt = JSON.parse(before[1].payload_json);
    assert.ok(siteEvt.reasons.some((r: { code: string }) => r.code === 'SITE_CONTACT_UNCONFIRMED'));
    const blocked = JSON.parse(before[2].payload_json);
    assert.ok(blocked.failedGates.some((g: { gate: string }) => g.gate === 'SITE'));

    verifySite(w.db, w.staff.dispatcher, job.id, ['site.contact']);
    assert.equal(attemptSet(w.db, w.staff.dispatcher, job.id).status, 'GREEN');
    const all = eventsFor(w.db, 'job', job.id);
    for (const e of before) {
      const still = all.find((x) => x.event_id === e.event_id)!;
      assert.equal(still.event_hash, e.event_hash);
      assert.equal(still.payload_json, e.payload_json);
    }
    const types = all.map((e) => e.event_type);
    assert.ok(types.indexOf('HUMAN_CONFIRMED') > types.indexOf('SITE_UNCONFIRMED'));
    assert.ok(types.indexOf('SET_PASSED') > types.indexOf('HUMAN_CONFIRMED'));
  });
});

function runToPod(w: ReturnType<typeof world>) {
  const job = greenReadyJob(w);
  attemptSet(w.db, w.staff.dispatcher, job.id);
  dispatchJob(w.db, w.staff.dispatcher, job.id);
  markArrived(w.db, w.good.user, job.id);
  markDelivered(w.db, w.good.user, job.id, undefined, 'ok', 35);
  const doc = uploadDocument(w.db, w.storage, w.good.user, { jobId: job.id, category: 'POD', filename: 'pod.pdf', declaredMime: 'application/pdf', data: demoPdf('pod') });
  recordPod(w.db, w.good.user, job.id, { receiver_name: 'Test Receiver', received_at: new Date().toISOString(), delivered_temp_f: 35, document_ids: [doc.id] });
  return job;
}

describe('8. Corrections create new events and do not rewrite earlier events', () => {
  it('a post-seal correction is a new linked event; earlier events and the sealed manifest are unchanged', () => {
    const w = world();
    const job = runToPod(w);
    const { manifest } = sealJob(w.db, w.staff.officer, job.id);
    const snap = ledgerSnapshot(w.db);
    const corr = recordCorrection(w.db, w.staff.dispatcher, job.id, { field: 'receiver_name', corrected_value: 'Test Receiver Jr.', reason: 'Receiver name misspelled on POD' });
    assert.equal(corr.event_type, 'CORRECTION_RECORDED');
    const sealEvt = eventsFor(w.db, 'job', job.id).find((e) => e.event_type === 'SEALED')!;
    assert.equal(corr.related_event_id, sealEvt.event_id);
    const after = ledgerSnapshot(w.db);
    assert.deepEqual(after.slice(0, snap.length), snap);
    assert.equal(get<{ manifest_hash: string }>(w.db, 'SELECT manifest_hash FROM sealed_manifests WHERE id = ?', manifest.id)!.manifest_hash, manifest.manifest_hash);
    // A supplemental manifest supersedes but preserves the original.
    const supp = sealJob(w.db, w.staff.officer, job.id).manifest;
    assert.equal(supp.version, 2);
    assert.equal(supp.supersedes_manifest_id, manifest.id);
    assert.equal(JSON.parse(supp.manifest_json).corrections.length, 1);
    assert.ok(verifyManifest(w.db, manifest.id).ok);
    assert.ok(verifyManifest(w.db, supp.id).ok);
  });

  it('changing an entered value creates a new claim; the old claim and its verification remain', () => {
    const w = world();
    const old = activeClaim(w.db, 'truck', w.good.truckId, 'truck.cargo_insurance')!;
    assert.equal(viewClaim(w.db, old).status, 'VERIFIED');
    saveSubject(w.db, w.good.user, 'truck', w.good.ownerOperatorId, w.good.truckId, { ...get<Record<string, unknown>>(w.db, 'SELECT * FROM trucks WHERE id = ?', w.good.truckId), cargo_coverage_usd: 150_000 });
    const hist = claimHistory(w.db, 'truck', w.good.truckId, 'truck.cargo_insurance');
    const kept = hist.find((h) => h.claim.id === old.id)!;
    assert.equal(kept.status, 'VERIFIED');
    assert.equal(kept.values.cargo_coverage_usd, 100_000);
    assert.equal(kept.history.at(-1)!.actor_id, w.staff.officer.id);
    const latest = hist.at(-1)!;
    assert.equal(latest.claim.supersedes_id, old.id);
    assert.equal(latest.status, 'OPERATOR_ENTERED');
    assert.equal(latest.values.cargo_coverage_usd, 150_000);
    // The documents attached to the old version carry forward, but the new values still need review.
    assert.deepEqual(latest.documentIds, kept.documentIds);
    // The TRUCK gate is no longer verified until the new value is reviewed and signed off.
    assert.equal(subjectGateStatus(w.db, currentPolicy(w.db), 'TRUCK', 'truck', w.good.truckId).status, 'PENDING_REVIEW');
  });

  it('the database refuses UPDATE/DELETE on ledger events, claims and manifests', () => {
    const w = world();
    assert.throws(() => w.db.exec("UPDATE ledger_events SET event_type = 'X'"), /append-only/);
    assert.throws(() => w.db.exec('DELETE FROM ledger_events'), /append-only/);
    assert.throws(() => w.db.exec("UPDATE evidence_claims SET claimed_json = '{}'"), /append-only/);
    assert.throws(() => w.db.exec("UPDATE evidence_status_events SET status = 'VERIFIED'"), /append-only/);
  });
});

describe('9. Sealing creates a reproducible hash for the evidence manifest', () => {
  it('recomputing the canonical hash reproduces the stored hash, independent of key order', () => {
    const w = world();
    const job = runToPod(w);
    const { manifest } = sealJob(w.db, w.staff.officer, job.id);
    const parsed = JSON.parse(manifest.manifest_json);
    assert.equal(sha256Hex(canonicalJson(parsed)), manifest.manifest_hash);
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    assert.equal(sha256Hex(canonicalJson(reversed)), manifest.manifest_hash);
    const pkg = exportPackage(w.db, w.staff.auditor, job.id);
    assert.equal(pkg.manifestHash, manifest.manifest_hash);
    assert.ok(verifyExportedPackage(w.db, w.staff.auditor, JSON.parse(JSON.stringify(pkg))).ok);
    assert.match(pkg.disclaimer, /does not prove/);
    assert.equal(getJobRow(w.db, job.id).stage, 'SEALED');
    assert.equal(parsed.gateResultsAtDispatch.SITE, 'VERIFIED');
    assert.ok(parsed.timestamps.dispatchedAt && parsed.timestamps.podRecordedAt && parsed.timestamps.sealedAt);
  });
});

describe('10. Altering a sealed package causes verification to report a hash mismatch', () => {
  it('a modified exported package fails verification', () => {
    const w = world();
    const job = runToPod(w);
    sealJob(w.db, w.staff.officer, job.id);
    const pkg = JSON.parse(JSON.stringify(exportPackage(w.db, w.staff.auditor, job.id)));
    pkg.manifest.setpointF = 20;
    const v = verifyExportedPackage(w.db, w.staff.auditor, pkg);
    assert.equal(v.ok, false);
    assert.equal(v.matchesProvidedHash, false);
  });

  it('tampering with the stored manifest (bypassing triggers) is detected, as is tampering with a ledger event', () => {
    const w = world();
    const job = runToPod(w);
    const { manifest } = sealJob(w.db, w.staff.officer, job.id);
    // Simulate an attacker with direct database access who removes the guard.
    w.db.exec('DROP TRIGGER manifests_no_update');
    const tampered = JSON.parse(manifest.manifest_json);
    tampered.commodity = 'Something else';
    w.db.prepare('UPDATE sealed_manifests SET manifest_json = ? WHERE id = ?').run(canonicalJson(tampered), manifest.id);
    const v = verifyManifest(w.db, manifest.id);
    assert.equal(v.ok, false);
    assert.equal(v.manifestHashMatches, false);
    // Even if the attacker also rewrites the stored hash, the ledger anchor disagrees.
    w.db.prepare('UPDATE sealed_manifests SET manifest_hash = ? WHERE id = ?').run(sha256Hex(canonicalJson(tampered)), manifest.id);
    const v2 = verifyManifest(w.db, manifest.id);
    assert.equal(v2.manifestHashMatches, true);
    assert.equal(v2.ledgerAnchorMatches, false);
    assert.equal(v2.ok, false);

    w.db.exec('DROP TRIGGER ledger_no_update');
    w.db.prepare("UPDATE ledger_events SET payload_json = '{}' WHERE event_type = 'DISPATCHED'").run();
    const chain = verifyLedger(w.db);
    assert.ok(chain.problems.some((p) => p.problem === 'HASH_MISMATCH'));
  });
});

describe("11. A user cannot access another owner-operator's private documents without permission", () => {
  it('cross-tenant link requests, forged/replayed tokens and unauthorized roles are denied and logged', async () => {
    const w = world();
    const other = makeOperator(w.db, w.staff, { legalName: 'Other Co (FICTIONAL)', email: 'other@t.test', userName: 'Other Op' }, w.storage);
    const doc = uploadDocument(w.db, w.storage, w.good.user, { ownerOperatorId: w.good.ownerOperatorId, category: 'LICENSE', filename: 'license.pdf', declaredMime: 'application/pdf', data: demoPdf('license') });

    assert.throws(() => issueDocumentLink(w.db, other.user, doc.id), { code: 'NOT_FOUND' });
    assert.throws(() => issueDocumentLink(w.db, w.staff.dispatcher, doc.id), { code: 'NOT_FOUND' });
    assert.throws(() => issueDocumentLink(w.db, w.staff.finance, doc.id), { code: 'NOT_FOUND' });
    assert.throws(() => issueDocumentLink(w.db, w.staff.admin, doc.id), { code: 'NOT_FOUND' });

    const link = issueDocumentLink(w.db, w.good.user, doc.id);
    const token = new URL(link.url, 'http://x').searchParams.get('t')!;
    assert.equal(readDocumentContent(w.db, w.storage, w.good.user, doc.id, token).data.subarray(0, 5).toString(), '%PDF-');
    // Replay by another user
    assert.throws(() => readDocumentContent(w.db, w.storage, other.user, doc.id, token), { code: 'NOT_FOUND' });
    // Forged signature
    assert.throws(() => readDocumentContent(w.db, w.storage, w.good.user, doc.id, `${token.split('.')[0]}.AAAA`), { code: 'NOT_FOUND' });
    // Qualification officer may read for review
    assert.ok(issueDocumentLink(w.db, w.staff.officer, doc.id).url);

    const { agent } = await loginAgent(w.app, 'other@t.test');
    assert.equal((await agent.get(`/api/documents/${doc.id}/link`)).status, 404);
    assert.equal((await agent.get(`/documents/${doc.id}/content?t=${token}`)).status, 404);
    assert.equal((await agent.get(`/api/owner-operators/${w.good.ownerOperatorId}`)).status, 404);
    const docsRes = await agent.get(`/api/owner-operators/${w.good.ownerOperatorId}/documents`);
    assert.equal(docsRes.status, 404);

    const denied = w.db.prepare('SELECT COUNT(*) n FROM document_access_log WHERE document_id = ? AND granted = 0').get(doc.id) as { n: number };
    assert.ok(denied.n >= 5);
  });

  it('uploads are validated by content signature and size', () => {
    const w = world();
    const up = (data: Buffer, mime: string) => uploadDocument(w.db, w.storage, w.good.user, { ownerOperatorId: w.good.ownerOperatorId, category: 'LICENSE', filename: 'x', declaredMime: mime, data });
    assert.throws(() => up(Buffer.from('<script>alert(1)</script>'), 'application/pdf'), { code: 'VALIDATION_FAILED' });
    assert.throws(() => up(demoPdf('x'), 'image/png'), { code: 'VALIDATION_FAILED' });
    assert.throws(() => up(Buffer.alloc(0), 'application/pdf'), { code: 'VALIDATION_FAILED' });
  });
});

describe('12. Policy changes are versioned and do not silently rewrite historical job decisions', () => {
  it('a stricter policy creates v2; v1 jobs keep their version and recorded decision; new jobs use v2', () => {
    const w = world();
    const job = greenReadyJob(w);
    const ev1 = attemptSet(w.db, w.staff.dispatcher, job.id);
    assert.equal(ev1.status, 'GREEN');
    const setEvt = eventsFor(w.db, 'job', job.id).find((e) => e.event_type === 'SET_PASSED')!;
    const v1 = currentPolicy(w.db);

    assert.throws(() => createPolicyVersion(w.db, w.staff.dispatcher, v1.config, 'try'), { code: 'FORBIDDEN' });
    const stricter = structuredClone(v1.config);
    stricter.truck.minAutoLiabilityUsd = 2_000_000;
    const v2 = createPolicyVersion(w.db, w.staff.admin, stricter, 'Raise auto liability network threshold');
    assert.equal(v2.version, v1.version + 1);
    assert.equal(policyByVersion(w.db, v1.version).config.truck.minAutoLiabilityUsd, 1_000_000);
    assert.throws(() => w.db.exec('UPDATE policy_versions SET change_note = 1'), /append-only/);

    // Existing job: still pinned to v1, still GREEN, historical event unchanged, and dispatchable.
    assert.equal(getJobRow(w.db, job.id).policy_version, v1.version);
    assert.equal(evaluateJob(w.db, getJobRow(w.db, job.id), policyByVersion(w.db, getJobRow(w.db, job.id).policy_version)).status, 'GREEN');
    assert.equal(eventsFor(w.db, 'job', job.id).find((e) => e.event_id === setEvt.event_id)!.event_hash, setEvt.event_hash);
    dispatchJob(w.db, w.staff.dispatcher, job.id);

    // New job: pinned to v2 and RED under the stricter threshold.
    const job2 = greenReadyJob(w);
    assert.equal(job2.policy_version, v2.version);
    const ev2 = attemptSet(w.db, w.staff.dispatcher, job2.id);
    assert.equal(ev2.status, 'RED');
    assert.ok(codes(ev2).includes('AUTO_LIABILITY_BELOW_NETWORK_THRESHOLD'));
    assert.ok(ev2.reasons.find((r) => r.code === 'AUTO_LIABILITY_BELOW_NETWORK_THRESHOLD')!.message.includes('configured network threshold'));
  });

  it('re-pinning an undispatched job to a new policy is explicit and recorded', () => {
    const w = world();
    const job = greenReadyJob(w);
    const v1 = currentPolicy(w.db);
    const next = structuredClone(v1.config);
    next.power.maxCableRunFt = 150;
    createPolicyVersion(w.db, w.staff.admin, next, 'Longer cable runs');
    assert.equal(getJobRow(w.db, job.id).policy_version, v1.version);
    repinPolicy(w.db, w.staff.dispatcher, job.id);
    assert.equal(getJobRow(w.db, job.id).policy_version, v1.version + 1);
    const e = eventsFor(w.db, 'job', job.id).find((x) => x.event_type === 'POLICY_REPINNED')!;
    assert.deepEqual(JSON.parse(e.payload_json), { from: v1.version, to: v1.version + 1 });
  });

  it('gate reviews retain the policy version they were made under', () => {
    const w = world();
    const r = w.db.prepare('SELECT DISTINCT policy_version FROM gate_reviews').all() as { policy_version: number }[];
    assert.deepEqual(r.map((x) => x.policy_version), [1]);
    const next = structuredClone(currentPolicy(w.db).config);
    next.asset.maxInspectionAgeDays = 30;
    createPolicyVersion(w.db, w.staff.admin, next, 'Stricter inspection age');
    // Under v2 the 60-day-old inspection is expired; under v1 it is not.
    assert.equal(subjectGateStatus(w.db, policyByVersion(w.db, 1), 'ASSET', 'cold_asset', w.good.assetId).status, 'VERIFIED');
    assert.equal(subjectGateStatus(w.db, policyByVersion(w.db, 2), 'ASSET', 'cold_asset', w.good.assetId).status, 'EXPIRED');
  });
});

describe('Additional safeguards', () => {
  it('requires authentication for API calls', async () => {
    const w = world();
    const { default: request } = await import('supertest');
    assert.equal((await request(w.app).get('/api/jobs')).status, 401);
  });

  it('spec edits after dispatch are refused; job edits before dispatch invalidate a passed SET', () => {
    const w = world();
    const job = greenReadyJob(w);
    attemptSet(w.db, w.staff.dispatcher, job.id);
    updateJobSpec(w.db, w.staff.dispatcher, job.id, fullSpec({ setpoint_f: 34 }));
    assert.equal(getJobRow(w.db, job.id).stage, 'SPEC');
    assert.ok(eventsFor(w.db, 'job', job.id).some((e) => e.event_type === 'SET_INVALIDATED'));
    verifySite(w.db, w.staff.dispatcher, job.id);
    attemptSet(w.db, w.staff.dispatcher, job.id);
    dispatchJob(w.db, w.staff.dispatcher, job.id);
    assert.throws(() => updateJobSpec(w.db, w.staff.dispatcher, job.id, fullSpec()), { code: 'CONFLICT' });
  });

  it('owner-operators only see jobs assigned to them', async () => {
    const w = world();
    const other = makeOperator(w.db, w.staff, { legalName: 'Other Co (FICTIONAL)', email: 'other2@t.test', userName: 'Other Op' });
    const job = greenReadyJob(w);
    const { agent } = await loginAgent(w.app, 'other2@t.test');
    assert.equal((await agent.get(`/api/jobs/${job.id}`)).status, 404);
    assert.deepEqual((await agent.get('/api/jobs')).body, []);
    void other;
    const mine = await loginAgent(w.app, 'good@t.test');
    assert.equal((await mine.agent.get(`/api/jobs/${job.id}`)).status, 200);
  });
});
