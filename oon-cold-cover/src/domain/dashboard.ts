import { all, get, type DB } from '../db.js';
import { can, isTenantRestricted } from './permissions.js';
import type { Actor } from './types.js';

export function dashboard(db: DB, actor: Actor) {
  const tenant = isTenantRestricted(actor);
  const oo = actor.ownerOperatorId;
  const jobWhere = tenant ? 'WHERE assigned_owner_operator_id = ?' : '';
  const jobArgs = tenant ? [oo] : [];
  const canJobs = tenant || can(actor, 'job.read_all');
  const jobsByStage = canJobs ? all<{ stage: string; n: number }>(db, `SELECT stage, COUNT(*) n FROM jobs ${jobWhere} GROUP BY stage`, ...jobArgs) : [];
  const upcoming = canJobs
    ? all<{ id: string; quote_ref: string; customer_name: string; window_start: string | null; stage: string; is_demo: number }>(
        db,
        `SELECT id, quote_ref, customer_name, window_start, stage, is_demo FROM jobs ${tenant ? 'WHERE assigned_owner_operator_id = ? AND' : 'WHERE'} stage IN ('SPEC','SET','DISPATCHED','ARRIVED') ORDER BY window_start LIMIT 10`,
        ...jobArgs,
      )
    : [];
  const pendingPod = canJobs ? all<{ id: string; quote_ref: string; customer_name: string; is_demo: number }>(db, `SELECT id, quote_ref, customer_name, is_demo FROM jobs ${tenant ? 'WHERE assigned_owner_operator_id = ? AND' : 'WHERE'} stage IN ('DELIVERED','ARRIVED')`, ...jobArgs) : [];
  const onboarding =
    tenant || can(actor, 'owner_operator.read_all')
      ? all<{ id: string; legal_name: string; submitted_at: string | null; is_demo: number }>(db, `SELECT id, legal_name, submitted_at, is_demo FROM owner_operators ${tenant ? 'WHERE id = ?' : ''} ORDER BY updated_at DESC LIMIT 10`, ...(tenant ? [oo] : []))
      : [];
  const pendingReviews =
    can(actor, 'evidence.review') || tenant
      ? (get<{ n: number }>(
          db,
          `SELECT COUNT(*) n FROM evidence_claims c
           WHERE c.subject_type != 'job' ${tenant ? 'AND c.owner_operator_id = ?' : ''}
             AND NOT EXISTS (SELECT 1 FROM evidence_claims s WHERE s.supersedes_id = c.id)
             AND (SELECT status FROM evidence_status_events e WHERE e.claim_id = c.id ORDER BY seq DESC LIMIT 1) = 'PENDING'`,
          ...(tenant ? [oo] : []),
        )?.n ?? 0)
      : null;
  const canInv = tenant || can(actor, 'invoice.read_all');
  const invoices = canInv ? all<{ status: string; n: number }>(db, `SELECT status, COUNT(*) n FROM invoices ${tenant ? 'WHERE owner_operator_id = ?' : ''} GROUP BY status`, ...(tenant ? [oo] : [])) : [];
  return { jobsByStage, upcoming, pendingPod, onboarding, pendingReviews, invoices, canJobs, canInv };
}
