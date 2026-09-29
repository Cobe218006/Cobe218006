# Security notes, limitations and production-hardening checklist

## What is implemented

- **RBAC at the server.** Every domain service checks permissions (`src/domain/permissions.ts`), and owner-operators are tenant-scoped. Records belonging to another tenant return **404**, so their existence isn't revealed. The UI hides actions as well, but that is not what protects them.
- **Least privilege for documents** (`canReadDocument`):
  - Qualification officers and auditors can read documents, because they review them.
  - Owner-operators can read their own documents, plus documents on jobs assigned to them.
  - Dispatchers can read job documents only. Finance can read POD documents only.
  - ADMIN cannot read document contents unless the user also holds another role.
- **Private document storage.** Files live outside the web root under random keys, with `0600` file and `0700` directory permissions. There are no public URLs. Access goes through **short-lived HMAC-signed links**, 5 minutes by default, bound to both the user and the document. Every read re-checks authorization and re-verifies the stored content's SHA-256.
- **Access log.** Every link request and read, granted or denied, goes into the append-only `document_access_log`.
- **Upload validation.** Uploads have a size limit and are checked by **content signature** (PDF/PNG/JPEG); the declared MIME type must match the content. Filenames are sanitized, and content is served with `Content-Security-Policy: sandbox`.
- **No document contents in logs.** Ledger events record document metadata only: id, category, size, MIME type and SHA-256. The error handler logs the message, never request bodies. Site-contact phone numbers are masked in ledger payloads.
- **Sessions.** Random 256-bit tokens, stored only as a hash. Cookies are `HttpOnly` and `SameSite=Lax`, with `Secure` on in production. Sessions expire, and changing a user's roles or deactivating them revokes their sessions.
- **CSRF.** Every state-changing request needs the per-session CSRF token, either as a form field or as the `x-csrf-token` header.
- **Security headers.** Strict CSP (no inline script), `frame-ancestors 'none'`, `nosniff`, `no-referrer`, `Cache-Control: no-store`.
- **Passwords** are hashed with scrypt (N=16384). There is a basic per-IP login rate limit (in-memory).
- **Secrets** come only from environment variables. Production refuses to start without `SESSION_SECRET` and `DOCUMENT_LINK_SECRET`. `.env.example` contains placeholders only.
- **Retention workflow** (`runRetention`). Document **content** is purged once past `retention_until`, unless it is on legal hold or referenced by a sealed manifest. Metadata, hashes and ledger events are kept, and each purge is logged as `DOCUMENT_CONTENT_PURGED`.
- **Append-only tables** have `BEFORE UPDATE/DELETE` triggers: ledger, manifests, claims, claim statuses, gate reviews, policies, messages, PODs, payments and the access log. Document metadata rows cannot be deleted, and their identity fields cannot be changed.

## Known limitations (read before relying on this)

- **Immutability is not absolute.** SQLite triggers stop ordinary application code paths. Anyone with write access to the database file can drop them. The hash chain and the manifest anchor make that kind of tampering **detectable**, not impossible. For stronger guarantees, anchor the latest ledger hash periodically somewhere outside the database, such as WORM/object-lock storage or an external timestamping service.
- **Hashes prove integrity, not truth.** A matching hash only means the record hasn't changed since it was written or sealed.
- **No malware scanning** is connected. Treat uploaded files as untrusted, and connect a scanner before production use.
- **Local file storage** is for development only. Use encrypted object storage with server-side encryption and presigned, short-TTL GETs. `StorageAdapter` is the extension point.
- **The login rate limiter is in-memory and per process.** There is no account lockout and no MFA.
- **No password reset or email verification flow.** Admins set initial passwords.
- **Data at rest is not encrypted by the app.** Rely on disk or volume encryption.
- **Single-tenant deployment.** "Tenant" here means an owner-operator business within one network operator.

## Production-hardening checklist

- [ ] Run behind HTTPS. Set `NODE_ENV=production` and `COOKIE_SECURE=true`.
- [ ] Generate unique `SESSION_SECRET` and `DOCUMENT_LINK_SECRET` (≥ 32 random bytes) and keep them in a secret manager.
- [ ] Move to managed PostgreSQL with backups and point-in-time recovery. Revoke UPDATE/DELETE on append-only tables from the application role.
- [ ] Anchor the ledger head hash periodically to external immutable storage. Run `npm run verify-ledger` on a schedule and alert on failure.
- [ ] Replace local storage with encrypted object storage (SSE-KMS, private bucket, object lock for sealed evidence, presigned URLs ≤ 5 minutes).
- [ ] Connect malware scanning, and quarantine files until they are scanned. Update `scan_status` and the integrations page.
- [ ] Add MFA for staff roles, account lockout, a password policy, and SSO where available.
- [ ] Move rate limiting to a shared store, and cover login, uploads and the API.
- [ ] Centralize logs with PII scrubbing. Never log request bodies or document contents.
- [ ] Review the retention period (`documentRetentionDays`) and legal-hold procedures with counsel. Schedule retention runs.
- [ ] Have counsel review policy thresholds and labels. The app labels coverage as "meets configured network threshold", never "legally compliant".
- [ ] Run a dependency audit (`npm audit`) and pin versions. Enable automated updates.
- [ ] Get a penetration test focused on tenant isolation and document access.
- [ ] Remove the demo seed from production builds. Keep `ALLOW_DEMO_SEED=false`.
