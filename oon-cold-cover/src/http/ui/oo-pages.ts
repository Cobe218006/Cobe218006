import type { Request, Router } from 'express';
import { all, type DB } from '../../db.js';
import { AppError } from '../../errors.js';
import { DOCUMENT_CATEGORIES, issueDocumentLink, listDocuments, readDocumentContent, uploadDocument, type StorageAdapter } from '../../domain/documents.js';
import { attachDocumentToClaim, reviewClaim, submitForReview, type ClaimView } from '../../domain/evidence.js';
import type { SubjectGateResult } from '../../domain/gates.js';
import { createOwnerOperator, HITCH_TYPES, LICENSE_STATUSES, listOwnerOperators, ownerOperatorBundle, recordGateReview, saveSubject, submitOnboarding, updateOwnerOperator, type SubjectBundle } from '../../domain/onboarding.js';
import { can, isTenantRestricted } from '../../domain/permissions.js';
import { currentPolicy, type PolicyConfig } from '../../domain/policy.js';
import type { Actor } from '../../domain/types.js';
import { userDisplayName } from '../../domain/users.js';
import { upload } from '../api.js';
import { chip, csrfField, demoBadge, field, html, layout, np, select, table, textarea, ts, type Safe } from './html.js';
import { action, page, Redirect, withMsg } from './pages.js';

type Kind = 'drivers' | 'trucks' | 'assets' | 'power-configs' | 'adapters';
const KIND_TYPE = { drivers: 'driver', trucks: 'truck', assets: 'cold_asset', 'power-configs': 'power_config', adapters: 'power_adapter' } as const;
const KIND_LABEL: Record<Kind, string> = { drivers: 'Driver', trucks: 'Truck', assets: 'Cold asset', 'power-configs': 'Power / generator', adapters: 'Power adapter' };

type F = { name: string; label: string; type?: string; options?: [string, string][]; required?: boolean; help?: string; step?: string; area?: boolean };

function subjectFields(kind: Kind, p: PolicyConfig, powerConfigs: [string, string][]): F[] {
  const connectors: [string, string][] = p.power.connectorCatalog.map((c) => [c.code, c.label]);
  const phases: [string, string][] = [
    ['SINGLE', 'Single-phase'],
    ['THREE', 'Three-phase'],
  ];
  const hitches: [string, string][] = HITCH_TYPES.map((h) => [h, h.replaceAll('_', ' ')]);
  switch (kind) {
    case 'drivers':
      return [
        { name: 'full_name', label: 'Driver name', required: true },
        { name: 'license_class', label: 'License class', help: 'As shown on the license. The reviewer records whether it is sufficient and why.' },
        { name: 'license_status', label: 'License status', options: LICENSE_STATUSES.map((s) => [s, s]) },
        { name: 'license_state', label: 'Issuing state (2 letters)' },
        { name: 'license_expires', label: 'License expiration', type: 'date' },
      ];
    case 'trucks':
      return [
        { name: 'label', label: 'Truck label', required: true },
        { name: 'year', label: 'Year', type: 'number' },
        { name: 'make', label: 'Make' },
        { name: 'model', label: 'Model' },
        { name: 'vin', label: 'VIN (17 chars)' },
        { name: 'gvwr_lbs', label: 'GVWR (lbs)', type: 'number' },
        { name: 'gcwr_lbs', label: 'GCWR (lbs)', type: 'number' },
        { name: 'tow_rating_lbs', label: 'Tow rating (lbs)', type: 'number' },
        { name: 'hitch_class', label: 'Hitch class' },
        { name: 'hitch_type', label: 'Hitch type', options: hitches },
        { name: 'registration_state', label: 'Registration state' },
        { name: 'registration_number', label: 'Registration number' },
        { name: 'registration_expires', label: 'Registration expires', type: 'date' },
        { name: 'auto_liability_usd', label: 'Stated commercial auto liability (USD)', type: 'number' },
        { name: 'cargo_coverage_usd', label: 'Stated cargo coverage (USD)', type: 'number' },
        { name: 'insurance_effective', label: 'Insurance effective', type: 'date' },
        { name: 'insurance_expires', label: 'Insurance expires', type: 'date' },
      ];
    case 'assets':
      return [
        { name: 'asset_type', label: 'Asset type', required: true, options: p.asset.permittedAssetClasses.map((c) => [c.code, c.label]) },
        { name: 'unit_id', label: 'Unit / asset ID', required: true },
        { name: 'reefer_make', label: 'Reefer make' },
        { name: 'reefer_model', label: 'Reefer model' },
        { name: 'stated_temp_min_f', label: 'Stated sustained temp — min (°F)', type: 'number', step: '0.1' },
        { name: 'stated_temp_max_f', label: 'Stated sustained temp — max (°F)', type: 'number', step: '0.1', help: 'A stated range is not proof of full-load performance.' },
        { name: 'gross_weight_lbs', label: 'Gross weight (lbs)', type: 'number' },
        { name: 'required_hitch_type', label: 'Required hitch', options: hitches },
        { name: 'temp_logger_details', label: 'Temperature logger details', area: true },
        { name: 'security_details', label: 'Security / lock details', area: true },
        { name: 'inspection_date', label: 'Last inspection date', type: 'date' },
        { name: 'registration_info', label: 'Registration / documentation' },
        { name: 'req_voltage_min', label: 'Reefer requires — voltage min (V)', type: 'number' },
        { name: 'req_voltage_max', label: 'Reefer requires — voltage max (V)', type: 'number' },
        { name: 'req_phase', label: 'Reefer requires — phase', options: phases },
        { name: 'req_amperage', label: 'Reefer requires — amperage (A)', type: 'number' },
        { name: 'inlet_connector', label: 'Reefer inlet connector', options: connectors },
        { name: 'shore_power_capable', label: 'Shore-power capable', options: [['true', 'Yes'], ['false', 'No']] },
      ];
    case 'power-configs':
      return [
        { name: 'label', label: 'Label', required: true },
        { name: 'generator_make', label: 'Generator make' },
        { name: 'generator_model', label: 'Generator model' },
        { name: 'continuous_kw', label: 'Continuous-rated output (kW)', type: 'number', step: '0.1' },
        { name: 'fuel_notes', label: 'Fuel reserve / availability plan', area: true },
        { name: 'voltage', label: 'Output voltage (V)', type: 'number' },
        { name: 'phase', label: 'Output phase', options: phases },
        { name: 'amperage', label: 'Output amperage (A)', type: 'number' },
        { name: 'receptacle_connector', label: 'Receptacle connector', options: connectors },
      ];
    case 'adapters':
      return [
        { name: 'power_config_id', label: 'Used with power config (optional)', options: powerConfigs },
        { name: 'from_connector', label: 'From (supply side)', required: true, options: connectors },
        { name: 'to_connector', label: 'To (reefer inlet side)', required: true, options: connectors },
        { name: 'rated_amperage', label: 'Rated amperage (A)', type: 'number' },
        { name: 'rated_voltage', label: 'Rated voltage (V)', type: 'number' },
        { name: 'description', label: 'Description', area: true },
      ];
  }
}

function renderFields(fields: F[], values: Record<string, unknown>): Safe[] {
  return fields.map((f) => {
    const v = values[f.name];
    const val = typeof v === 'number' && f.name === 'shore_power_capable' ? String(v === 1) : v;
    if (f.options) return select(f.label, f.name, val, f.options, { required: f.required, blank: f.required ? undefined : '— not provided —' });
    if (f.area) return textarea(f.label, f.name, val, 2, f.help);
    return field(f.label, f.name, val, { type: f.type, required: f.required, help: f.help, step: f.step });
  });
}

const subjectTitle = (s: SubjectBundle) => String(s.row.label ?? s.row.unit_id ?? s.row.full_name ?? `${s.row.from_connector} → ${s.row.to_connector}`);

function claimTable(db: DB, req: Request, claims: ClaimView[], opts: { review?: boolean; actor: Actor; docs: Map<string, string> }): Safe {
  return table(
    ['Evidence item', 'Entered values', 'Documents', 'Status', 'Entered', 'Latest review', ...(opts.review ? ['Decision'] : [])],
    claims.map((c) => [
      html`<strong>${c.def.label}</strong><br><small class="muted"><code>${c.def.key}</code> · ${c.def.gate} gate</small>`,
      html`<dl class="kv">${c.def.fields.map((f) => html`<dt>${f}</dt><dd>${np(c.values[f])}</dd>`)}</dl>`,
      c.documentIds.length ? html`${c.documentIds.map((d) => html`<a href="/documents/${d}/open">${opts.docs.get(d) ?? d}</a><br>`)}` : html`<span class="muted">none</span>`,
      chip(c.status),
      html`${c.enteredByName}<br>${ts(c.claim.entered_at)}`,
      c.lastStatus && c.lastStatus.status !== 'OPERATOR_ENTERED'
        ? html`${userDisplayName(db, c.lastStatus.actor_id)} (${c.lastStatus.actor_role})<br>${ts(c.lastStatus.at)}${c.lastStatus.note ? html`<br><em>${c.lastStatus.note}</em>` : ''}${c.lastStatus.basis ? html`<br><small>Basis: ${c.lastStatus.basis}</small>` : ''}`
        : html`<span class="muted">no review yet</span>`,
      ...(opts.review
        ? [
            html`<form method="post" action="/evidence/${c.claim.id}/review" class="review">${csrfField(req)}
            <input type="hidden" name="back" value="${req.originalUrl}">
            ${select('Decision', 'decision', '', [['VERIFIED', 'Verify'], ['UNCONFIRMED', 'Unconfirmed'], ['REJECTED', 'Reject'], ['PENDING', 'Back to pending']], { required: true })}
            ${textarea('Reviewer note', 'note', '', 2)}
            ${c.def.key === 'driver.license' ? textarea('Basis for driver qualification decision', 'basis', '', 2, 'Required: the reviewer, not the system, determines license requirements.') : ''}
            <button>Record decision</button></form>`,
          ]
        : []),
    ]),
    'No evidence entered yet.',
  );
}

function gateChips(gates: SubjectGateResult[]): Safe {
  return html`${gates.map((g) => html`<div class="gate"><strong>${g.gate}</strong> ${chip(g.status)}${g.reasons.length ? html`<ul class="reasons">${g.reasons.map((r) => html`<li class="sev-${r.severity}"><code>${r.code}</code> ${r.message}</li>`)}</ul>` : ''}</div>`)}`;
}

export function registerOwnerOperatorPages(r: Router, db: DB, storage: StorageAdapter) {
  r.get(
    '/owner-operators',
    page((req, a) => {
      if (isTenantRestricted(a)) {
        throw a.ownerOperatorId ? new Redirect(`/owner-operators/${a.ownerOperatorId}`) : new Redirect('/owner-operators/new');
      }
      const list = listOwnerOperators(db, a);
      return layout(
        req,
        'Owner-operators',
        html`${can(a, 'owner_operator.create') ? html`<p><a class="button" href="/owner-operators/new">+ New owner-operator profile</a></p>` : ''}
        ${table(
          ['Business', 'Base', 'DOT / MC', 'Onboarding'],
          list.map((o) => [html`<a href="/owner-operators/${o.id}">${o.legal_name}</a> ${demoBadge(o.is_demo)}`, html`${np(o.base_city)}, ${np(o.base_state)}`, html`${np(o.dot_number)} / ${np(o.mc_number)}`, o.submitted_at ? html`Submitted ${ts(o.submitted_at)}` : chip('NOT_STARTED', 'Not submitted')]),
        )}`,
      );
    }),
  );

  const ooFields = (o: Record<string, unknown>) => [
    field('Legal business / fleet name', 'legal_name', o.legal_name, { required: true }),
    field('Primary contact name', 'contact_name', o.contact_name),
    field('Contact phone', 'contact_phone', o.contact_phone, { type: 'tel' }),
    field('Contact email', 'contact_email', o.contact_email, { type: 'email' }),
    field('Operating base city', 'base_city', o.base_city),
    field('Operating base state (2 letters)', 'base_state', o.base_state),
    field('DOT number (if applicable)', 'dot_number', o.dot_number),
    field('MC number (if applicable)', 'mc_number', o.mc_number),
  ];

  r.get('/owner-operators/new', page((req, a) => {
    if (!can(a, 'owner_operator.create') && !(isTenantRestricted(a) && !a.ownerOperatorId)) throw new AppError('FORBIDDEN', 'You cannot create owner-operator profiles.');
    return layout(req, 'New owner-operator profile', html`<form method="post" action="/owner-operators" class="card grid">${csrfField(req)}${ooFields({})}<button>Create profile</button></form>`);
  }));
  r.post('/owner-operators', action((req, a) => withMsg(`/owner-operators/${createOwnerOperator(db, a, req.body).id}`, 'Profile created.')));

  r.get(
    '/owner-operators/:id',
    page((req, a) => {
      const b = ownerOperatorBundle(db, a, String(req.params.id));
      const o = b.ownerOperator;
      const docs = listDocuments(db, a, { ownerOperatorId: o.id });
      const docNames = new Map(docs.map((d) => [d.id, `${d.category}: ${d.original_filename}`]));
      const pct = b.progress.totalItems ? Math.round((b.progress.verifiedItems / b.progress.totalItems) * 100) : 0;
      const allClaims: ClaimView[] = [...b.drivers, ...b.trucks, ...b.assets, ...b.powers, ...b.adapters].flatMap((s) => s.claims);
      const section = (kind: Kind, subjects: SubjectBundle[]) => html`<section class="card">
        <h2>${KIND_LABEL[kind]}s</h2>
        ${subjects.map(
          (s) => html`<details open><summary><strong>${subjectTitle(s)}</strong> ${s.gates.map((g) => html` ${g.gate}: ${chip(g.status)}`)}
            ${b.canEdit ? html` · <a href="/owner-operators/${o.id}/${kind}/${String(s.row.id)}/edit">Edit</a>` : ''}</summary>
            ${gateChips(s.gates)}
            ${claimTable(db, req, s.claims, { actor: a, docs: docNames })}
          </details>`,
        )}
        ${b.canEdit ? html`<p><a class="button" href="/owner-operators/${o.id}/${kind}/new">+ Add ${KIND_LABEL[kind].toLowerCase()}</a></p>` : ''}
      </section>`;
      return layout(
        req,
        o.legal_name,
        html`${demoBadge(o.is_demo)}
        <section class="card">
          <h2>Onboarding progress</h2>
          <p><progress max="100" value="${pct}">${pct}%</progress> ${b.progress.verifiedItems} of ${b.progress.totalItems} evidence items verified by a reviewer · ${b.progress.pendingItems} pending review</p>
          <p class="muted">Entered information is stored as <em>operator-entered</em>. Only a qualification officer can mark it verified.</p>
          ${b.progress.missing.length ? html`<h3>Missing or incomplete</h3><ul class="reasons">${b.progress.missing.map((m) => html`<li>${m}</li>`)}</ul>` : html`<p>${chip('VERIFIED', 'No missing information detected')}</p>`}
          ${b.canEdit ? html`<form method="post" action="/owner-operators/${o.id}/submit" class="inline">${csrfField(req)}<button>Submit entered items for review</button></form>` : ''}
          ${can(a, 'evidence.review') ? html` <a class="button" href="/owner-operators/${o.id}/review">Open qualification review</a>` : ''}
          <p>Status: ${o.submitted_at ? html`submitted ${ts(o.submitted_at)}` : 'not yet submitted'}</p>
        </section>
        <section class="card">
          <h2>Business & contact</h2>
          ${b.canEdit
            ? html`<form method="post" action="/owner-operators/${o.id}" class="grid">${csrfField(req)}${ooFields(o as unknown as Record<string, unknown>)}<button>Save</button></form>`
            : html`<dl class="kv"><dt>Contact</dt><dd>${np(o.contact_name)}</dd><dt>Phone</dt><dd>${np(o.contact_phone)}</dd><dt>Email</dt><dd>${np(o.contact_email)}</dd><dt>Base</dt><dd>${np(o.base_city)}, ${np(o.base_state)}</dd><dt>DOT</dt><dd>${np(o.dot_number)}</dd><dt>MC</dt><dd>${np(o.mc_number)}</dd></dl>`}
        </section>
        ${section('drivers', b.drivers)}${section('trucks', b.trucks)}${section('assets', b.assets)}${section('power-configs', b.powers)}${section('adapters', b.adapters)}
        <section class="card">
          <h2>Private documents</h2>
          ${table(
            ['Document', 'Category', 'Size', 'SHA-256', 'Uploaded', 'Scan'],
            docs.map((d) => [
              d.content_deleted_at ? html`${d.original_filename} <span class="muted">(content purged ${ts(d.content_deleted_at)})</span>` : html`<a href="/documents/${d.id}/open">${d.original_filename}</a>`,
              html`${d.category}`,
              html`${Math.ceil(d.size_bytes / 1024)} KB`,
              html`<code class="hash">${d.sha256.slice(0, 16)}…</code>`,
              ts(d.uploaded_at),
              html`<span class="muted">not scanned (no scanner connected)</span>`,
            ]),
            'No documents uploaded.',
          )}
          ${b.canEdit
            ? html`<form method="post" action="/owner-operators/${o.id}/documents?_csrf=${req.csrf}" enctype="multipart/form-data" class="grid">
              ${select('Category', 'category', '', DOCUMENT_CATEGORIES.filter((c) => !['POD', 'DELIVERY_EVIDENCE', 'SITE_EVIDENCE'].includes(c)).map((c) => [c, c]), { required: true })}
              ${select('Attach to evidence item (optional)', 'claimId', '', allClaims.map((c) => [c.claim.id, `${c.def.label} — ${c.claim.subject_id}`]), { blank: '— none —' })}
              <label class="field"><span>File (PDF, PNG or JPEG)</span><input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required></label>
              <button>Upload privately</button></form>`
            : ''}
        </section>`,
      );
    }),
  );
  r.post('/owner-operators/:id', action((req, a) => (updateOwnerOperator(db, a, String(req.params.id), req.body), withMsg(`/owner-operators/${req.params.id}`, 'Saved. Changes are recorded as events.'))));
  r.post('/owner-operators/:id/submit', action((req, a) => withMsg(`/owner-operators/${req.params.id}`, `${submitOnboarding(db, a, String(req.params.id))} item(s) submitted for review.`)));
  r.post('/owner-operators/:id/documents', upload.single('file'), action((req, a) => {
    if (!req.file) throw new AppError('VALIDATION_FAILED', 'File is required.');
    const d = uploadDocument(db, storage, a, { ownerOperatorId: String(req.params.id), category: req.body.category, filename: req.file.originalname, declaredMime: req.file.mimetype, data: req.file.buffer });
    if (req.body.claimId) attachDocumentToClaim(db, a, req.body.claimId, d.id);
    return withMsg(`/owner-operators/${req.params.id}`, req.body.claimId ? 'Uploaded and attached (a new, unverified version of the evidence item was created).' : 'Uploaded.');
  }));

  const subjectForm = (req: Request, a: Actor, kind: Kind, id: string | null) => {
    const b = ownerOperatorBundle(db, a, String(req.params.id));
    const p = currentPolicy(db).config;
    const list = { drivers: b.drivers, trucks: b.trucks, assets: b.assets, 'power-configs': b.powers, adapters: b.adapters }[kind];
    const existing = id ? list.find((s) => s.row.id === id) : null;
    if (id && !existing) throw new AppError('NOT_FOUND', 'Record not found.');
    const pcs: [string, string][] = b.powers.map((s) => [String(s.row.id), String(s.row.label)]);
    return layout(
      req,
      `${id ? 'Edit' : 'Add'} ${KIND_LABEL[kind].toLowerCase()} — ${b.ownerOperator.legal_name}`,
      html`<p class="notice">Changing a value creates a new, unverified evidence entry. The previous entry and its review history are preserved.</p>
      <form method="post" action="/owner-operators/${b.ownerOperator.id}/${kind}${id ? `/${id}` : ''}" class="card grid">${csrfField(req)}
      ${renderFields(subjectFields(kind, p, pcs), existing?.row ?? {})}<button>Save</button></form>`,
    );
  };
  const kindOf = (req: Request) => {
    const k = String(req.params.kind) as Kind;
    if (!(k in KIND_TYPE)) throw new AppError('NOT_FOUND', 'Unknown section.');
    return k;
  };
  r.get('/owner-operators/:id/:kind/new', page((req, a) => subjectForm(req, a, kindOf(req), null)));
  r.get('/owner-operators/:id/:kind/:sid/edit', page((req, a) => subjectForm(req, a, kindOf(req), String(req.params.sid))));
  r.post('/owner-operators/:id/:kind', action((req, a) => (saveSubject(db, a, KIND_TYPE[kindOf(req)], String(req.params.id), null, req.body), withMsg(`/owner-operators/${req.params.id}`, 'Saved as operator-entered (unverified).'))));
  r.post('/owner-operators/:id/:kind/:sid', action((req, a) => (saveSubject(db, a, KIND_TYPE[kindOf(req)], String(req.params.id), String(req.params.sid), req.body), withMsg(`/owner-operators/${req.params.id}`, 'Saved. Changed values need review again.'))));

  // ---- qualification review
  r.get(
    '/review',
    page((req, a) => {
      if (!can(a, 'evidence.review') && !a.roles.includes('READ_ONLY_AUDITOR')) throw new AppError('FORBIDDEN', 'Qualification review requires the QUALIFICATION_OFFICER role.');
      const rows = all<{ owner_operator_id: string; legal_name: string; is_demo: number; pending: number; entered: number }>(
        db,
        `SELECT o.id AS owner_operator_id, o.legal_name, o.is_demo,
          SUM(CASE WHEN st.status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN st.status IN ('OPERATOR_ENTERED','UNCONFIRMED') THEN 1 ELSE 0 END) AS entered
        FROM owner_operators o
        LEFT JOIN evidence_claims c ON c.owner_operator_id = o.id AND c.subject_type != 'job' AND NOT EXISTS (SELECT 1 FROM evidence_claims s WHERE s.supersedes_id = c.id)
        LEFT JOIN (SELECT e.claim_id, e.status FROM evidence_status_events e WHERE e.seq = (SELECT MAX(seq) FROM evidence_status_events x WHERE x.claim_id = e.claim_id)) st ON st.claim_id = c.id
        GROUP BY o.id ORDER BY pending DESC, o.legal_name`,
      );
      return layout(
        req,
        'Qualification review',
        html`<p class="muted">Each evidence item and each gate carries its own status, reviewer, note and timestamp. Coverage checks read “meets configured network threshold”; they are not legal determinations.</p>
        ${table(['Owner-operator', 'Pending review', 'Entered / unconfirmed', ''], rows.map((r) => [html`${r.legal_name} ${demoBadge(r.is_demo)}`, html`${r.pending}`, html`${r.entered}`, html`<a href="/owner-operators/${r.owner_operator_id}/review">Review →</a>`]))}`,
      );
    }),
  );

  r.get(
    '/owner-operators/:id/review',
    page((req, a) => {
      const b = ownerOperatorBundle(db, a, String(req.params.id));
      const canReview = can(a, 'evidence.review');
      const docs = listDocuments(db, a, { ownerOperatorId: b.ownerOperator.id });
      const docNames = new Map(docs.map((d) => [d.id, `${d.category}: ${d.original_filename}`]));
      const subj = (label: string, list: SubjectBundle[]) =>
        list.map(
          (s) => html`<section class="card"><h2>${label}: ${subjectTitle(s)}</h2>
          ${s.gates.map(
            (g) => html`<div class="gate"><strong>${g.gate} gate</strong> ${chip(g.status)}
              ${g.lastReview ? html`<small class="muted">Last sign-off: ${g.lastReview.decision} by ${userDisplayName(db, g.lastReview.reviewer_id)} ${ts(g.lastReview.at)} (policy v${g.lastReview.policy_version}) — “${g.lastReview.note}”</small>` : ''}
              ${g.reasons.length ? html`<ul class="reasons">${g.reasons.map((r) => html`<li class="sev-${r.severity}"><code>${r.code}</code> ${r.message}</li>`)}</ul>` : ''}
              ${canReview && s.subjectType !== 'power_adapter'
                ? html`<form method="post" action="/gates/review" class="inline-form">${csrfField(req)}
                  <input type="hidden" name="gate" value="${g.gate}"><input type="hidden" name="subjectType" value="${s.subjectType}"><input type="hidden" name="subjectId" value="${String(s.row.id)}"><input type="hidden" name="back" value="${req.originalUrl}">
                  ${select('Gate decision', 'decision', '', [['VERIFIED', 'Sign off VERIFIED'], ['FAILED', 'Mark FAILED']], { required: true })}
                  ${field('Note', 'note', '', { required: true })}<button>Record gate decision</button></form>`
                : ''}</div>`,
          )}
          ${claimTable(db, req, s.claims, { review: canReview, actor: a, docs: docNames })}</section>`,
        );
      return layout(
        req,
        `Qualification review — ${b.ownerOperator.legal_name}`,
        html`${demoBadge(b.ownerOperator.is_demo)} <p class="muted">Policy in force: v${b.policy.version} (${b.policy.documentCode}). You cannot verify evidence you entered, or evidence for your own business.</p>
        ${subj('Driver', b.drivers)}${subj('Truck', b.trucks)}${subj('Cold asset', b.assets)}${subj('Power', b.powers)}${subj('Adapter', b.adapters)}`,
      );
    }),
  );

  const back = (req: Request, fallback: string) => {
    const b = typeof req.body?.back === 'string' ? req.body.back : '';
    return b.startsWith('/') && !b.startsWith('//') ? b : fallback;
  };
  r.post('/evidence/:id/review', action((req, a) => (reviewClaim(db, a, String(req.params.id), { decision: req.body.decision, note: req.body.note, basis: req.body.basis, supportingMessageId: req.body.supportingMessageId || null }), withMsg(back(req, '/review'), 'Decision recorded as a new event.'))));
  r.post('/evidence/:id/submit', action((req, a) => (submitForReview(db, a, [String(req.params.id)]), withMsg(back(req, '/'), 'Submitted for review.'))));
  r.post('/gates/review', action((req, a) => (recordGateReview(db, a, req.body.gate, req.body.subjectType, req.body.subjectId, req.body.decision, req.body.note), withMsg(back(req, '/review'), 'Gate decision recorded.'))));

  // ---- private document access (short-lived signed link, re-authorized on read)
  r.get('/documents/:id/open', action((req, a) => issueDocumentLink(db, a, String(req.params.id)).url));
  r.get('/documents/:id/content', (req, res, next) => {
    try {
      if (!req.actor) throw new AppError('UNAUTHENTICATED', 'Login required');
      const d = readDocumentContent(db, storage, req.actor, String(req.params.id), String(req.query.t ?? ''));
      res.setHeader('Content-Type', d.mime);
      res.setHeader('Content-Disposition', `inline; filename="${d.filename.replace(/"/g, '')}"`);
      res.setHeader('Content-Security-Policy', 'sandbox; default-src none');
      res.send(d.data);
    } catch (e) {
      next(e);
    }
  });
}
