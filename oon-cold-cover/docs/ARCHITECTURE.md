# Architecture notes

## Layout

```
migrations/001_init.sql     relational schema + append-only triggers
src/config.ts               env configuration (secrets required in production)
src/db.ts                   node:sqlite wrapper, migration runner, transactions (savepoints when nested)
src/canonical.ts            canonical JSON + SHA-256
src/domain/                 all business rules and authorization (UI and API both call these)
  types.ts, permissions.ts  roles → permissions; tenant restriction for owner-operators
  policy.ts                 versioned policy (zod-validated), defaults from OON-QUAL-2026-V1
  evidence.ts               claim registry; append-only claims + status events; review rules
  gates.ts                  four-gate engine; per-subject gate status; job evaluation (GREEN/YELLOW/RED)
  power.ts                  structured power compatibility (voltage/phase/amps/connector/adapters/kW)
  onboarding.ts             owner-operator profile, drivers, trucks, assets, power, adapters, gate sign-off
  jobs.ts                   quote/spec/assign/SET/dispatch/arrive/deliver/POD
  vault.ts                  manifest build, seal, correction, verify, export
  ledger.ts                 hash-chained append-only event ledger + verification
  documents.ts              private storage adapter, content-type sniffing, signed links, access log, retention
  invoices.ts, messages.ts, users.ts, dashboard.ts, integrations.ts
src/http/app.ts             security headers, session, CSRF, error handling
src/http/api.ts             JSON API
src/http/ui/*               server-rendered HTML (auto-escaping template tag), no client JS
src/demo/fixtures.ts        fictional fixtures shared by the seed and the tests
src/cli/*                   migrate, seed, verify-ledger
```

**Authorization is enforced in the domain layer.** Every service function takes the acting user (`Actor`) and checks permissions and tenant scope itself. The UI hides actions the user cannot take, but security never depends on that.

## The four-gate model

The four top-level gates come from OON-QUAL-2026-V1: **ASSET, TRUCK, POWER, SITE**. The earlier seven-item job checklist is implemented as sub-requirements (reason codes) inside these gates. It is not a second qualification system.

- **Evidence claims** (`evidence_claims`) snapshot a group of entered fields, e.g. `truck.auto_liability = {auto_liability_usd, insurance_effective, insurance_expires}`, together with attached document ids. Claims are append-only. Editing a profile field or attaching a document creates a **new claim that supersedes** the previous one. The old claim and its review history stay as they were.
- **Evidence status** (`evidence_status_events`) is an append-only stream per claim: `OPERATOR_ENTERED → PENDING → VERIFIED | UNCONFIRMED | REJECTED`. Nothing stores a status column that could be flipped, so the current status is simply the latest event. Only authorized reviewers can add VERIFIED, REJECTED or UNCONFIRMED. The server refuses self-verification and refuses verification of items that are missing values or a document the policy requires.
- **Gate sign-off** (`gate_reviews`): once every required claim for a subject is verified and the policy thresholds pass, a qualification officer signs off. The sign-off records the **exact claim ids** it covers. If any of those claims changes later, the gate falls back to `PENDING_REVIEW` until someone reviews it again.
- **Gate statuses:** `NOT_STARTED`, `PENDING_REVIEW`, `VERIFIED`, `FAILED`, `EXPIRED`. Expiry covers insurance, registration, license and inspection age, checked as of the later of now and the delivery-window end.
- **Job evaluation** (`evaluateJob`) combines assignment checks, the per-subject gates, job-specific checks (asset class, setpoint vs. stated range, tow rating, hitch), power matching, and SITE sub-requirements. Any RED reason makes the job **RED**. Any YELLOW reason, or a POWER result other than MATCH, makes it **YELLOW**. Otherwise it is **GREEN**. The job is always evaluated under the policy version it is **pinned** to.

### Power matching (`src/domain/power.ts`)

1. The asset's power requirement must be complete and must fall inside an acceptable configuration in the policy.
2. Destination power is used only if it is stated available, **verified**, and the asset can take shore power. It must match voltage range, phase and amperage. The connector must match directly or through an **approved** adapter rated for the load, and the connector's rating in the catalog must cover the load. The cable run must not exceed the policy maximum.
3. Otherwise a generator is required. It needs at least the configured continuous kW, a fuel plan if the policy requires one, the same electrical checks as above, and a verified POWER gate.
4. Unknown values give **UNCONFIRMED**, which is YELLOW. Known mismatches give **MISMATCH**, which is RED. A connector name alone never establishes compatibility.

### SET and dispatch

- `attemptSet` always appends `SET_ATTEMPTED` with the full evaluation summary. It adds `SITE_UNCONFIRMED` for any site gap, then either `SET_PASSED` (stage becomes `SET`) or `SET_BLOCKED` with the failed gates and reason codes. Attempts are never removed.
- `dispatchJob` requires `job.dispatch` (DISPATCHER) and stage `SET`, and **re-evaluates on the server**. A job that is not GREEN produces `DISPATCH_REFUSED` plus `SET_INVALIDATED`, and the call returns 409 with reason codes. A GREEN job produces `DISPATCHED`, whose payload contains the full job packet and its hash. Request bodies are never read for status.
- A spec or assignment change after a passing SET returns the job to SPEC (`SET_INVALIDATED`). After dispatch the spec is locked; changes go in as correction events.

## Proof Vault

### Event hash (`src/domain/ledger.ts`)

`event_hash = SHA-256( canonicalJson({ event_id, entity_type, entity_id, event_type, actor_user_id, occurred_at, recorded_at, policy_version, payload, evidence_reference_ids, related_event_id, previous_event_hash }) )`

- `payload` and `evidence_reference_ids` are included as parsed JSON values.
- `seq` and `event_hash` are excluded.
- `previous_event_hash` is the hash of the previous event in the single global chain. The first event uses 64 zeros.
- Canonical JSON sorts object keys recursively, has no whitespace, omits `undefined` members, and rejects non-finite numbers (`src/canonical.ts`).

`verifyLedger()` recomputes every hash and checks every link (`npm run verify-ledger`, and the **Ledger integrity** page).

### Sealed manifest (`src/domain/vault.ts`)

The manifest contains:

- job and quote ids; pickup location and delivery pin; delivery window
- driver, truck, asset and power-config ids; asset class
- power requirement, site power, and the power match result recorded at dispatch
- setpoint and commodity
- gate results at dispatch; evidence reference ids; document ids and their SHA-256
- site-contact confirmation state, confirmer and time
- dispatch, arrival, delivery, POD and seal timestamps
- actor and reviewer ids
- policy version and policy config hash
- the previous event id and hash; corrections recorded so far

`manifest_hash = SHA-256(canonicalJson(manifest))`. The row goes into `sealed_manifests`, which is append-only, and a `SEALED` ledger event carrying `manifestHash` anchors it in the chain.

`verifyManifest()` checks three things:

1. It recomputes the hash from the stored manifest.
2. It compares that hash with the hash in the `SEALED` ledger event, which catches an attacker who rewrote both the manifest and its stored hash.
3. It verifies the whole ledger chain.

`verifyExportedPackage()` recomputes the hash of an exported JSON package.

### Corrections

`CORRECTION_RECORDED` events link to the latest seal through `related_event_id`. Sealing again after a correction creates a **supplemental manifest** (version n+1, with `supersedes_manifest_id`). Earlier manifests are never changed.

## Policy versioning

`policy_versions` is append-only. Each version stores its config JSON, its config hash, a change note and who created it, and creating one appends a `POLICY_VERSION_CREATED` event. Jobs store `policy_version` at creation. Evidence status events and gate reviews store the version in force when they were made. A dispatcher can move an undispatched job to the current version only through an explicit re-pin, which is recorded as `POLICY_REPINNED`. Dispatched and sealed jobs keep their version for good.
