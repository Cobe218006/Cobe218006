import type { NextFunction, Request, Response, Router } from 'express';
import { AppError } from '../../errors.js';
import type { Actor } from '../../domain/types.js';
import { dashboard } from '../../domain/dashboard.js';
import { chip, demoBadge, html, layout, table, ts, type Safe } from './html.js';

export function errorPage(req: Request, status: number, code: string, message: string, details?: unknown): string {
  const d = details as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | { code: string; message: string }[] | undefined;
  let detailHtml: Safe | string = '';
  if (Array.isArray(d)) detailHtml = html`<ul class="reasons">${d.map((r) => html`<li><code>${r.code}</code> ${r.message}</li>`)}</ul>`;
  else if (d && typeof d === 'object' && ('fieldErrors' in d || 'formErrors' in d))
    detailHtml = html`<ul class="reasons">${[...(d.formErrors ?? []).map((m) => html`<li>${m}</li>`), ...Object.entries(d.fieldErrors ?? {}).map(([k, v]) => html`<li><code>${k}</code>: ${(v ?? []).join('; ')}</li>`)]}</ul>`;
  const back = req.get('referer');
  return layout(
    req,
    status === 404 ? 'Not found' : status === 403 ? 'Not permitted' : status === 409 ? 'Cannot proceed' : status === 422 ? 'Please correct the input' : 'Error',
    html`<div class="card error-card"><p><code>${code}</code> ${message}</p>${detailHtml}${back ? html`<p><a href="${back}">← Back</a></p>` : ''}</div>`,
  );
}

type PageFn = (req: Request, actor: Actor) => string;
type ActionFn = (req: Request, actor: Actor) => string; // returns redirect URL

/** Thrown by page handlers to redirect instead of rendering. */
export class Redirect extends Error {
  constructor(readonly url: string) {
    super('redirect');
  }
}

export function page(fn: PageFn) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.actor) throw new AppError('UNAUTHENTICATED', 'Login required');
      res.type('html').send(fn(req, req.actor));
    } catch (e) {
      if (e instanceof Redirect) return res.redirect(e.url);
      next(e);
    }
  };
}

export function action(fn: ActionFn) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.actor) throw new AppError('UNAUTHENTICATED', 'Login required');
      res.redirect(303, fn(req, req.actor));
    } catch (e) {
      next(e);
    }
  };
}

export const withMsg = (url: string, msg: string) => `${url}${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`;

export function loginPage(req: Request, error?: string): string {
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/';
  return layout(
    req,
    'Sign in',
    html`<form method="post" action="/login" class="card narrow">
      <input type="hidden" name="next" value="${next}">
      ${error ? html`<p class="flash error" role="alert">${error}</p>` : ''}
      <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button>Sign in</button>
      <p class="muted">Local demo accounts are listed in the README (fictional data only).</p>
    </form>`,
  );
}

export function registerDashboard(r: Router, db: Parameters<typeof dashboard>[0]) {
  r.get(
    '/',
    page((req, a) => {
      const d = dashboard(db, a);
      const stageCount = (s: string) => d.jobsByStage.find((x) => x.stage === s)?.n ?? 0;
      const invCount = (s: string) => d.invoices.find((x) => x.status === s)?.n ?? 0;
      const cards: [string, string | number, string][] = [];
      if (d.onboarding.length || a.roles.includes('QUALIFICATION_OFFICER')) cards.push(['Onboarding applications', d.onboarding.length, '/owner-operators']);
      if (d.pendingReviews !== null) cards.push(['Evidence items pending review', d.pendingReviews, '/review']);
      if (d.canJobs) {
        for (const s of ['QUOTE', 'SPEC', 'SET', 'DISPATCHED', 'DELIVERED', 'POD_RECORDED', 'SEALED']) cards.push([`Jobs · ${s.replace('_', ' ')}`, stageCount(s), `/jobs?stage=${s}`]);
        cards.push(['Pending PODs', d.pendingPod.length, '/jobs?stage=DELIVERED']);
      }
      if (d.canInv) for (const s of ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID']) cards.push([`Invoices · ${s.replace('_', ' ')}`, invCount(s), `/invoices?status=${s}`]);
      return layout(
        req,
        'Dashboard',
        html`<p class="notice">Records marked <strong>DEMO / FICTIONAL</strong> are seed data for local demonstration only. Nothing in this system guarantees loads, earnings or payment timing.</p>
        <div class="cards">${cards.map(([l, n, href]) => html`<a class="card stat" href="${href}"><span class="n">${n}</span><span>${l}</span></a>`)}</div>
        ${d.canJobs
          ? html`<h2>Upcoming & active dispatches</h2>${table(
              ['Quote', 'Customer', 'Window start', 'Stage'],
              d.upcoming.map((j) => [html`<a href="/jobs/${j.id}">${j.quote_ref}</a> ${demoBadge(j.is_demo)}`, html`${j.customer_name}`, ts(j.window_start), html`${j.stage}`]),
              'No upcoming jobs.',
            )}
            <h2>Pending POD</h2>${table(['Quote', 'Customer'], d.pendingPod.map((j) => [html`<a href="/jobs/${j.id}">${j.quote_ref}</a> ${demoBadge(j.is_demo)}`, html`${j.customer_name}`]), 'No jobs awaiting POD.')}`
          : ''}
        ${d.onboarding.length
          ? html`<h2>Onboarding</h2>${table(
              ['Business', 'Submitted'],
              d.onboarding.map((o) => [html`<a href="/owner-operators/${o.id}">${o.legal_name}</a> ${demoBadge(o.is_demo)}`, o.submitted_at ? ts(o.submitted_at) : chip('NOT_STARTED', 'Not submitted')]),
            )}`
          : ''}`,
      );
    }),
  );
}
