# Cold Cover + Proof Vault — Owner-Operator Cold-Asset Network (MVP)

Policy document: **OON-QUAL-2026-V1** (effective 2026-09-27)

> **Dispatch executes the job. The Vault records and preserves the evidence.**
>
> QUOTE → SPEC → SET → DISPATCH → VAULT → POD → INVOICE

A working full-stack TypeScript MVP:

- **Cold Cover** covers onboarding, the four-gate qualification engine (ASSET / TRUCK / POWER / SITE), jobs, SET evaluation with reason codes, and dispatch. Only server-computed GREEN jobs can be dispatched.
- **Proof Vault** is an append-only, hash-chained event ledger with sealed evidence manifests (SHA-256 over canonical JSON). It also provides tamper verification, supplemental manifests after corrections, and a JSON export.
- It also includes invoices, versioned policy administration, a job-linked crew thread, private document storage with short-lived signed links, RBAC and an audit trail.

A hash shows whether a record changed after sealing. It **does not** prove that a claim is true, that an event happened, or that any legal requirement is met. The app says this wherever hashes appear.

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite` driver; no native build step)
- npm

## Setup and run

```bash
cd oon-cold-cover
npm install
npm run migrate        # creates ./data/oon.db and applies migrations + default policy v1
npm run seed           # DEMO / FICTIONAL data (refuses in production unless ALLOW_DEMO_SEED=true)
npm start              # http://localhost:3000  (npm run dev for watch mode)
```

To reset, delete `./data/` and run `npm run seed` again. The seed also migrates.

### Demo accounts (fictional; local only)

The password for every account is `demo-password-2026`, unless you set `DEMO_PASSWORD` before seeding.

| Email | Role(s) |
|---|---|
| admin@oon-demo.test | ADMIN |
| officer@oon-demo.test | QUALIFICATION_OFFICER |
| dispatch@oon-demo.test | DISPATCHER |
| dispatch-reviewer@oon-demo.test | DISPATCHER + QUALIFICATION_OFFICER |
| finance@oon-demo.test | FINANCE |
| auditor@oon-demo.test | READ_ONLY_AUDITOR |
| operator@oon-demo.test | OWNER_OPERATOR, eligible fleet "Northwind Cold Haul LLC (DEMO)" |
| operator2@oon-demo.test | OWNER_OPERATOR, "Prairie Reefer Co. (DEMO)", has known incompatibilities |
| operator3@oon-demo.test | OWNER_OPERATOR, "Coastal Chill Transport (DEMO)", unreviewed applicant |

### Seeded demo data (all labeled DEMO / FICTIONAL)

- Three owner-operators: one fully verified, one with known incompatibilities (6 kW generator, bumper-pull hitch vs. gooseneck asset, tow rating too low), and one unreviewed applicant.
- A **YELLOW** job: no delivery pin, site contact not yet confirmed, SET attempt recorded with `SITE_UNCONFIRMED`.
- A **RED** job with `TRUCK_TOW_RATING_EXCEEDED`, `HITCH_MISMATCH` and `GENERATOR_BELOW_MIN_KW`.
- A **GREEN** job with full history: `SET_ATTEMPTED → SITE_UNCONFIRMED → SET_BLOCKED → HUMAN_CONFIRMED → SET_ATTEMPTED → SET_PASSED → DISPATCHED`.
- A **sealed** Proof Vault record: `… DISPATCHED → ARRIVED → DELIVERED → POD_RECORDED → SEALED`, with a POD document.
- Two invoices: one issued with a manually recorded partial payment, and one draft for an equipment lease plus an upfit.

## Tests

```bash
npm test            # node:test + supertest; each test uses an in-memory DB and a temp storage dir
npm run typecheck   # tsc --noEmit (strict)
```

`test/acceptance.test.ts` has one `describe` block per acceptance criterion (1–12). `test/power.test.ts` covers the structured power-matching rules and canonical JSON.

## Other commands

| Command | Purpose |
|---|---|
| `npm run migrate` | Apply pending SQL migrations in `migrations/` (tracked in `schema_migrations`) and ensure policy v1 exists |
| `npm run seed` | Load demo data through the real domain services, so every record has genuine events |
| `npm run verify-ledger` | Recompute every ledger event hash, the chain links, and every sealed manifest. Exits 1 on mismatch |

## Pages

Login · Dashboard · Owner-operator list/profile/onboarding form (with progress and missing items) · Truck, driver, asset, power and adapter forms · Qualification review queue and per-operator review (evidence decisions and gate sign-off) · Job list/detail · Live SET evaluation with reason codes · Power compatibility table · Site evidence confirmation · Assignment · Job-packet preview and dispatch confirmation · Arrival, delivery and POD upload/recording · Proof Vault timeline, corrections and supplemental seal · Sealed-manifest view with live integrity check · JSON evidence export · Invoice list/detail/line items/payments · Policy view, new version and history · Ledger integrity · Users and roles · System, integrations and retention.

The JSON API lives under `/api/*`; see `src/http/api.ts`. API calls use the session cookie and need an `x-csrf-token` header on state-changing requests. `POST /api/auth/login` returns the token.

## Integration status (honest)

| Integration | Status |
|---|---|
| Document storage | Local private filesystem adapter. An object-storage adapter interface exists but is **not connected** |
| Malware scanning | **Not connected.** Files are checked by content signature (PDF/PNG/JPEG) and size only |
| Accounting sync | **Not connected** |
| Payment processing | **Not connected.** Payments are recorded manually and no funds move |
| Email/SMS | **Not connected.** Site confirmation is a person's recorded decision |
| Mapping/geocoding | **Not connected.** Pins are entered as coordinates |
| Telematics/temperature feeds | **Not connected** |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/SECURITY.md`](docs/SECURITY.md) for architecture notes, hash field definitions, security limitations and the production-hardening checklist.

## Assumptions and incomplete items

- **Single-process SQLite** suits an MVP. Moving to PostgreSQL means porting the migration SQL, which uses standard types and triggers, and replacing `node:sqlite` in `src/db.ts`. `node:sqlite` is marked experimental in Node 22; the npm scripts suppress that warning.
- **The ledger is one global hash chain.** Writes are serialized by SQLite's single writer. A multi-writer database would need a chain lock or per-stream chains.
- **Time zones:** timestamps are stored in UTC. The job form's `datetime-local` inputs are read as UTC, as the labels say. Display uses `DISPLAY_TIME_ZONE`.
- **Stated values vs. verified values:** kW ratings, temperature ranges and coverage amounts are what the operator entered. A reviewer's decision is stored separately and only means the reviewer accepted the evidence.
- **CDL and legal requirements:** the system never decides these. The reviewer records a decision plus a basis, and the policy requires the basis.
- **Site verification:** by default dispatchers may confirm site evidence they entered themselves (`reviewRules.allowSameUserSiteConfirmation`). Admins can turn this off in a new policy version. Onboarding evidence can never be verified by the person who entered it.
- **Owner-operator self-registration:** there is no public sign-up. Admins (or qualification officers) create profiles and users.
- **Login rate limiting** is in-memory and per process.
- The root `README.md` of this repository is the owner's GitHub profile README and was left unchanged. The app lives entirely in `oon-cold-cover/`.
