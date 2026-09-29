import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { migrate, openDb, type DB } from '../src/db.js';
import { LocalPrivateStorage } from '../src/domain/documents.js';
import { assignJob, createJob } from '../src/domain/jobs.js';
import { ensureDefaultPolicy } from '../src/domain/policy.js';
import { createApp } from '../src/http/app.js';
import { DEMO_PASSWORD, fullSpec, makeOperator, makeStaff, verifyOperator, verifySite, type OperatorFixture } from '../src/demo/fixtures.js';

export function world() {
  const db = openDb(':memory:');
  migrate(db);
  ensureDefaultPolicy(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oon-test-'));
  const storage = new LocalPrivateStorage(dir);
  const staff = makeStaff(db);
  const good = makeOperator(db, staff, { legalName: 'Test Good Hauler (FICTIONAL)', email: 'good@t.test', userName: 'Good Op' }, storage);
  verifyOperator(db, good, staff.officer);
  const app = createApp({ db, storage });
  return { db, storage, staff, good, app };
}

export type World = ReturnType<typeof world>;

export function assignmentFor(fx: OperatorFixture, overrides: Record<string, unknown> = {}) {
  return { owner_operator_id: fx.ownerOperatorId, driver_id: fx.driverId, truck_id: fx.truckId, asset_id: fx.assetId, power_id: fx.powerId, ...overrides };
}

/** A fully specified job assigned to the verified operator with every site item verified — i.e. eligible for GREEN. */
export function greenReadyJob(w: World, specOverrides: Record<string, unknown> = {}) {
  const job = createJob(w.db, w.staff.dispatcher, fullSpec(specOverrides));
  assignJob(w.db, w.staff.dispatcher, job.id, assignmentFor(w.good));
  verifySite(w.db, w.staff.dispatcher, job.id);
  return job;
}

export async function loginAgent(app: ReturnType<typeof createApp>, email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: DEMO_PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.csrfToken as string };
}

export function ledgerSnapshot(db: DB) {
  return db.prepare('SELECT seq, event_id, event_type, payload_json, event_hash FROM ledger_events ORDER BY seq').all() as { seq: number; event_id: string; event_type: string; payload_json: string; event_hash: string }[];
}
