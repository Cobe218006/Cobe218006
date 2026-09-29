import type { Request, Router } from 'express';
import { all, type DB } from '../../db.js';
import { AppError } from '../../errors.js';
import { runRetention, type StorageAdapter } from '../../domain/documents.js';
import { integrationStatuses } from '../../domain/integrations.js';
import { addLineItem, createInvoice, getInvoice, listInvoices, recordPayment, setInvoiceStatus } from '../../domain/invoices.js';
import { verifyLedger } from '../../domain/ledger.js';
import { can, requirePerm } from '../../domain/permissions.js';
import { createPolicyVersion, currentPolicy, listPolicies, policyByVersion, type PolicyConfig } from '../../domain/policy.js';
import { ROLES, type Role } from '../../domain/types.js';
import { createUser, listUsers, setUserActive, setUserRoles, userDisplayName } from '../../domain/users.js';
import { chip, csrfField, demoBadge, field, html, layout, money, np, postButton, select, table, textarea, ts } from './html.js';
import { action, page, withMsg } from './pages.js';

function policySummary(p: PolicyConfig) {
  return html`<dl class="kv">
    <dt>Permitted asset classes</dt><dd>${p.asset.permittedAssetClasses.map((c) => html`${c.label} <code>${c.code}</code><br>`)}</dd>
    <dt>Stated refrigeration range must cover</dt><dd>${p.asset.requiredStatedTempMinF}°F to ${p.asset.requiredStatedTempMaxF}°F (stated capability; not a performance guarantee)</dd>
    <dt>Max inspection age</dt><dd>${p.asset.maxInspectionAgeDays} days</dd>
    <dt>Commercial auto liability — configured network threshold</dt><dd>$${p.truck.minAutoLiabilityUsd.toLocaleString()}</dd>
    <dt>Cargo coverage — configured network threshold</dt><dd>$${p.truck.minCargoCoverageUsd.toLocaleString()}</dd>
    <dt>Acceptable power configurations</dt><dd>${p.power.acceptableConfigs.map((c) => html`${c.label}<br>`)}</dd>
    <dt>Generator minimum when destination power unavailable/unverified</dt><dd>${p.power.minGeneratorKwWhenSitePowerUnverified} kW continuous</dd>
    <dt>Fuel plan required</dt><dd>${p.power.requireFuelPlan ? 'yes' : 'no'}</dd>
    <dt>Max cable run</dt><dd>${p.power.maxCableRunFt} ft</dd>
    <dt>Connector catalog</dt><dd>${p.power.connectorCatalog.map((c) => html`${c.label} — ${c.maxVoltage}V / ${c.maxAmps}A / ${c.phase}<br>`)}</dd>
    <dt>Required evidence</dt><dd>ASSET: ${p.asset.requiredClaims.join(', ')}<br>TRUCK: ${p.truck.requiredClaims.join(', ')}<br>POWER: ${p.power.requiredClaims.join(', ')}<br>SITE: ${p.site.requiredClaims.join(', ')}</dd>
    <dt>Documents required for</dt><dd>${Object.entries(p.documentRequirements).filter(([, v]) => v).map(([k]) => k).join(', ')}</dd>
    <dt>Review rules</dt><dd>Site verifiers: ${p.reviewRules.siteVerifierRoles.join(', ')} · same-user site confirmation ${p.reviewRules.allowSameUserSiteConfirmation ? 'allowed' : 'not allowed'} · note on reject ${p.reviewRules.requireNoteOnReject ? 'required' : 'optional'} · basis for driver decision ${p.reviewRules.requireBasisForDriverDecision ? 'required' : 'optional'}</dd>
    <dt>Invoice categories</dt><dd>${p.invoiceCategories.map((c) => c.label).join(', ')}</dd>
    <dt>Document retention</dt><dd>${p.documentRetentionDays} days</dd>
  </dl>`;
}

const num = (v: unknown) => (v === '' || v === undefined ? NaN : Number(v));

export function registerMiscPages(r: Router, db: DB, storage: StorageAdapter) {
  // ---- invoices
  r.get(
    '/invoices',
    page((req, a) => {
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      const list = listInvoices(db, a).filter((i) => !status || i.status === status);
      return layout(
        req,
        'Invoices & commercial activity',
        html`<p class="notice">Records commercial activity only. Accounting and payment integrations are <strong>not connected</strong>; payments are recorded manually. No tax, lending or insurance advice is provided.</p>
        ${can(a, 'invoice.manage') ? html`<p><a class="button" href="/invoices/new">+ New invoice</a></p>` : ''}
        ${table(
          ['Number', 'Bill to', 'Job', 'Status', 'Total', 'Balance'],
          list.map((i) => {
            const d = getInvoice(db, a, i.id);
            return [html`<a href="/invoices/${i.id}">${i.number}</a> ${demoBadge(i.is_demo)}`, html`${i.bill_to_name}`, d.job ? html`<a href="/jobs/${i.job_id}">${d.job.quote_ref}</a>` : html`<span class="muted">—</span>`, chip(i.status), html`${money(d.totalCents)}`, html`${money(d.balanceCents)}`];
          }),
          'No invoices.',
        )}`,
      );
    }),
  );
  r.get('/invoices/new', page((req, a) => {
    requirePerm(a, 'invoice.manage');
    const jobs = all<{ id: string; quote_ref: string; customer_name: string }>(db, 'SELECT id, quote_ref, customer_name FROM jobs ORDER BY created_at DESC');
    const oos = all<{ id: string; legal_name: string }>(db, 'SELECT id, legal_name FROM owner_operators ORDER BY legal_name');
    return layout(
      req,
      'New invoice',
      html`<form method="post" action="/invoices" class="card grid">${csrfField(req)}
      ${field('Bill to', 'bill_to_name', '', { required: true })}
      ${select('Job (optional)', 'job_id', '', jobs.map((j) => [j.id, `${j.quote_ref} — ${j.customer_name}`]), { blank: '— none —' })}
      ${select('Owner-operator (optional)', 'owner_operator_id', '', oos.map((o) => [o.id, o.legal_name]), { blank: '— none —' })}
      ${field('Due date', 'due_date', '', { type: 'date' })}${textarea('Notes', 'notes', '')}<button>Create draft</button></form>`,
    );
  }));
  r.post('/invoices', action((req, a) => `/invoices/${createInvoice(db, a, req.body).id}`));
  r.get(
    '/invoices/:id',
    page((req, a) => {
      const d = getInvoice(db, a, String(req.params.id));
      const i = d.invoice;
      const cats = currentPolicy(db).config.invoiceCategories;
      const catLabel = (c: string) => cats.find((x) => x.code === c)?.label ?? c;
      const manage = can(a, 'invoice.manage');
      return layout(
        req,
        `Invoice ${i.number}`,
        html`${demoBadge(i.is_demo)} ${chip(i.status)}
        <dl class="kv"><dt>Bill to</dt><dd>${i.bill_to_name}</dd><dt>Job / haul</dt><dd>${d.job ? html`<a href="/jobs/${i.job_id}">${d.job.quote_ref}</a> · stage ${d.job.stage} · POD ${d.job.pod_recorded_at ? ts(d.job.pod_recorded_at) : 'not recorded'}` : '—'}</dd>
        <dt>Issued</dt><dd>${ts(i.issued_at)}</dd><dt>Due</dt><dd>${np(i.due_date)}</dd><dt>Notes</dt><dd>${np(i.notes)}</dd></dl>
        <h2>Line items</h2>
        ${table(['Category', 'Description', 'Qty', 'Unit price', 'Amount'], d.lines.map((l) => [html`${catLabel(l.category)}`, html`${l.description}`, html`${l.quantity}`, html`${money(l.unit_price_cents)}`, html`${money(l.amount_cents)}`]), 'No line items.')}
        <p><strong>Total ${money(d.totalCents)}</strong> · recorded payments ${money(d.paidCents)} · balance ${money(d.balanceCents)}</p>
        ${manage && i.status === 'DRAFT'
          ? html`<form method="post" action="/invoices/${i.id}/lines" class="card grid">${csrfField(req)}<h3 class="span">Add line item</h3>
            ${select('Category', 'category', '', cats.map((c) => [c.code, c.label]), { required: true })}${field('Description', 'description', '', { required: true })}${field('Quantity', 'quantity', '1', { type: 'number', step: 'any' })}${field('Unit price (USD)', 'unit_price', '', { type: 'number', step: '0.01', required: true })}<button>Add</button></form>
            ${postButton(req, `/invoices/${i.id}/issue`, 'Issue invoice', { cls: 'primary' })}`
          : ''}
        ${manage && (i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID')
          ? html`<form method="post" action="/invoices/${i.id}/payments" class="card grid">${csrfField(req)}<h3 class="span">Record a payment received elsewhere</h3><p class="span muted">No payment processor is connected; this records a payment only.</p>
            ${field('Amount (USD)', 'amount', '', { type: 'number', step: '0.01', required: true })}${field('Received on', 'received_at', '', { type: 'date', required: true })}${field('Method / reference note', 'method_note', '')}<button>Record payment</button></form>`
          : ''}
        ${manage && i.status !== 'VOID' ? html`<form method="post" action="/invoices/${i.id}/void" class="inline-form">${csrfField(req)}${field('Void reason', 'reason', '')}<button class="danger">Void</button></form>` : ''}
        <h2>Payments recorded</h2>${table(['Amount', 'Received', 'Note', 'Recorded by'], d.payments.map((p) => [html`${money(p.amount_cents)}`, html`${p.received_at}`, np(p.method_note), html`${userDisplayName(db, p.recorded_by)}`]), 'None recorded.')}`,
      );
    }),
  );
  const cents = (v: unknown) => {
    const n = num(v);
    if (!Number.isFinite(n) || n < 0) throw new AppError('VALIDATION_FAILED', 'Enter a valid amount.');
    return Math.round(n * 100);
  };
  r.post('/invoices/:id/lines', action((req, a) => (addLineItem(db, a, String(req.params.id), { ...req.body, unit_price_cents: cents(req.body.unit_price) }), `/invoices/${req.params.id}`)));
  r.post('/invoices/:id/issue', action((req, a) => (setInvoiceStatus(db, a, String(req.params.id), 'ISSUE'), withMsg(`/invoices/${req.params.id}`, 'Issued.'))));
  r.post('/invoices/:id/void', action((req, a) => (setInvoiceStatus(db, a, String(req.params.id), 'VOID', req.body.reason), withMsg(`/invoices/${req.params.id}`, 'Voided.'))));
  r.post('/invoices/:id/payments', action((req, a) => (recordPayment(db, a, String(req.params.id), { amount_cents: cents(req.body.amount), received_at: req.body.received_at, method_note: req.body.method_note }), withMsg(`/invoices/${req.params.id}`, 'Payment recorded.'))));

  // ---- policies
  r.get(
    '/policies',
    page((req, a) => {
      const list = listPolicies(db);
      const cur = list[0];
      return layout(
        req,
        'Qualification policy',
        html`<p class="muted">Values below are configurable network policy (document ${cur.documentCode}, effective ${cur.effectiveDate}) — not legal determinations. New versions never change jobs or reviews already evaluated; each job keeps the version it was evaluated under.</p>
        ${can(a, 'policy.manage') ? html`<p><a class="button" href="/policies/new">Create new policy version</a></p>` : ''}
        <section class="card"><h2>Current: v${cur.version}</h2>${policySummary(cur.config)}</section>
        <h2>Version history</h2>${table(['Version', 'Created', 'By', 'Note', 'Config hash'], list.map((p) => [html`<a href="/policies/${p.version}">v${p.version}</a>`, ts(p.createdAt), html`${userDisplayName(db, p.createdBy) ?? 'system'}`, html`${p.changeNote}`, html`<code class="hash">${p.configHash.slice(0, 16)}…</code>`]))}`,
      );
    }),
  );
  r.get('/policies/new', page((req, a) => {
    requirePerm(a, 'policy.manage');
    const p = currentPolicy(db).config;
    const roles: [string, string][] = ROLES.map((x) => [x, x]);
    return layout(
      req,
      'New policy version',
      html`<form method="post" action="/policies" class="card grid">${csrfField(req)}
      <p class="span notice">Saving creates version ${currentPolicy(db).version + 1}. Earlier versions and past decisions are preserved.</p>
      ${field('Stated temp range must cover — min °F', 'tempMin', p.asset.requiredStatedTempMinF, { type: 'number', step: '0.1' })}
      ${field('Stated temp range must cover — max °F', 'tempMax', p.asset.requiredStatedTempMaxF, { type: 'number', step: '0.1' })}
      ${field('Max inspection age (days)', 'inspectionDays', p.asset.maxInspectionAgeDays, { type: 'number' })}
      ${field('Commercial auto liability threshold (USD)', 'autoUsd', p.truck.minAutoLiabilityUsd, { type: 'number' })}
      ${field('Cargo coverage threshold (USD)', 'cargoUsd', p.truck.minCargoCoverageUsd, { type: 'number' })}
      ${field('Min generator kW (destination power unavailable/unverified)', 'minKw', p.power.minGeneratorKwWhenSitePowerUnverified, { type: 'number', step: '0.1' })}
      ${field('Max cable run (ft)', 'maxCable', p.power.maxCableRunFt, { type: 'number' })}
      ${select('Require fuel plan', 'fuel', String(p.power.requireFuelPlan), [['true', 'Yes'], ['false', 'No']])}
      ${select('Same user may confirm site evidence they entered', 'sameUser', String(p.reviewRules.allowSameUserSiteConfirmation), [['true', 'Allowed'], ['false', 'Not allowed']])}
      <fieldset class="span"><legend>Roles allowed to verify site evidence</legend>${roles.map(([v]) => html`<label><input type="checkbox" name="siteRoles" value="${v}" ${p.reviewRules.siteVerifierRoles.includes(v as Role) ? 'checked' : ''}> ${v}</label> `)}</fieldset>
      ${field('Document retention (days)', 'retention', p.documentRetentionDays, { type: 'number' })}
      ${textarea('Advanced: full configuration JSON (optional — overrides the fields above when provided)', 'json', '', 6, 'Leave blank to use the fields above. Includes asset classes, acceptable power configurations, connector catalog, required evidence, document requirements and invoice categories.')}
      <details class="span"><summary>Current configuration JSON</summary><pre>${JSON.stringify(p, null, 2)}</pre></details>
      ${field('Change note (required)', 'note', '', { required: true })}
      <button>Create version</button></form>`,
    );
  }));
  r.post('/policies', action((req, a) => {
    const base = currentPolicy(db).config;
    let cfg: unknown;
    if (typeof req.body.json === 'string' && req.body.json.trim()) {
      try {
        cfg = JSON.parse(req.body.json);
      } catch {
        throw new AppError('VALIDATION_FAILED', 'Configuration JSON is not valid JSON.');
      }
    } else {
      const roles = req.body.siteRoles;
      cfg = {
        ...base,
        asset: { ...base.asset, requiredStatedTempMinF: num(req.body.tempMin), requiredStatedTempMaxF: num(req.body.tempMax), maxInspectionAgeDays: num(req.body.inspectionDays) },
        truck: { ...base.truck, minAutoLiabilityUsd: num(req.body.autoUsd), minCargoCoverageUsd: num(req.body.cargoUsd) },
        power: { ...base.power, minGeneratorKwWhenSitePowerUnverified: num(req.body.minKw), maxCableRunFt: num(req.body.maxCable), requireFuelPlan: req.body.fuel === 'true' },
        reviewRules: { ...base.reviewRules, allowSameUserSiteConfirmation: req.body.sameUser === 'true', siteVerifierRoles: Array.isArray(roles) ? roles : roles ? [roles] : [] },
        documentRetentionDays: num(req.body.retention),
      };
    }
    const v = createPolicyVersion(db, a, cfg, req.body.note);
    return withMsg(`/policies/${v.version}`, `Policy v${v.version} created.`);
  }));
  r.get('/policies/:v', page((req) => {
    const p = policyByVersion(db, Number(req.params.v));
    return layout(req, `Policy v${p.version}`, html`<p>${p.documentCode} · created ${ts(p.createdAt)} by ${userDisplayName(db, p.createdBy) ?? 'system'} · “${p.changeNote}”</p><p>Config hash <code class="hash">${p.configHash}</code></p>${policySummary(p.config)}<details><summary>JSON</summary><pre>${JSON.stringify(p.config, null, 2)}</pre></details>`);
  }));

  // ---- ledger integrity
  r.get('/ledger', page((req, a) => {
    requirePerm(a, 'ledger.read_all');
    const v = verifyLedger(db);
    const recent = all<{ seq: number; event_type: string; entity_type: string; entity_id: string; occurred_at: string; actor_user_id: string | null; event_hash: string }>(db, 'SELECT seq, event_type, entity_type, entity_id, occurred_at, actor_user_id, event_hash FROM ledger_events ORDER BY seq DESC LIMIT 50');
    return layout(
      req,
      'Ledger integrity',
      html`<section class="card"><p>${chip(v.problems.length ? 'FAIL' : 'PASS', v.problems.length ? `${v.problems.length} problem(s) detected` : 'Hash chain intact')} — ${v.checked} events recomputed now.</p>
      ${v.problems.length ? html`<ul class="reasons">${v.problems.map((p) => html`<li class="sev-RED">seq ${p.seq}: <code>${p.problem}</code></li>`)}</ul>` : ''}
      <p class="muted">Tamper-evident, not tamper-proof: triggers block normal updates/deletes, and the hash chain detects changes made by anyone who bypasses them. A matching hash does not prove the recorded facts are true.</p></section>
      <h2>Most recent events</h2>${table(['#', 'Type', 'Entity', 'When', 'Actor', 'Hash'], recent.map((e) => [html`${e.seq}`, html`${e.event_type}`, e.entity_type === 'job' ? html`<a href="/jobs/${e.entity_id}">job</a>` : html`${e.entity_type}`, ts(e.occurred_at), html`${userDisplayName(db, e.actor_user_id) ?? 'system'}`, html`<code class="hash">${e.event_hash.slice(0, 12)}…</code>`]))}`,
    );
  }));

  // ---- admin: users
  r.get('/admin/users', page((req, a) => {
    const users = listUsers(db, a);
    const oos = all<{ id: string; legal_name: string }>(db, 'SELECT id, legal_name FROM owner_operators ORDER BY legal_name');
    return layout(
      req,
      'Users & roles',
      html`${table(
        ['Name', 'Email', 'Roles', 'Owner-operator', 'Active', ''],
        users.map((u) => [
          html`${u.display_name} ${demoBadge(u.is_demo)}`,
          html`${u.email}`,
          html`<form method="post" action="/admin/users/${u.id}/roles" class="inline-form">${csrfField(req)}${ROLES.map((r) => html`<label><input type="checkbox" name="roles" value="${r}" ${u.roles?.split(', ').includes(r) ? 'checked' : ''}> ${r}</label> `)}<button>Save roles</button></form>`,
          html`${oos.find((o) => o.id === u.owner_operator_id)?.legal_name ?? '—'}`,
          chip(u.active ? 'VERIFIED' : 'FAILED', u.active ? 'Active' : 'Inactive'),
          postButton(req, `/admin/users/${u.id}/active`, u.active ? 'Deactivate' : 'Activate', { fields: { active: u.active ? 'false' : 'true' } }),
        ]),
      )}
      <form method="post" action="/admin/users" class="card grid">${csrfField(req)}<h2 class="span">Create user</h2>
        ${field('Display name', 'display_name', '', { required: true })}${field('Email', 'email', '', { type: 'email', required: true })}${field('Initial password (min 12 chars)', 'password', '', { type: 'password', required: true })}
        ${select('Owner-operator link (for OWNER_OPERATOR role)', 'owner_operator_id', '', oos.map((o) => [o.id, o.legal_name]), { blank: '— none —' })}
        <fieldset class="span"><legend>Roles</legend>${ROLES.map((r) => html`<label><input type="checkbox" name="roles" value="${r}"> ${r}</label> `)}</fieldset><button>Create</button></form>`,
    );
  }));
  const arr = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []);
  r.post('/admin/users', action((req, a) => (createUser(db, a, { ...req.body, roles: arr(req.body.roles) }), withMsg('/admin/users', 'User created.'))));
  r.post('/admin/users/:id/roles', action((req, a) => (setUserRoles(db, a, String(req.params.id), arr(req.body.roles) as Role[]), withMsg('/admin/users', 'Roles updated; the user must sign in again.'))));
  r.post('/admin/users/:id/active', action((req, a) => (setUserActive(db, a, String(req.params.id), req.body.active === 'true'), withMsg('/admin/users', 'Updated.'))));

  // ---- admin: system, integrations, retention
  r.get('/admin/system', page((req: Request, a) => {
    requirePerm(a, 'retention.manage');
    const preview = runRetention(db, storage, a, undefined, true);
    return layout(
      req,
      'System & integrations',
      html`<h2>Integrations</h2>${table(['Integration', 'Status', 'Detail'], integrationStatuses(storage.name).map((i) => [html`${i.name}`, chip(i.status), html`${i.detail}`]))}
      <h2>Document retention</h2><p>Content past its retention date is purged unless on legal hold or referenced by a sealed manifest. Metadata, hashes and events are kept.</p>
      <p>Due now: ${preview.purged.length} purgeable · ${preview.retained.length} retained (${preview.retained.map((x) => x.reason).join('; ') || 'none'})</p>
      ${postButton(req, '/admin/retention/run', 'Run retention now', { cls: 'danger' })}`,
    );
  }));
  r.post('/admin/retention/run', action((req, a) => {
    const out = runRetention(db, storage, a, undefined, false);
    return withMsg('/admin/system', `Retention run: ${out.purged.length} purged, ${out.retained.length} retained.`);
  }));
}
