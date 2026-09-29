import type { Request } from 'express';
import { config } from '../../config.js';
import { can, hasRole, isTenantRestricted } from '../../domain/permissions.js';
import type { Actor } from '../../domain/types.js';

export class Safe {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export function esc(v: unknown): string {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

/** Tagged template: every interpolation is HTML-escaped unless it is a Safe value. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Safe(out);
}

export const raw = (s: string) => new Safe(s);

// ------------------------------------------------------------------ formatting
const tsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: config.displayTimeZone,
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

export function ts(iso: string | null | undefined): Safe {
  if (!iso) return html`<span class="muted">not recorded</span>`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return html`${iso}`;
  return html`<time datetime="${iso}" title="${iso} (UTC)">${tsFmt.format(d)}</time>`;
}

export const np = (v: unknown, suffix = ''): Safe =>
  v === null || v === undefined || v === '' ? html`<span class="muted np">not provided</span>` : html`${String(v)}${suffix}`;

export const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ------------------------------------------------------------------ status chips (text + icon, not color alone)
const CHIP: Record<string, { icon: string; label: string; cls: string }> = {
  VERIFIED: { icon: '✔', label: 'Verified', cls: 'ok' },
  PENDING: { icon: '⏳', label: 'Pending review', cls: 'pending' },
  PENDING_REVIEW: { icon: '⏳', label: 'Pending review', cls: 'pending' },
  OPERATOR_ENTERED: { icon: '✎', label: 'Operator-entered (unverified)', cls: 'entered' },
  UNCONFIRMED: { icon: '?', label: 'Unconfirmed', cls: 'unconfirmed' },
  REJECTED: { icon: '✖', label: 'Rejected', cls: 'bad' },
  FAILED: { icon: '✖', label: 'Failed', cls: 'bad' },
  EXPIRED: { icon: '⌛', label: 'Expired', cls: 'bad' },
  NOT_STARTED: { icon: '○', label: 'Not started', cls: 'entered' },
  MISSING: { icon: '○', label: 'Not provided', cls: 'entered' },
  GREEN: { icon: '●', label: 'GREEN — may dispatch', cls: 'ok' },
  YELLOW: { icon: '▲', label: 'YELLOW — incomplete, do not dispatch', cls: 'pending' },
  RED: { icon: '■', label: 'RED — blocker, do not dispatch', cls: 'bad' },
  MATCH: { icon: '✔', label: 'Power match', cls: 'ok' },
  MISMATCH: { icon: '✖', label: 'Power mismatch', cls: 'bad' },
  PASS: { icon: '✔', label: 'Pass', cls: 'ok' },
  FAIL: { icon: '✖', label: 'Fail', cls: 'bad' },
  UNKNOWN: { icon: '?', label: 'Unknown', cls: 'unconfirmed' },
  INFO: { icon: 'ℹ', label: 'Info', cls: 'entered' },
  DRAFT: { icon: '✎', label: 'Draft', cls: 'entered' },
  ISSUED: { icon: '⏳', label: 'Issued', cls: 'pending' },
  PARTIALLY_PAID: { icon: '◐', label: 'Partially paid (recorded)', cls: 'pending' },
  PAID: { icon: '✔', label: 'Paid (recorded)', cls: 'ok' },
  VOID: { icon: '✖', label: 'Void', cls: 'bad' },
  NOT_CONNECTED: { icon: '○', label: 'Not connected', cls: 'unconfirmed' },
  LOCAL_DEV_ONLY: { icon: '⚙', label: 'Local development only', cls: 'pending' },
  CONNECTED: { icon: '✔', label: 'Connected', cls: 'ok' },
};

export function chip(status: string | null | undefined, labelOverride?: string): Safe {
  const c = CHIP[status ?? 'MISSING'] ?? { icon: '•', label: String(status), cls: 'entered' };
  return html`<span class="chip chip-${c.cls}"><span aria-hidden="true">${c.icon}</span> ${labelOverride ?? c.label}</span>`;
}

export const demoBadge = (isDemo: unknown) => (isDemo ? html`<span class="chip chip-demo" title="Fictional demonstration data">DEMO / FICTIONAL</span>` : '');

// ------------------------------------------------------------------ forms
export const csrfField = (req: Request) => html`<input type="hidden" name="_csrf" value="${req.csrf ?? ''}">`;

export function field(label: string, name: string, value: unknown, opts: { type?: string; required?: boolean; help?: string; step?: string; placeholder?: string } = {}): Safe {
  const v = value === null || value === undefined ? '' : String(value);
  return html`<label class="field"><span>${label}${opts.required ? html` <abbr title="required">*</abbr>` : ''}</span>
    <input name="${name}" type="${opts.type ?? 'text'}" value="${v}" ${opts.required ? raw('required') : ''} ${opts.step ? html`step="${opts.step}"` : ''} placeholder="${opts.placeholder ?? ''}">
    ${opts.help ? html`<small>${opts.help}</small>` : ''}</label>`;
}

export function select(label: string, name: string, value: unknown, options: [string, string][], opts: { required?: boolean; blank?: string } = {}): Safe {
  return html`<label class="field"><span>${label}${opts.required ? html` <abbr title="required">*</abbr>` : ''}</span>
    <select name="${name}" ${opts.required ? raw('required') : ''}>
      ${opts.blank !== undefined ? html`<option value="">${opts.blank}</option>` : ''}
      ${options.map(([v, l]) => html`<option value="${v}" ${String(value ?? '') === v ? raw('selected') : ''}>${l}</option>`)}
    </select></label>`;
}

export function textarea(label: string, name: string, value: unknown, rows = 3, help?: string): Safe {
  return html`<label class="field"><span>${label}</span><textarea name="${name}" rows="${rows}">${value ?? ''}</textarea>${help ? html`<small>${help}</small>` : ''}</label>`;
}

export function postButton(req: Request, action: string, label: string, opts: { cls?: string; fields?: Record<string, string>; confirm?: boolean } = {}): Safe {
  return html`<form method="post" action="${action}" class="inline">${csrfField(req)}${Object.entries(opts.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="${opts.cls ?? ''}">${label}</button></form>`;
}

// ------------------------------------------------------------------ layout
function nav(actor: Actor): Safe {
  const items: [string, string, boolean][] = [
    ['/', 'Dashboard', true],
    ['/owner-operators', isTenantRestricted(actor) ? 'My onboarding' : 'Owner-operators', true],
    ['/review', 'Qualification review', can(actor, 'evidence.review') || hasRole(actor, 'READ_ONLY_AUDITOR')],
    ['/jobs', isTenantRestricted(actor) ? 'My jobs' : 'Jobs & dispatch', true],
    ['/invoices', 'Invoices', isTenantRestricted(actor) || can(actor, 'invoice.read_all')],
    ['/policies', 'Policy', true],
    ['/ledger', 'Ledger integrity', can(actor, 'ledger.read_all')],
    ['/admin/users', 'Users', can(actor, 'user.manage')],
    ['/admin/system', 'System & integrations', can(actor, 'retention.manage')],
  ];
  return html`<nav aria-label="Main">${items.filter(([, , show]) => show).map(([href, label]) => html`<a href="${href}">${label}</a>`)}</nav>`;
}

export function layout(req: Request, title: string, body: Safe, opts: { flash?: string } = {}): string {
  const a = req.actor;
  const flash = opts.flash ?? (typeof req.query.msg === 'string' ? req.query.msg : '');
  return `<!doctype html>${html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Cold Cover + Proof Vault</title><link rel="stylesheet" href="/static/app.css"></head>
<body>
<header class="top">
  <div class="brand"><strong>Cold Cover</strong> <span class="muted">+ Proof Vault</span><div class="sub">Owner-Operator Cold-Asset Network</div></div>
  ${a ? html`<div class="who"><span>${a.displayName}</span> <span class="muted">(${a.roles.join(', ')})</span>
    <form method="post" action="/logout" class="inline">${csrfField(req)}<button class="link">Log out</button></form></div>` : ''}
</header>
${a ? nav(a) : ''}
<main id="main">
${flash ? html`<p class="flash" role="status">${flash}</p>` : ''}
<h1>${title}</h1>
${body}
</main>
<footer class="muted">Dispatch executes the job. The Vault records and preserves the evidence. Hashes show whether records changed — not whether claims are true. Times shown in ${config.displayTimeZone}.</footer>
</body></html>`.value}`;
}

export function table(headers: string[], rows: Safe[][], empty = 'Nothing to show.'): Safe {
  if (rows.length === 0) return html`<p class="muted">${empty}</p>`;
  return html`<div class="table-wrap"><table><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
  <tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
}

export const s = (v: unknown) => html`${v}`;
