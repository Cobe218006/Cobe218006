import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { AppError, invalid } from '../errors.js';
import type { Actor } from '../domain/types.js';
import { accessLog, issueDocumentLink, listDocuments, runRetention, setLegalHold, uploadDocument } from '../domain/documents.js';
import { attachDocumentToClaim, reviewClaim, submitForReview } from '../domain/evidence.js';
import { createOwnerOperator, listOwnerOperators, ownerOperatorBundle, recordGateReview, saveSubject, submitOnboarding, updateOwnerOperator } from '../domain/onboarding.js';
import { assignJob, attemptSet, createJob, dispatchJob, evaluate, getJob, jobPacket, jobPods, jobTimeline, listJobs, markArrived, markDelivered, recordPod, repinPolicy, updateJobSpec } from '../domain/jobs.js';
import { exportPackage, manifestsFor, recordCorrection, sealJob, verifyExportedPackage, verifyManifestFor } from '../domain/vault.js';
import { verifyLedger } from '../domain/ledger.js';
import { requirePerm } from '../domain/permissions.js';
import { createPolicyVersion, currentPolicy, listPolicies } from '../domain/policy.js';
import { addLineItem, createInvoice, getInvoice, listInvoices, recordPayment, setInvoiceStatus } from '../domain/invoices.js';
import { listMessages, postMessage } from '../domain/messages.js';
import { createUser, listUsers, login, logout, setUserActive, setUserRoles } from '../domain/users.js';
import { dashboard } from '../domain/dashboard.js';
import { integrationStatuses } from '../domain/integrations.js';
import { evaluateJob } from '../domain/gates.js';
import { policyByVersion } from '../domain/policy.js';
import type { AppDeps } from './app.js';
import { loginRateLimit, SESSION_COOKIE, setSessionCookie } from './app.js';

type Handler = (req: Request, actor: Actor) => unknown;

export function authed(fn: Handler, status = 200) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.actor) throw new AppError('UNAUTHENTICATED', 'Login required.');
      const out = fn(req, req.actor);
      res.status(status).json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };
}

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 } });

const SUBJECT_PATHS = { drivers: 'driver', trucks: 'truck', assets: 'cold_asset', 'power-configs': 'power_config', adapters: 'power_adapter' } as const;
type SubjectPath = keyof typeof SUBJECT_PATHS;
const subjectType = (p: string) => {
  const st = SUBJECT_PATHS[p as SubjectPath];
  if (!st) throw new AppError('NOT_FOUND', 'Unknown subject type.');
  return st;
};

export function apiRouter({ db, storage }: AppDeps) {
  const r = Router();
  const p = (req: Request, k: string) => String(req.params[k]);

  // ---- auth
  r.post('/auth/login', (req, res, next) => {
    try {
      loginRateLimit(req);
      const s = login(db, req.body?.email, req.body?.password);
      setSessionCookie(res, s.token, s.expires);
      res.json({ csrfToken: s.csrf, expiresAt: s.expires });
    } catch (e) {
      next(e);
    }
  });
  r.post('/auth/logout', (req, res) => {
    logout(db, req.sessionToken);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });
  r.get('/me', authed((req, a) => ({ user: a, csrfToken: req.csrf })));
  r.get('/dashboard', authed((_q, a) => dashboard(db, a)));
  r.get('/integrations', authed(() => integrationStatuses(storage.name)));

  // ---- owner-operators & onboarding
  r.get('/owner-operators', authed((_q, a) => listOwnerOperators(db, a)));
  r.post('/owner-operators', authed((q, a) => createOwnerOperator(db, a, q.body), 201));
  r.get('/owner-operators/:id', authed((q, a) => ownerOperatorBundle(db, a, p(q, 'id'))));
  r.put('/owner-operators/:id', authed((q, a) => updateOwnerOperator(db, a, p(q, 'id'), q.body)));
  r.post('/owner-operators/:id/submit', authed((q, a) => ({ submitted: submitOnboarding(db, a, p(q, 'id')) })));
  r.post('/owner-operators/:id/:kind', authed((q, a) => saveSubject(db, a, subjectType(p(q, 'kind')), p(q, 'id'), null, q.body), 201));
  r.put('/owner-operators/:id/:kind/:sid', authed((q, a) => saveSubject(db, a, subjectType(p(q, 'kind')), p(q, 'id'), p(q, 'sid'), q.body)));
  r.get('/owner-operators/:id/documents', authed((q, a) => {
    ownerOperatorBundle(db, a, p(q, 'id'));
    return listDocuments(db, a, { ownerOperatorId: p(q, 'id') }).map(({ storage_key: _k, ...d }) => d);
  }));

  // ---- evidence review
  r.post('/evidence/:id/review', authed((q, a) => reviewClaim(db, a, p(q, 'id'), { decision: q.body?.decision, note: q.body?.note, basis: q.body?.basis, supportingMessageId: q.body?.supportingMessageId })));
  r.post('/evidence/:id/submit', authed((q, a) => ({ submitted: submitForReview(db, a, [p(q, 'id')]) })));
  r.post('/evidence/:id/documents', authed((q, a) => attachDocumentToClaim(db, a, p(q, 'id'), String(q.body?.documentId ?? ''))));
  r.post('/gates/review', authed((q, a) => recordGateReview(db, a, q.body?.gate, q.body?.subjectType, q.body?.subjectId, q.body?.decision, q.body?.note)));

  // ---- documents
  r.post('/documents', upload.single('file'), authed((q, a) => {
    if (!q.file) throw invalid('File is required (field "file").');
    const d = uploadDocument(db, storage, a, { ownerOperatorId: q.body?.ownerOperatorId, jobId: q.body?.jobId, category: q.body?.category, filename: q.file.originalname, declaredMime: q.file.mimetype, data: q.file.buffer });
    const { storage_key: _k, ...safe } = d;
    return safe;
  }, 201));
  r.get('/documents/:id/link', authed((q, a) => issueDocumentLink(db, a, p(q, 'id'))));
  r.get('/documents/:id/access-log', authed((q, a) => accessLog(db, a, p(q, 'id'))));
  r.post('/documents/:id/legal-hold', authed((q, a) => setLegalHold(db, a, p(q, 'id'), q.body?.hold === true || q.body?.hold === 'true', q.body?.reason)));
  r.post('/admin/retention/run', authed((q, a) => runRetention(db, storage, a, undefined, q.body?.dryRun !== false && q.body?.dryRun !== 'false')));

  // ---- jobs / dispatch
  r.get('/jobs', authed((_q, a) => listJobs(db, a)));
  r.post('/jobs', authed((q, a) => createJob(db, a, q.body), 201));
  r.get('/jobs/:id', authed((q, a) => {
    const job = getJob(db, a, p(q, 'id'));
    const ev = evaluateJob(db, job, policyByVersion(db, job.policy_version));
    return { job, evaluation: ev, packet: jobPacket(db, job, ev), pods: jobPods(db, job.id), manifests: manifestsFor(db, job.id).map((m) => ({ id: m.id, version: m.version, hash: m.manifest_hash, sealedAt: m.sealed_at })) };
  }));
  r.put('/jobs/:id/spec', authed((q, a) => updateJobSpec(db, a, p(q, 'id'), q.body)));
  r.post('/jobs/:id/assign', authed((q, a) => assignJob(db, a, p(q, 'id'), q.body)));
  r.post('/jobs/:id/repin-policy', authed((q, a) => repinPolicy(db, a, p(q, 'id'))));
  r.get('/jobs/:id/evaluation', authed((q, a) => evaluate(db, a, p(q, 'id'))));
  r.post('/jobs/:id/set', authed((q, a) => attemptSet(db, a, p(q, 'id'))));
  // Any client-supplied "status" in the body is ignored; eligibility is computed server-side.
  r.post('/jobs/:id/dispatch', authed((q, a) => dispatchJob(db, a, p(q, 'id'))));
  r.post('/jobs/:id/arrive', authed((q, a) => markArrived(db, a, p(q, 'id'), q.body?.occurredAt, q.body?.note)));
  r.post('/jobs/:id/deliver', authed((q, a) => markDelivered(db, a, p(q, 'id'), q.body?.occurredAt, q.body?.note, q.body?.loggedTempF)));
  r.post('/jobs/:id/pod', authed((q, a) => recordPod(db, a, p(q, 'id'), q.body), 201));
  r.post('/jobs/:id/seal', authed((q, a) => sealJob(db, a, p(q, 'id')), 201));
  r.post('/jobs/:id/corrections', authed((q, a) => recordCorrection(db, a, p(q, 'id'), q.body), 201));
  r.get('/jobs/:id/timeline', authed((q, a) => jobTimeline(db, a, p(q, 'id'))));
  r.get('/jobs/:id/export', authed((q, a) => exportPackage(db, a, p(q, 'id'), q.query.manifestId as string | undefined)));
  r.get('/jobs/:id/documents', authed((q, a) => {
    getJob(db, a, p(q, 'id'));
    return listDocuments(db, a, { jobId: p(q, 'id') }).map(({ storage_key: _k, ...d }) => d);
  }));
  r.get('/jobs/:id/messages', authed((q, a) => listMessages(db, a, p(q, 'id'))));
  r.post('/jobs/:id/messages', authed((q, a) => ({ id: postMessage(db, a, p(q, 'id'), q.body?.body) }), 201));

  // ---- vault verification
  r.get('/manifests/:id/verify', authed((q, a) => verifyManifestFor(db, a, p(q, 'id'))));
  r.post('/vault/verify-package', authed((q, a) => verifyExportedPackage(db, a, q.body)));
  r.get('/ledger/verify', authed((_q, a) => {
    requirePerm(a, 'ledger.read_all');
    return verifyLedger(db);
  }));

  // ---- policy
  r.get('/policies', authed(() => listPolicies(db)));
  r.get('/policies/current', authed(() => currentPolicy(db)));
  r.post('/policies', authed((q, a) => createPolicyVersion(db, a, q.body?.config, q.body?.note), 201));

  // ---- invoices
  r.get('/invoices', authed((_q, a) => listInvoices(db, a)));
  r.post('/invoices', authed((q, a) => createInvoice(db, a, q.body), 201));
  r.get('/invoices/:id', authed((q, a) => getInvoice(db, a, p(q, 'id'))));
  r.post('/invoices/:id/lines', authed((q, a) => ({ id: addLineItem(db, a, p(q, 'id'), q.body) }), 201));
  r.post('/invoices/:id/issue', authed((q, a) => setInvoiceStatus(db, a, p(q, 'id'), 'ISSUE')));
  r.post('/invoices/:id/void', authed((q, a) => setInvoiceStatus(db, a, p(q, 'id'), 'VOID', q.body?.reason)));
  r.post('/invoices/:id/payments', authed((q, a) => ({ id: recordPayment(db, a, p(q, 'id'), q.body) }), 201));

  // ---- users
  r.get('/users', authed((_q, a) => listUsers(db, a)));
  r.post('/users', authed((q, a) => ({ id: createUser(db, a, q.body) }), 201));
  r.post('/users/:id/roles', authed((q, a) => setUserRoles(db, a, p(q, 'id'), q.body?.roles)));
  r.post('/users/:id/active', authed((q, a) => setUserActive(db, a, p(q, 'id'), q.body?.active === true || q.body?.active === 'true')));

  return r;
}
