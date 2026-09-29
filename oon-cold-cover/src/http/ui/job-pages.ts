import type { Request, Router } from 'express';
import { all, get, type DB } from '../../db.js';
import { AppError } from '../../errors.js';
import { listDocuments, uploadDocument, type StorageAdapter } from '../../domain/documents.js';
import { subjectClaims } from '../../domain/evidence.js';
import { evaluateJob, type JobEvaluation, type JobRow } from '../../domain/gates.js';
import { assignJob, attemptSet, createJob, dispatchJob, getJob, jobPacket, jobPods, listJobs, markArrived, markDelivered, recordPod, repinPolicy, updateJobSpec } from '../../domain/jobs.js';
import { eventsFor } from '../../domain/ledger.js';
import { listMessages, postMessage } from '../../domain/messages.js';
import { can, isTenantRestricted } from '../../domain/permissions.js';
import { currentPolicy, policyByVersion } from '../../domain/policy.js';
import { userDisplayName } from '../../domain/users.js';
import { exportPackage, HASH_DISCLAIMER, manifestsFor, recordCorrection, sealJob, verifyManifestFor } from '../../domain/vault.js';
import { upload } from '../api.js';
import { chip, csrfField, demoBadge, field, html, layout, np, postButton, select, table, textarea, ts, type Safe } from './html.js';
import { action, page, withMsg } from './pages.js';

const toLocalInput = (iso: string | null) => (iso ? iso.slice(0, 16) : '');

function specForm(req: Request, db: DB, job: Partial<JobRow>, actionUrl: string): Safe {
  const p = (job.policy_version ? policyByVersion(db, job.policy_version) : currentPolicy(db)).config;
  const connectors: [string, string][] = p.power.connectorCatalog.map((c) => [c.code, c.label]);
  return html`<form method="post" action="${actionUrl}" class="card grid">${csrfField(req)}
    <h2 class="span">Quote</h2>
    ${field('Customer name', 'customer_name', job.customer_name, { required: true })}
    ${select('Required asset class', 'required_asset_class', job.required_asset_class, p.asset.permittedAssetClasses.map((c) => [c.code, c.label]), { blank: '— not provided —' })}
    <h2 class="span">Pickup & delivery</h2>
    ${field('Pickup location', 'pickup_location', job.pickup_location)}
    ${field('Pickup latitude', 'pickup_lat', job.pickup_lat, { type: 'number', step: 'any' })}
    ${field('Pickup longitude', 'pickup_lng', job.pickup_lng, { type: 'number', step: 'any' })}
    ${field('Delivery address', 'delivery_address', job.delivery_address)}
    ${field('Delivery pin latitude', 'delivery_lat', job.delivery_lat, { type: 'number', step: 'any', help: 'Exact drop coordinates (not geocoded — no map service connected).' })}
    ${field('Delivery pin longitude', 'delivery_lng', job.delivery_lng, { type: 'number', step: 'any' })}
    ${field('Delivery window start (UTC)', 'window_start', toLocalInput(job.window_start ?? null), { type: 'datetime-local' })}
    ${field('Delivery window end (UTC)', 'window_end', toLocalInput(job.window_end ?? null), { type: 'datetime-local' })}
    <h2 class="span">Site</h2>
    ${field('Named site contact', 'site_contact_name', job.site_contact_name)}
    ${field('Direct contact phone', 'site_contact_phone', job.site_contact_phone, { type: 'tel' })}
    ${field('Contact method / notes', 'site_contact_method', job.site_contact_method)}
    ${textarea('Access / clearance notes', 'site_access_notes', job.site_access_notes)}
    ${field('Cable-run distance (ft)', 'cable_run_ft', job.cable_run_ft, { type: 'number', step: 'any' })}
    ${field('Target setpoint (°F)', 'setpoint_f', job.setpoint_f, { type: 'number', step: '0.1' })}
    ${field('Commodity', 'commodity', job.commodity)}
    ${field('Commodity parameters / notes', 'commodity_notes', job.commodity_notes)}
    <h2 class="span">Destination power</h2>
    ${select('Destination power', 'site_power_status', job.site_power_status, [['AVAILABLE', 'Stated available'], ['UNAVAILABLE', 'Unavailable'], ['UNKNOWN', 'Unknown']], { blank: '— not provided —' })}
    ${field('Site voltage (V)', 'site_voltage', job.site_voltage, { type: 'number' })}
    ${select('Site phase', 'site_phase', job.site_phase, [['SINGLE', 'Single-phase'], ['THREE', 'Three-phase']], { blank: '— not provided —' })}
    ${field('Site amperage (A)', 'site_amperage', job.site_amperage, { type: 'number' })}
    ${select('Site receptacle', 'site_connector', job.site_connector, connectors, { blank: '— not provided —' })}
    <button>Save</button></form>`;
}

function reasonsList(ev: JobEvaluation): Safe {
  const rs = ev.reasons;
  if (!rs.length) return html`<p>${chip('GREEN')} No blocking reasons.</p>`;
  return html`<ul class="reasons">${rs.map((r) => html`<li class="sev-${r.severity}">${chip(r.severity === 'INFO' ? 'INFO' : r.severity === 'RED' ? 'FAIL' : 'PENDING', r.severity)} <code>${r.code}</code> <span class="muted">[${r.gate ?? ''}]</span> ${r.message}</li>`)}</ul>`;
}

function gateGrid(ev: JobEvaluation): Safe {
  return html`<div class="cards">${Object.values(ev.gates).map((g) => html`<div class="card gate-card"><h3>${g.gate}</h3>${chip(g.status)}${g.gate === 'SITE' && ev.siteUnconfirmed ? html`<p><strong>SITE UNCONFIRMED</strong></p>` : ''}<small>${g.reasons.filter((r) => r.severity !== 'INFO').length} open item(s)</small></div>`)}</div>`;
}

function powerTable(ev: JobEvaluation): Safe {
  return html`<p>${chip(ev.power.result)} Source: ${ev.power.source ?? 'none selected'}</p>${table(
    ['Check', 'Outcome', 'Detail'],
    ev.power.checks.map((c) => [html`${c.label}`, chip(c.outcome), html`${c.detail}`]),
    'No power checks could be run.',
  )}`;
}

function timeline(db: DB, jobId: string): Safe {
  const events = eventsFor(db, 'job', jobId);
  return html`<ol class="timeline">${events.map((e) => {
    const p = JSON.parse(e.payload_json) as Record<string, unknown>;
    const extra =
      e.event_type === 'SET_BLOCKED'
        ? html` — ${(p.reasonCodes as string[]).join(', ')}`
        : e.event_type === 'SITE_UNCONFIRMED'
          ? html` — ${(p.reasons as { code: string }[]).map((r) => r.code).join(', ')}`
          : e.event_type === 'SET_ATTEMPTED'
            ? html` — evaluated ${String(p.status)}`
            : e.event_type.startsWith('EVIDENCE') || e.event_type === 'HUMAN_CONFIRMED'
              ? html` — ${String(p.claimKey ?? '')}${p.note ? html`: “${String(p.note)}”` : ''}`
              : e.event_type === 'CORRECTION_RECORDED'
                ? html` — ${String(p.field)} → “${String(p.corrected_value)}” (${String(p.reason)})`
                : e.event_type === 'SPEC_UPDATED'
                  ? html` — ${(p.changes as { field: string }[]).map((c) => c.field).join(', ')}`
                  : '';
    return html`<li><span class="ev-type">${e.event_type}</span>${extra}<br><small>${ts(e.occurred_at)} · ${userDisplayName(db, e.actor_user_id) ?? 'system'} · policy v${e.policy_version ?? '—'} · <code class="hash" title="event hash">${e.event_hash.slice(0, 12)}…</code> ← <code class="hash" title="previous event hash">${e.previous_event_hash.slice(0, 12)}…</code></small></li>`;
  })}</ol>`;
}

function packetView(packet: ReturnType<typeof jobPacket>): Safe {
  return html`<dl class="kv packet">
    <dt>Quote / job</dt><dd>${packet.quoteRef} · ${packet.customer}</dd>
    <dt>Pickup</dt><dd>${np(packet.pickup.location)} (${np(packet.pickup.lat)}, ${np(packet.pickup.lng)})</dd>
    <dt>Delivery pin</dt><dd>${np(packet.delivery.address)} (${np(packet.delivery.lat)}, ${np(packet.delivery.lng)})</dd>
    <dt>Delivery window</dt><dd>${ts(packet.deliveryWindow.start)} → ${ts(packet.deliveryWindow.end)}</dd>
    <dt>Owner-operator</dt><dd>${np(packet.ownerOperator)}</dd>
    <dt>Driver</dt><dd>${np(packet.driver.name)}</dd>
    <dt>Truck</dt><dd>${np(packet.truck.label)}</dd>
    <dt>Unit / asset ID</dt><dd>${np(packet.asset.unitId)} · class ${np(packet.asset.assetClass)}</dd>
    <dt>Truck–asset compatibility</dt><dd>${packet.truckAssetCompatibility.length ? packet.truckAssetCompatibility.join('; ') : 'no open issues'}</dd>
    <dt>Power required</dt><dd>${packet.power.required ? html`${String(packet.power.required.req_voltage_min)}–${String(packet.power.required.req_voltage_max)}V ${String(packet.power.required.req_phase)} ${String(packet.power.required.req_amperage)}A ${String(packet.power.required.inlet_connector)}` : np(null)}</dd>
    <dt>Power available (site)</dt><dd>${np(packet.power.siteStatus)} · ${np(packet.power.site.voltage, 'V')} ${np(packet.power.site.phase)} ${np(packet.power.site.amperage, 'A')} ${np(packet.power.site.connector)}</dd>
    <dt>Power match</dt><dd>${chip(packet.power.result)} via ${packet.power.source ?? '—'}</dd>
    <dt>Setpoint / commodity</dt><dd>${np(packet.setpointF, '°F')} · ${np(packet.commodity)} ${packet.commodityNotes ? `(${packet.commodityNotes})` : ''}</dd>
    <dt>Access / clearance</dt><dd>${np(packet.siteAccessNotes)} · cable run ${np(packet.cableRunFt, ' ft')}</dd>
    <dt>Site contact</dt><dd>${np(packet.siteContact.name)} (${np(packet.siteContact.method)}) ${chip(packet.siteContact.confirmation)} ${packet.siteContact.confirmedBy ? html`by ${packet.siteContact.confirmedBy} ${ts(packet.siteContact.confirmedAt ?? null)}` : ''}</dd>
    <dt>Gates</dt><dd>${packet.gates.map((g) => html`${g.gate}: ${chip(g.status)} `)}</dd>
    <dt>Status</dt><dd>${chip(packet.status)} (policy v${packet.policyVersion}, evaluated ${ts(packet.evaluatedAt)})</dd>
    <dt>Dispatch</dt><dd>${packet.dispatchedAt ? html`${packet.dispatchedBy} at ${ts(packet.dispatchedAt)}` : 'not dispatched'}</dd>
  </dl>`;
}

export function registerJobPages(r: Router, db: DB, storage: StorageAdapter) {
  r.get(
    '/jobs',
    page((req, a) => {
      const stage = typeof req.query.stage === 'string' ? req.query.stage : '';
      const jobs = listJobs(db, a).filter((j) => !stage || j.stage === stage);
      return layout(
        req,
        isTenantRestricted(a) ? 'My jobs' : 'Jobs & dispatch',
        html`${can(a, 'job.manage') ? html`<p><a class="button" href="/jobs/new">+ New quote / job</a></p>` : ''}
        ${stage ? html`<p>Filtered by stage <strong>${stage}</strong> · <a href="/jobs">clear</a></p>` : ''}
        ${table(
          ['Quote', 'Customer', 'Stage', 'Live status', 'Window', 'Policy'],
          jobs.map((j) => {
            const ev = ['QUOTE', 'SPEC', 'SET'].includes(j.stage) ? evaluateJob(db, j, policyByVersion(db, j.policy_version)) : null;
            return [html`<a href="/jobs/${j.id}">${j.quote_ref}</a> ${demoBadge(j.is_demo)}`, html`${j.customer_name}`, html`${j.stage}`, ev ? chip(ev.status) : html`<span class="muted">recorded at dispatch</span>`, ts(j.window_start), html`v${j.policy_version}`];
          }),
          'No jobs.',
        )}`,
      );
    }),
  );
  r.get('/jobs/new', page((req, a) => {
    if (!can(a, 'job.manage')) throw new AppError('FORBIDDEN', 'Only dispatchers create jobs.');
    return layout(req, 'New quote / job', specForm(req, db, {}, '/jobs'));
  }));
  r.post('/jobs', action((req, a) => withMsg(`/jobs/${createJob(db, a, req.body).id}`, 'Quote created. Site details are recorded as unverified until confirmed.')));

  r.get(
    '/jobs/:id',
    page((req, a) => {
      const job = getJob(db, a, String(req.params.id));
      const policy = policyByVersion(db, job.policy_version);
      const cur = currentPolicy(db);
      const ev = evaluateJob(db, job, policy);
      const pre = ['QUOTE', 'SPEC', 'SET'].includes(job.stage);
      const manage = can(a, 'job.manage');
      const siteClaims = subjectClaims(db, 'job', job.id);
      const siteVerifier = can(a, 'site.verify') && a.roles.some((r) => policy.config.reviewRules.siteVerifierRoles.includes(r));
      const docs = listDocuments(db, a, { jobId: job.id });
      const pods = jobPods(db, job.id);
      const manifests = manifestsFor(db, job.id);
      const msgs = listMessages(db, a, job.id);
      const oos = manage ? all<{ id: string; legal_name: string }>(db, 'SELECT id, legal_name FROM owner_operators ORDER BY legal_name') : [];
      const ooId = job.assigned_owner_operator_id ?? oos[0]?.id;
      const opts = (table: string, col: string): [string, string][] => (ooId ? all<{ id: string; v: string }>(db, `SELECT id, ${col} AS v FROM ${table} WHERE owner_operator_id = ? ORDER BY created_at`, ooId).map((x) => [x.id, x.v]) : []);
      const recorded = job.last_evaluation_json ? JSON.parse(job.last_evaluation_json) : null;
      const progress = can(a, 'job.progress') && (!isTenantRestricted(a) || job.assigned_owner_operator_id === a.ownerOperatorId);

      return layout(
        req,
        `${job.quote_ref} — ${job.customer_name}`,
        html`${demoBadge(job.is_demo)}
        <p>Stage <strong>${job.stage}</strong> · pinned policy <strong>v${job.policy_version}</strong>${cur.version !== job.policy_version ? html` <span class="muted">(current is v${cur.version}; this job keeps v${job.policy_version} unless a dispatcher explicitly re-pins it)</span>` : ''}
        · <a href="/jobs/${job.id}/packet">Job packet</a> · <a href="/jobs/${job.id}/vault">Proof Vault</a></p>
        <nav class="flow" aria-label="Workflow">${['QUOTE', 'SPEC', 'SET', 'DISPATCHED', 'ARRIVED', 'DELIVERED', 'POD_RECORDED', 'SEALED'].map((s) => html`<span class="${s === job.stage ? 'current' : ''}">${s.replace('_', ' ')}</span>`)}</nav>

        <section class="card">
          <h2>${pre ? 'Live SET evaluation (server-computed)' : 'Status recorded at dispatch'}</h2>
          ${pre
            ? html`<p class="big">${chip(ev.status)} ${ev.siteUnconfirmed ? html`<strong class="site-unconfirmed">SITE UNCONFIRMED</strong>` : ''}</p>${gateGrid(ev)}<h3>Reason codes</h3>${reasonsList(ev)}
              ${manage ? html`<p>${postButton(req, `/jobs/${job.id}/set`, 'Attempt SET')} ${job.stage === 'SET' ? html`<a class="button primary" href="/jobs/${job.id}/packet">Review packet & dispatch →</a>` : ''} ${cur.version !== job.policy_version ? postButton(req, `/jobs/${job.id}/repin`, `Re-pin to policy v${cur.version}`) : ''}</p>` : ''}`
            : recorded
              ? html`<p class="big">${chip(recorded.status)}</p><p>Gates: ${Object.entries(recorded.gates as Record<string, string>).map(([g, s]) => html`${g}: ${chip(s)} `)}</p><p class="muted">Evaluated ${ts(recorded.evaluatedAt)} under policy v${recorded.policyVersion}.</p>`
              : html`<p class="muted">No recorded evaluation.</p>`}
        </section>

        <section class="card">
          <h2>Power compatibility</h2>${powerTable(ev)}
        </section>

        <section class="card">
          <h2>Site evidence (SITE gate)</h2>
          <p class="muted">Messages are communications, not verification evidence. Confirming a site contact is a separate recorded decision (HUMAN_CONFIRMED).</p>
          ${table(
            ['Item', 'Entered values', 'Status', 'Entered', 'Latest decision', ...(siteVerifier && pre ? ['Decision'] : [])],
            siteClaims.map((c) => [
              html`<strong>${c.def.label}</strong>`,
              html`<dl class="kv">${c.def.fields.map((f) => html`<dt>${f}</dt><dd>${np(c.values[f])}</dd>`)}</dl>`,
              chip(c.status),
              html`${c.enteredByName}<br>${ts(c.claim.entered_at)}`,
              c.lastStatus && c.lastStatus.status !== 'OPERATOR_ENTERED' ? html`${userDisplayName(db, c.lastStatus.actor_id)}<br>${ts(c.lastStatus.at)}${c.lastStatus.note ? html`<br><em>${c.lastStatus.note}</em>` : ''}` : html`<span class="muted">—</span>`,
              ...(siteVerifier && pre
                ? [
                    html`<form method="post" action="/evidence/${c.claim.id}/review" class="review">${csrfField(req)}<input type="hidden" name="back" value="/jobs/${job.id}">
                  ${select('Decision', 'decision', '', [['VERIFIED', c.def.key === 'site.contact' ? 'Human confirmed' : 'Verify'], ['UNCONFIRMED', 'Unconfirmed'], ['REJECTED', 'Reject']], { required: true })}
                  ${textarea('How was this confirmed?', 'note', '', 2)}
                  ${msgs.length ? select('Cite a thread message (optional)', 'supportingMessageId', '', msgs.map((m) => [m.id, `${m.author_name}: ${m.body.slice(0, 40)}`]), { blank: '— none —' }) : ''}
                  <button>Record</button></form>`,
                  ]
                : []),
            ]),
            'No site details entered yet.',
          )}
        </section>

        ${manage && pre
          ? html`<section class="card"><h2>Assignment</h2>
          <form method="post" action="/jobs/${job.id}/assign" class="grid">${csrfField(req)}
            ${select('Owner-operator', 'owner_operator_id', ooId, oos.map((o) => [o.id, o.legal_name]), { required: true })}
            ${select('Driver', 'driver_id', job.assigned_driver_id, opts('drivers', 'full_name'), { blank: '— none —' })}
            ${select('Truck', 'truck_id', job.assigned_truck_id, opts('trucks', 'label'), { blank: '— none —' })}
            ${select('Cold asset', 'asset_id', job.assigned_asset_id, opts('cold_assets', 'unit_id'), { blank: '— none —' })}
            ${select('Power / generator', 'power_id', job.assigned_power_id, opts('power_configs', 'label'), { blank: '— none —' })}
            <button>Save assignment</button><small class="span muted">Lists show the selected owner-operator's records. Changing owner-operator? Save once, then pick units.</small></form></section>
          <p><a class="button" href="/jobs/${job.id}/edit">Edit specification</a></p>`
          : ''}

        ${progress && !pre
          ? html`<section class="card"><h2>Delivery progress</h2>
          ${job.stage === 'DISPATCHED' ? html`<form method="post" action="/jobs/${job.id}/arrive" class="grid">${csrfField(req)}${field('Arrived at (optional, UTC)', 'occurredAt', '', { type: 'datetime-local' })}${field('Note', 'note', '')}<button>Record ARRIVED</button></form>` : ''}
          ${job.stage === 'ARRIVED' ? html`<form method="post" action="/jobs/${job.id}/deliver" class="grid">${csrfField(req)}${field('Delivered at (optional, UTC)', 'occurredAt', '', { type: 'datetime-local' })}${field('Operator-reported temp (°F)', 'loggedTempF', '', { type: 'number', step: '0.1' })}${field('Note', 'note', '')}<button>Record DELIVERED</button></form>` : ''}
          ${job.stage === 'DELIVERED'
            ? html`<h3>Upload POD document</h3><form method="post" action="/jobs/${job.id}/documents?_csrf=${req.csrf}" enctype="multipart/form-data" class="grid">
              ${select('Category', 'category', 'POD', [['POD', 'POD'], ['DELIVERY_EVIDENCE', 'Delivery evidence']])}<label class="field"><span>File (PDF/PNG/JPEG)</span><input type="file" name="file" required></label><button>Upload</button></form>
              <h3>Record POD</h3><form method="post" action="/jobs/${job.id}/pod" class="grid">${csrfField(req)}
              ${field('Receiver name', 'receiver_name', '', { required: true })}${field('Received at (UTC)', 'received_at', '', { type: 'datetime-local', required: true })}${field('Delivered temp (°F)', 'delivered_temp_f', '', { type: 'number', step: '0.1' })}${textarea('Notes', 'notes', '')}
              <fieldset class="span"><legend>Attach uploaded documents</legend>${docs.filter((d) => d.category === 'POD' || d.category === 'DELIVERY_EVIDENCE').map((d) => html`<label><input type="checkbox" name="document_ids" value="${d.id}"> ${d.original_filename}</label> `)}</fieldset>
              <button>Record POD</button></form>`
            : ''}
          </section>`
          : ''}

        ${pods.length ? html`<section class="card"><h2>POD</h2>${table(['Receiver', 'Received', 'Temp', 'Documents', 'Recorded by'], pods.map((p) => [html`${String(p.receiver_name)}`, ts(String(p.received_at)), np(p.delivered_temp_f, '°F'), html`${(JSON.parse(String(p.document_ids_json)) as string[]).map((d) => html`<a href="/documents/${d}/open">${d}</a> `)}`, html`${userDisplayName(db, String(p.recorded_by))} ${ts(String(p.recorded_at))}`]))}</section>` : ''}

        ${docs.length ? html`<section class="card"><h2>Job documents (private)</h2>${table(['File', 'Category', 'SHA-256', 'Uploaded'], docs.map((d) => [html`<a href="/documents/${d.id}/open">${d.original_filename}</a>`, html`${d.category}`, html`<code class="hash">${d.sha256.slice(0, 16)}…</code>`, ts(d.uploaded_at)]))}</section>` : ''}

        ${can(a, 'vault.seal') && job.stage === 'POD_RECORDED' ? html`<section class="card"><h2>Proof Vault</h2>${postButton(req, `/jobs/${job.id}/seal`, 'Seal evidence package', { cls: 'primary' })}<p class="muted">${HASH_DISCLAIMER}</p></section>` : ''}
        ${manifests.length ? html`<section class="card"><h2>Sealed manifests</h2>${table(['Version', 'Hash', 'Sealed', ''], manifests.map((m) => [html`v${m.version}${m.supersedes_manifest_id ? ' (supplemental)' : ''}`, html`<code class="hash">${m.manifest_hash.slice(0, 20)}…</code>`, ts(m.sealed_at), html`<a href="/manifests/${m.id}">View & verify</a>`]))}</section>` : ''}

        <section class="card"><h2>Crew thread</h2>
          <p class="muted">Internal communication linked to this job. Messages are not verification evidence unless a reviewer cites one in a recorded decision.</p>
          <ul class="thread">${msgs.map((m) => html`<li><strong>${m.author_name}</strong> <small>${ts(m.created_at)}</small><br>${m.body}</li>`)}</ul>
          ${can(a, 'message.post') ? html`<form method="post" action="/jobs/${job.id}/messages">${csrfField(req)}${textarea('Message', 'body', '', 2)}<button>Post</button></form>` : ''}
        </section>

        <section class="card"><h2>Event timeline (append-only)</h2>${timeline(db, job.id)}</section>`,
      );
    }),
  );

  r.get('/jobs/:id/edit', page((req, a) => {
    const job = getJob(db, a, String(req.params.id));
    if (!can(a, 'job.manage')) throw new AppError('FORBIDDEN', 'Only dispatchers edit jobs.');
    return layout(req, `Edit ${job.quote_ref}`, html`<p class="notice">Each change is recorded as an event and creates new, unverified site evidence where values changed. Editing after a passing SET returns the job to SPEC.</p>${specForm(req, db, job, `/jobs/${job.id}/spec`)}`);
  }));
  r.post('/jobs/:id/spec', action((req, a) => (updateJobSpec(db, a, String(req.params.id), req.body), withMsg(`/jobs/${req.params.id}`, 'Specification saved.'))));
  r.post('/jobs/:id/assign', action((req, a) => (assignJob(db, a, String(req.params.id), req.body), withMsg(`/jobs/${req.params.id}`, 'Assignment saved.'))));
  r.post('/jobs/:id/repin', action((req, a) => (repinPolicy(db, a, String(req.params.id)), withMsg(`/jobs/${req.params.id}`, 'Job re-pinned to the current policy version (recorded).'))));
  r.post('/jobs/:id/set', action((req, a) => {
    const ev = attemptSet(db, a, String(req.params.id));
    return withMsg(`/jobs/${req.params.id}`, ev.status === 'GREEN' ? 'SET passed (GREEN). Review the packet before dispatch.' : `SET blocked: ${ev.status}${ev.siteUnconfirmed ? ' — SITE UNCONFIRMED' : ''}. The attempt and reasons were recorded.`);
  }));

  r.get(
    '/jobs/:id/packet',
    page((req, a) => {
      const job = getJob(db, a, String(req.params.id));
      const ev = evaluateJob(db, job, policyByVersion(db, job.policy_version));
      const packet = jobPacket(db, job, ev);
      const canDispatch = can(a, 'job.dispatch') && job.stage === 'SET' && ev.status === 'GREEN';
      return layout(
        req,
        `Job packet — ${job.quote_ref}`,
        html`${demoBadge(job.is_demo)}${packetView(packet)}
        <section class="card"><h2>Gate detail</h2>${gateGrid(ev)}${reasonsList(ev)}</section>
        ${canDispatch
          ? html`<section class="card confirm"><h2>Dispatch confirmation</h2><p>Dispatching records <strong>${a.displayName}</strong> as dispatch operator with a server timestamp. The server re-evaluates the job; only GREEN jobs dispatch.</p>
            ${postButton(req, `/jobs/${job.id}/dispatch`, 'Confirm dispatch', { cls: 'primary' })}</section>`
          : html`<p class="muted">${job.stage === 'SET' ? (can(a, 'job.dispatch') ? 'Dispatch unavailable: job is not GREEN.' : 'Only a dispatcher can dispatch.') : `Dispatch requires a passing SET (stage is ${job.stage}).`}</p>`}
        <p><a href="/jobs/${job.id}">← Back to job</a></p>`,
      );
    }),
  );
  r.post('/jobs/:id/dispatch', action((req, a) => (dispatchJob(db, a, String(req.params.id)), withMsg(`/jobs/${req.params.id}`, 'Dispatched. Packet recorded in the Proof Vault.'))));
  r.post('/jobs/:id/arrive', action((req, a) => (markArrived(db, a, String(req.params.id), req.body.occurredAt, req.body.note), withMsg(`/jobs/${req.params.id}`, 'Arrival recorded.'))));
  r.post('/jobs/:id/deliver', action((req, a) => (markDelivered(db, a, String(req.params.id), req.body.occurredAt, req.body.note, req.body.loggedTempF), withMsg(`/jobs/${req.params.id}`, 'Delivery recorded.'))));
  r.post('/jobs/:id/documents', upload.single('file'), action((req, a) => {
    if (!req.file) throw new AppError('VALIDATION_FAILED', 'File is required.');
    uploadDocument(db, storage, a, { jobId: String(req.params.id), category: req.body.category, filename: req.file.originalname, declaredMime: req.file.mimetype, data: req.file.buffer });
    return withMsg(`/jobs/${req.params.id}`, 'Document uploaded privately.');
  }));
  r.post('/jobs/:id/pod', action((req, a) => {
    const ids = req.body.document_ids;
    recordPod(db, a, String(req.params.id), { ...req.body, document_ids: Array.isArray(ids) ? ids : ids ? [ids] : [] });
    return withMsg(`/jobs/${req.params.id}`, 'POD recorded.');
  }));
  r.post('/jobs/:id/seal', action((req, a) => {
    const { manifest } = sealJob(db, a, String(req.params.id));
    return withMsg(`/manifests/${manifest.id}`, 'Sealed. Manifest hash computed server-side.');
  }));
  r.post('/jobs/:id/corrections', action((req, a) => (recordCorrection(db, a, String(req.params.id), req.body), withMsg(`/jobs/${req.params.id}/vault`, 'Correction recorded as a new linked event. Original records unchanged.'))));
  r.post('/jobs/:id/messages', action((req, a) => (postMessage(db, a, String(req.params.id), req.body.body), `/jobs/${req.params.id}#thread`)));

  r.get(
    '/jobs/:id/vault',
    page((req, a) => {
      const job = getJob(db, a, String(req.params.id));
      const manifests = manifestsFor(db, job.id);
      const canCorrect = can(a, 'vault.correct') && !['QUOTE', 'SPEC', 'SET'].includes(job.stage);
      return layout(
        req,
        `Proof Vault — ${job.quote_ref}`,
        html`${demoBadge(job.is_demo)}<p class="notice">${HASH_DISCLAIMER}</p>
        <section class="card"><h2>Sealed manifests</h2>${table(['Version', 'Manifest hash', 'Sealed', ''], manifests.map((m) => [html`v${m.version}${m.supersedes_manifest_id ? ' (supplemental)' : ''}`, html`<code class="hash">${m.manifest_hash}</code>`, ts(m.sealed_at), html`<a href="/manifests/${m.id}">View & verify</a>`]), 'Not sealed yet.')}
        ${manifests.length && can(a, 'vault.export') ? html`<p><a class="button" href="/jobs/${job.id}/export.json">Export evidence package (JSON)</a></p>` : ''}</section>
        ${canCorrect
          ? html`<section class="card"><h2>Record correction</h2><p class="muted">Creates a new event linked to the latest seal. Nothing already recorded is edited. After a correction, a supplemental manifest can be sealed.</p>
          <form method="post" action="/jobs/${job.id}/corrections" class="grid">${csrfField(req)}${field('Field / fact being corrected', 'field', '', { required: true })}${field('Corrected value', 'corrected_value', '')}${textarea('Reason', 'reason', '')}<button>Record correction</button></form>
          ${manifests.length && can(a, 'vault.seal') ? postButton(req, `/jobs/${job.id}/seal`, 'Seal supplemental manifest') : ''}</section>`
          : ''}
        <section class="card"><h2>Chronological event timeline</h2>${timeline(db, job.id)}</section>`,
      );
    }),
  );

  r.get('/jobs/:id/export.json', (req, res, next) => {
    try {
      if (!req.actor) throw new AppError('UNAUTHENTICATED', 'Login required');
      const pkg = exportPackage(db, req.actor, String(req.params.id));
      res.setHeader('Content-Disposition', `attachment; filename="evidence-${pkg.jobSummary.quoteRef}-v${pkg.manifestVersion}.json"`);
      res.json(pkg);
    } catch (e) {
      next(e);
    }
  });

  r.get(
    '/manifests/:id',
    page((req, a) => {
      const m = get<{ id: string; job_id: string; version: number; manifest_json: string; manifest_hash: string; sealed_at: string; sealed_by: string; policy_version: number; supersedes_manifest_id: string | null }>(db, 'SELECT * FROM sealed_manifests WHERE id = ?', String(req.params.id));
      if (!m) throw new AppError('NOT_FOUND', 'Manifest not found.');
      getJob(db, a, m.job_id); // tenant check
      const v = verifyManifestFor(db, a, m.id);
      const manifest = JSON.parse(m.manifest_json);
      return layout(
        req,
        `Sealed manifest v${m.version}`,
        html`<section class="card"><h2>Integrity check (recomputed now)</h2>
          <p>${chip(v.ok ? 'PASS' : 'FAIL', v.ok ? 'Unchanged since sealing' : 'MISMATCH — record differs from what was sealed')}</p>
          <dl class="kv"><dt>Stored hash</dt><dd><code class="hash">${v.storedHash}</code></dd><dt>Recomputed</dt><dd><code class="hash">${v.recomputedHash}</code> ${chip(v.manifestHashMatches ? 'PASS' : 'FAIL')}</dd>
          <dt>Ledger anchor (SEALED event)</dt><dd><code class="hash">${v.ledgerAnchorHash ?? 'missing'}</code> ${chip(v.ledgerAnchorMatches ? 'PASS' : 'FAIL')}</dd><dt>Ledger hash chain</dt><dd>${chip(v.ledgerChainIntact ? 'PASS' : 'FAIL')}</dd>
          <dt>Sealed</dt><dd>${ts(m.sealed_at)} by ${userDisplayName(db, m.sealed_by)} under policy v${m.policy_version}</dd>
          ${m.supersedes_manifest_id ? html`<dt>Supersedes</dt><dd><a href="/manifests/${m.supersedes_manifest_id}">previous manifest</a> (preserved)</dd>` : ''}</dl>
          <p class="notice">${v.disclaimer}</p></section>
        <section class="card"><h2>Manifest contents</h2>
          <dl class="kv"><dt>Job / quote</dt><dd><a href="/jobs/${m.job_id}">${manifest.quoteRef}</a></dd>
          <dt>Pickup</dt><dd>${np(manifest.pickup.location)} (${np(manifest.pickup.lat)}, ${np(manifest.pickup.lng)})</dd>
          <dt>Delivery pin</dt><dd>${np(manifest.deliveryPin.address)} (${np(manifest.deliveryPin.lat)}, ${np(manifest.deliveryPin.lng)})</dd>
          <dt>Window</dt><dd>${ts(manifest.deliveryWindow.start)} → ${ts(manifest.deliveryWindow.end)}</dd>
          <dt>Driver / truck / asset</dt><dd>${np(manifest.driverId)} / ${np(manifest.truckId)} / ${np(manifest.assetId)} (${np(manifest.assetClass)})</dd>
          <dt>Power at dispatch</dt><dd>${manifest.power.matchResultAtDispatch ? html`${chip(manifest.power.matchResultAtDispatch.result)} via ${manifest.power.matchResultAtDispatch.source}` : np(null)}</dd>
          <dt>Setpoint / commodity</dt><dd>${np(manifest.setpointF, '°F')} / ${np(manifest.commodity)}</dd>
          <dt>Gates at dispatch</dt><dd>${manifest.gateResultsAtDispatch ? Object.entries(manifest.gateResultsAtDispatch as Record<string, string>).map(([g, s]) => html`${g}: ${chip(s)} `) : np(null)}</dd>
          <dt>Site contact</dt><dd>${np(manifest.siteContact.name)} ${chip(manifest.siteContact.confirmationState)} ${ts(manifest.siteContact.confirmedAt)}</dd>
          <dt>Timestamps</dt><dd>${Object.entries(manifest.timestamps as Record<string, string | null>).map(([k, t]) => html`${k}: ${ts(t)}<br>`)}</dd>
          <dt>Evidence references</dt><dd>${(manifest.evidenceReferences as string[]).length} item(s)</dd>
          <dt>Corrections</dt><dd>${(manifest.corrections as unknown[]).length}</dd>
          <dt>Policy</dt><dd>v${manifest.policy.version} ${manifest.policy.documentCode} (config hash <code class="hash">${String(manifest.policy.configHash).slice(0, 12)}…</code>)</dd>
          <dt>Previous event</dt><dd><code class="hash">${manifest.previousEvent?.eventHash ?? '—'}</code></dd></dl>
          <details><summary>Canonical JSON</summary><pre>${JSON.stringify(manifest, null, 2)}</pre></details></section>`,
      );
    }),
  );
}
