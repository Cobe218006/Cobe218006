import { z } from 'zod';
import { all, get, insert, tx, update, type DB } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { appendEvent } from './ledger.js';
import { can, isTenantRestricted, requirePerm } from './permissions.js';
import { currentPolicy } from './policy.js';
import type { Actor } from './types.js';

/**
 * Invoices record commercial activity only. No payment processing, lending, tax
 * advice or insurance underwriting is performed. External accounting/payment
 * integrations are "not connected" (see integrations.ts).
 */

export interface InvoiceRow {
  id: string;
  number: string;
  job_id: string | null;
  owner_operator_id: string | null;
  bill_to_name: string;
  status: 'DRAFT' | 'ISSUED' | 'PAID' | 'PARTIALLY_PAID' | 'VOID';
  currency: string;
  due_date: string | null;
  notes: string | null;
  issued_at: string | null;
  is_demo: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const blankToNull = (v: unknown) => (v === '' || v === undefined ? null : v);

export const invoiceSchema = z.object({
  bill_to_name: z.string().trim().min(2).max(200),
  job_id: z.preprocess(blankToNull, z.string().nullable()),
  owner_operator_id: z.preprocess(blankToNull, z.string().nullable()),
  due_date: z.preprocess(blankToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()),
  notes: z.preprocess(blankToNull, z.string().max(1000).nullable()),
});

export const lineItemSchema = z.object({
  category: z.string().min(1),
  description: z.string().trim().min(2).max(300),
  quantity: z.coerce.number().positive().max(100000),
  unit_price_cents: z.coerce.number().int().min(0).max(1_000_000_000),
});

export function listInvoices(db: DB, actor: Actor): InvoiceRow[] {
  if (isTenantRestricted(actor)) return actor.ownerOperatorId ? all<InvoiceRow>(db, 'SELECT * FROM invoices WHERE owner_operator_id = ? ORDER BY created_at DESC', actor.ownerOperatorId) : [];
  requirePerm(actor, 'invoice.read_all');
  return all<InvoiceRow>(db, 'SELECT * FROM invoices ORDER BY created_at DESC');
}

export function getInvoice(db: DB, actor: Actor, id: string) {
  const inv = get<InvoiceRow>(db, 'SELECT * FROM invoices WHERE id = ?', id);
  if (!inv) throw notFound('Invoice');
  if (isTenantRestricted(actor)) {
    if (!actor.ownerOperatorId || inv.owner_operator_id !== actor.ownerOperatorId) throw notFound('Invoice');
  } else requirePerm(actor, 'invoice.read_all');
  const lines = all<{ id: string; category: string; description: string; quantity: number; unit_price_cents: number; amount_cents: number }>(db, 'SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY created_at', id);
  const payments = all<{ id: string; amount_cents: number; received_at: string; method_note: string | null; recorded_by: string }>(db, 'SELECT * FROM payments WHERE invoice_id = ? ORDER BY received_at', id);
  const total = lines.reduce((s, l) => s + l.amount_cents, 0);
  const paid = payments.reduce((s, p) => s + p.amount_cents, 0);
  const job = inv.job_id ? get<{ quote_ref: string; stage: string; pod_recorded_at: string | null }>(db, 'SELECT quote_ref, stage, pod_recorded_at FROM jobs WHERE id = ?', inv.job_id) : null;
  return { invoice: inv, lines, payments, totalCents: total, paidCents: paid, balanceCents: total - paid, job };
}

export function createInvoice(db: DB, actor: Actor, input: unknown, opts: { isDemo?: boolean } = {}): InvoiceRow {
  requirePerm(actor, 'invoice.manage');
  const r = invoiceSchema.safeParse(input);
  if (!r.success) throw invalid('Validation failed.', r.error.flatten());
  const d = r.data;
  return tx(db, () => {
    if (d.job_id && !get(db, 'SELECT 1 FROM jobs WHERE id = ?', d.job_id)) throw notFound('Job');
    if (d.owner_operator_id && !get(db, 'SELECT 1 FROM owner_operators WHERE id = ?', d.owner_operator_id)) throw notFound('Owner-operator');
    const id = newId('inv');
    const n = get<{ n: number }>(db, 'SELECT COUNT(*) n FROM invoices')!.n + 1;
    const at = nowIso();
    insert(db, 'invoices', { id, number: `INV-${String(n).padStart(5, '0')}`, ...d, status: 'DRAFT', currency: 'USD', is_demo: opts.isDemo ? 1 : 0, created_by: actor.id, created_at: at, updated_at: at });
    appendEvent(db, { entityType: 'invoice', entityId: id, eventType: 'INVOICE_CREATED', actorId: actor.id, policyVersion: currentPolicy(db).version, payload: { jobId: d.job_id, billTo: d.bill_to_name } });
    return get<InvoiceRow>(db, 'SELECT * FROM invoices WHERE id = ?', id)!;
  });
}

export function addLineItem(db: DB, actor: Actor, invoiceId: string, input: unknown) {
  requirePerm(actor, 'invoice.manage');
  const r = lineItemSchema.safeParse(input);
  if (!r.success) throw invalid('Validation failed.', r.error.flatten());
  const d = r.data;
  return tx(db, () => {
    const inv = get<InvoiceRow>(db, 'SELECT * FROM invoices WHERE id = ?', invoiceId);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'DRAFT') throw conflict('Line items can only be changed while the invoice is a draft.');
    const policy = currentPolicy(db);
    if (!policy.config.invoiceCategories.some((c) => c.code === d.category)) throw invalid('Line item category is not configured in the current policy.');
    const amount = Math.round(d.quantity * d.unit_price_cents);
    const id = newId('li');
    insert(db, 'invoice_line_items', { id, invoice_id: invoiceId, ...d, amount_cents: amount, created_at: nowIso() });
    update(db, 'invoices', invoiceId, { updated_at: nowIso() });
    appendEvent(db, { entityType: 'invoice', entityId: invoiceId, eventType: 'INVOICE_LINE_ADDED', actorId: actor.id, policyVersion: policy.version, payload: { lineId: id, ...d, amountCents: amount } });
    return id;
  });
}

export function setInvoiceStatus(db: DB, actor: Actor, invoiceId: string, action: 'ISSUE' | 'VOID', reason?: string) {
  requirePerm(actor, 'invoice.manage');
  return tx(db, () => {
    const inv = get<InvoiceRow>(db, 'SELECT * FROM invoices WHERE id = ?', invoiceId);
    if (!inv) throw notFound('Invoice');
    if (action === 'ISSUE') {
      if (inv.status !== 'DRAFT') throw conflict('Only draft invoices can be issued.');
      if (!get(db, 'SELECT 1 FROM invoice_line_items WHERE invoice_id = ?', invoiceId)) throw invalid('Add at least one line item before issuing.');
      update(db, 'invoices', invoiceId, { status: 'ISSUED', issued_at: nowIso(), updated_at: nowIso() });
    } else {
      if (inv.status === 'VOID') throw conflict('Invoice already void.');
      if (!reason?.trim()) throw invalid('A reason is required to void an invoice.');
      update(db, 'invoices', invoiceId, { status: 'VOID', updated_at: nowIso() });
    }
    appendEvent(db, { entityType: 'invoice', entityId: invoiceId, eventType: action === 'ISSUE' ? 'INVOICE_ISSUED' : 'INVOICE_VOIDED', actorId: actor.id, payload: { reason: reason ?? null, previousStatus: inv.status } });
  });
}

export const paymentSchema = z.object({
  amount_cents: z.coerce.number().int().positive(),
  received_at: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  method_note: z.preprocess(blankToNull, z.string().max(200).nullable()),
});

/** Manually record a payment that was received outside this system. No funds are moved here. */
export function recordPayment(db: DB, actor: Actor, invoiceId: string, input: unknown) {
  requirePerm(actor, 'invoice.manage');
  const r = paymentSchema.safeParse(input);
  if (!r.success) throw invalid('Validation failed.', r.error.flatten());
  return tx(db, () => {
    const { invoice, balanceCents } = getInvoice(db, actor, invoiceId);
    if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') throw conflict('Payments can be recorded only against issued invoices.');
    if (r.data.amount_cents > balanceCents) throw invalid('Payment exceeds outstanding balance.');
    const id = newId('pay');
    insert(db, 'payments', { id, invoice_id: invoiceId, ...r.data, recorded_by: actor.id, recorded_at: nowIso() });
    const status = r.data.amount_cents === balanceCents ? 'PAID' : 'PARTIALLY_PAID';
    update(db, 'invoices', invoiceId, { status, updated_at: nowIso() });
    appendEvent(db, { entityType: 'invoice', entityId: invoiceId, eventType: 'PAYMENT_RECORDED', actorId: actor.id, payload: { paymentId: id, amountCents: r.data.amount_cents, receivedAt: r.data.received_at, newStatus: status, note: 'Recorded manually; no payment processor connected.' } });
    return id;
  });
}

export const canManageInvoices = (a: Actor) => can(a, 'invoice.manage');
