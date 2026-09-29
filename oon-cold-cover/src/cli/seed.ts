/**
 * Seeds DEMO / FICTIONAL data through the real domain services, so every record
 * has a genuine event history. Refuses to run in production unless ALLOW_DEMO_SEED=true.
 */
import { config } from '../config.js';
import { get, migrate, openDb } from '../db.js';
import { LocalPrivateStorage, uploadDocument } from '../domain/documents.js';
import { assignJob, attemptSet, createJob, dispatchJob, markArrived, markDelivered, recordPod, updateJobSpec } from '../domain/jobs.js';
import { postMessage } from '../domain/messages.js';
import { ensureDefaultPolicy } from '../domain/policy.js';
import { addLineItem, createInvoice, recordPayment, setInvoiceStatus } from '../domain/invoices.js';
import { sealJob } from '../domain/vault.js';
import { DEMO_PASSWORD, demoPdf, fullSpec, makeOperator, makeStaff, makeUser, verifyOperator, verifySite } from '../demo/fixtures.js';

if (!config.allowDemoSeed) {
  console.error('Refusing to seed demo data in production. Set ALLOW_DEMO_SEED=true to override.');
  process.exit(1);
}
const db = openDb(config.databasePath);
migrate(db);
ensureDefaultPolicy(db);
if (get(db, 'SELECT 1 FROM users LIMIT 1')) {
  console.error(`Database ${config.databasePath} already has users. Delete the data/ directory to reseed.`);
  process.exit(1);
}
const storage = new LocalPrivateStorage(config.storageDir);

const staff = makeStaff(db);
makeUser(db, 'dispatch-reviewer@oon-demo.test', 'Robin Dispatch+Review (demo)', ['DISPATCHER', 'QUALIFICATION_OFFICER']);

// Eligible owner-operator: every item verified by the qualification officer.
const good = makeOperator(db, staff, { legalName: 'Northwind Cold Haul LLC (DEMO / FICTIONAL)', email: 'operator@oon-demo.test', userName: 'Morgan Operator (demo)' }, storage);
verifyOperator(db, good, staff.officer);

// Owner-operator with known incompatibilities (6 kW generator, bumper-pull hitch vs gooseneck asset).
const bad = makeOperator(
  db,
  staff,
  {
    legalName: 'Prairie Reefer Co. (DEMO / FICTIONAL)',
    email: 'operator2@oon-demo.test',
    userName: 'Jordan Operator (demo)',
    truck: { label: 'Demo Pickup 2', vin: '1DEMX0000FXCT0002', hitch_type: 'BALL_2_5_16', tow_rating_lbs: 7000 },
    asset: { unit_id: 'DEMO-RT16-02' },
    power: { label: 'Demo Generator 6 kW', continuous_kw: 6 },
  },
  storage,
);
verifyOperator(db, bad, staff.officer);

// Incomplete applicant: profile only, nothing reviewed.
makeOperator(db, staff, { legalName: 'Coastal Chill Transport (DEMO / FICTIONAL)', email: 'operator3@oon-demo.test', userName: 'Casey Applicant (demo)', adapter: null });

const D = staff.dispatcher;
const assignGood = { owner_operator_id: good.ownerOperatorId, driver_id: good.driverId, truck_id: good.truckId, asset_id: good.assetId, power_id: good.powerId };

// 1) YELLOW: missing delivery pin, contact not yet confirmed.
const yellow = createJob(db, D, fullSpec({ customer_name: 'Demo Farmers Market (YELLOW example)', delivery_lat: null, delivery_lng: null }), { isDemo: true });
assignJob(db, D, yellow.id, assignGood);
verifySite(db, D, yellow.id, ['site.pickup', 'site.delivery_window', 'site.setpoint_commodity', 'site.power']);
attemptSet(db, D, yellow.id);

// 2) RED: generator below 10 kW with destination power unavailable; hitch mismatch.
const red = createJob(db, D, fullSpec({ customer_name: 'Demo Street Festival (RED example)' }), { isDemo: true });
assignJob(db, D, red.id, { owner_operator_id: bad.ownerOperatorId, driver_id: bad.driverId, truck_id: bad.truckId, asset_id: bad.assetId, power_id: bad.powerId });
verifySite(db, D, red.id);
attemptSet(db, D, red.id);

// 3) GREEN with full history: SET attempted before the human contact is confirmed, then confirmed, passed and dispatched.
const green = createJob(db, D, fullSpec({ customer_name: 'Demo Relief Staging Site (GREEN example)' }), { isDemo: true });
assignJob(db, D, green.id, assignGood);
verifySite(db, D, green.id, ['site.pickup', 'site.delivery_pin', 'site.delivery_window', 'site.access', 'site.setpoint_commodity', 'site.power']);
attemptSet(db, D, green.id); // SET_ATTEMPTED + SITE_UNCONFIRMED (no named contact verified)
postMessage(db, D, green.id, 'Calling Sam at the site to confirm the gate code and window.');
verifySite(db, D, green.id, ['site.contact']); // HUMAN_CONFIRMED
attemptSet(db, D, green.id); // SET_PASSED
dispatchJob(db, D, green.id);
postMessage(db, good.user, green.id, 'Rolling now. ETA per window.');

// 4) Sealed Proof Vault record: full lifecycle through POD and SEAL.
const sealed = createJob(db, D, fullSpec({ customer_name: 'Demo Catering Pop-up (SEALED example)', ...{ window_start: new Date(Date.now() + 3600_000).toISOString(), window_end: new Date(Date.now() + 6 * 3600_000).toISOString() } }), { isDemo: true });
assignJob(db, D, sealed.id, assignGood);
verifySite(db, D, sealed.id);
attemptSet(db, D, sealed.id);
dispatchJob(db, D, sealed.id);
markArrived(db, good.user, sealed.id, undefined, 'On site, gate C.');
markDelivered(db, good.user, sealed.id, undefined, 'Unit running at setpoint (operator-reported).', 35.5);
const pod = uploadDocument(db, storage, good.user, { jobId: sealed.id, category: 'POD', filename: 'demo-pod.pdf', declaredMime: 'application/pdf', data: demoPdf('POD signed by demo receiver') });
recordPod(db, good.user, sealed.id, { receiver_name: 'Riley Receiver (demo)', received_at: new Date().toISOString(), delivered_temp_f: 35.5, notes: 'DEMO POD', document_ids: [pod.id] });
sealJob(db, staff.officer, sealed.id);

// Also a job still in QUOTE stage, for editing demos.
const quote = createJob(db, D, { customer_name: 'Demo Wedding Reception (quote only)' }, { isDemo: true });
updateJobSpec(db, D, quote.id, { customer_name: 'Demo Wedding Reception (quote only)', required_asset_class: 'REEFER_TRAILER_16FT', setpoint_f: 36, commodity: 'Beverages (demo)' });

// Invoices
const inv1 = createInvoice(db, staff.finance, { bill_to_name: 'Demo Catering Pop-up (fictional customer)', job_id: sealed.id, owner_operator_id: good.ownerOperatorId, due_date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), notes: 'DEMO invoice' }, { isDemo: true });
addLineItem(db, staff.finance, inv1.id, { category: 'HAUL_SERVICE', description: 'Reefer haul & set, 1 day (demo)', quantity: 1, unit_price_cents: 85000 });
addLineItem(db, staff.finance, inv1.id, { category: 'GENERATOR_POWER', description: 'Generator run-time, 8 h (demo)', quantity: 8, unit_price_cents: 2500 });
setInvoiceStatus(db, staff.finance, inv1.id, 'ISSUE');
recordPayment(db, staff.finance, inv1.id, { amount_cents: 50000, received_at: new Date().toISOString().slice(0, 10), method_note: 'DEMO check #0001 (recorded manually)' });
const inv2 = createInvoice(db, staff.finance, { bill_to_name: 'Northwind Cold Haul LLC (DEMO)', owner_operator_id: good.ownerOperatorId, notes: 'DEMO equipment program invoice' }, { isDemo: true });
addLineItem(db, staff.finance, inv2.id, { category: 'EQUIPMENT_LEASE', description: '16-ft reefer trailer lease, monthly (demo)', quantity: 1, unit_price_cents: 120000 });
addLineItem(db, staff.finance, inv2.id, { category: 'UPFIT_INSTALL', description: 'Temperature logger install (demo)', quantity: 1, unit_price_cents: 30000 });

console.log('Seeded DEMO / FICTIONAL data.');
console.log(`All demo accounts use password: ${DEMO_PASSWORD}`);
for (const e of ['admin', 'officer', 'dispatch', 'finance', 'auditor', 'operator', 'operator2', 'operator3', 'dispatch-reviewer']) console.log(`  ${e}@oon-demo.test`);
