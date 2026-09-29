import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { all, get, insert, run, tx, type DB } from '../db.js';
import { config } from '../config.js';
import { AppError, conflict, invalid } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { appendEvent } from './ledger.js';
import { requirePerm } from './permissions.js';
import { ROLES, type Actor, type Role } from './types.js';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

const tokenHash = (t: string) => createHash('sha256').update(`${config.sessionSecret}:${t}`).digest('hex');

export function loadActor(db: DB, userId: string): Actor | null {
  const u = get<{ id: string; email: string; display_name: string; owner_operator_id: string | null; active: number }>(db, 'SELECT * FROM users WHERE id = ?', userId);
  if (!u || !u.active) return null;
  const roles = all<{ role: Role }>(db, 'SELECT role FROM user_roles WHERE user_id = ? ORDER BY role', userId).map((r) => r.role);
  return { id: u.id, email: u.email, displayName: u.display_name, roles, ownerOperatorId: u.owner_operator_id };
}

export function login(db: DB, email: string, password: string) {
  const u = get<{ id: string; password_hash: string; active: number }>(db, 'SELECT id, password_hash, active FROM users WHERE email = ?', String(email ?? '').toLowerCase().trim());
  // Constant-ish work whether or not the user exists.
  const ok = u ? verifyPassword(String(password ?? ''), u.password_hash) : (verifyPassword('x', hashPassword('y')), false);
  if (!u || !ok || !u.active) {
    appendEvent(db, { entityType: 'auth', entityId: 'login', eventType: 'LOGIN_FAILED', actorId: null, payload: { emailHash: createHash('sha256').update(String(email ?? '').toLowerCase()).digest('hex').slice(0, 16) } });
    throw new AppError('UNAUTHENTICATED', 'Invalid email or password.');
  }
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600_000).toISOString();
  insert(db, 'sessions', { token_hash: tokenHash(token), user_id: u.id, csrf_token: csrf, created_at: nowIso(), expires_at: expires });
  appendEvent(db, { entityType: 'user', entityId: u.id, eventType: 'LOGIN', actorId: u.id, payload: {} });
  return { token, csrf, expires };
}

export function sessionFromToken(db: DB, token: string | undefined): { actor: Actor; csrf: string } | null {
  if (!token) return null;
  const s = get<{ user_id: string; csrf_token: string; expires_at: string }>(db, 'SELECT * FROM sessions WHERE token_hash = ?', tokenHash(token));
  if (!s || s.expires_at < nowIso()) return null;
  const actor = loadActor(db, s.user_id);
  return actor ? { actor, csrf: s.csrf_token } : null;
}

export function logout(db: DB, token: string | undefined) {
  if (token) run(db, 'DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
}

export const userSchema = z.object({
  email: z.string().email().max(200).transform((s) => s.toLowerCase()),
  display_name: z.string().trim().min(2).max(120),
  password: z.string().min(12, 'at least 12 characters').max(200),
  roles: z.array(z.enum(ROLES)).min(1),
  owner_operator_id: z.preprocess((v) => (v === '' ? null : v), z.string().nullable().optional()),
});

export function createUser(db: DB, actor: Actor | null, input: unknown, opts: { isDemo?: boolean; bootstrap?: boolean } = {}) {
  if (!opts.bootstrap) requirePerm(actor!, 'user.manage');
  const r = userSchema.safeParse(input);
  if (!r.success) throw invalid('Validation failed.', r.error.flatten());
  const d = r.data;
  if (d.roles.includes('OWNER_OPERATOR') && !d.owner_operator_id && !opts.bootstrap) throw invalid('Owner-operator users must be linked to an owner-operator business.');
  return tx(db, () => {
    if (get(db, 'SELECT 1 FROM users WHERE email = ?', d.email)) throw conflict('Email already in use.');
    const id = newId('usr');
    insert(db, 'users', { id, email: d.email, display_name: d.display_name, password_hash: hashPassword(d.password), owner_operator_id: d.owner_operator_id ?? null, active: 1, is_demo: opts.isDemo ? 1 : 0, created_at: nowIso() });
    for (const role of new Set(d.roles)) insert(db, 'user_roles', { user_id: id, role });
    appendEvent(db, { entityType: 'user', entityId: id, eventType: 'USER_CREATED', actorId: actor?.id ?? null, payload: { roles: d.roles, ownerOperatorId: d.owner_operator_id ?? null } });
    return id;
  });
}

export function setUserRoles(db: DB, actor: Actor, userId: string, roles: Role[]) {
  requirePerm(actor, 'user.manage');
  const parsed = z.array(z.enum(ROLES)).min(1).safeParse(roles);
  if (!parsed.success) throw invalid('Invalid roles.');
  if (userId === actor.id && !parsed.data.includes('ADMIN')) throw invalid('You cannot remove your own ADMIN role.');
  tx(db, () => {
    run(db, 'DELETE FROM user_roles WHERE user_id = ?', userId);
    for (const role of new Set(parsed.data)) insert(db, 'user_roles', { user_id: userId, role });
    run(db, 'DELETE FROM sessions WHERE user_id = ?', userId);
    appendEvent(db, { entityType: 'user', entityId: userId, eventType: 'USER_ROLES_CHANGED', actorId: actor.id, payload: { roles: parsed.data } });
  });
}

export function setUserActive(db: DB, actor: Actor, userId: string, active: boolean) {
  requirePerm(actor, 'user.manage');
  if (userId === actor.id) throw invalid('You cannot deactivate yourself.');
  tx(db, () => {
    run(db, 'UPDATE users SET active = ? WHERE id = ?', active ? 1 : 0, userId);
    if (!active) run(db, 'DELETE FROM sessions WHERE user_id = ?', userId);
    appendEvent(db, { entityType: 'user', entityId: userId, eventType: active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', actorId: actor.id, payload: {} });
  });
}

export function listUsers(db: DB, actor: Actor) {
  requirePerm(actor, 'user.manage');
  return all<{ id: string; email: string; display_name: string; owner_operator_id: string | null; active: number; is_demo: number; roles: string }>(
    db,
    `SELECT u.id, u.email, u.display_name, u.owner_operator_id, u.active, u.is_demo, GROUP_CONCAT(r.role, ', ') AS roles
     FROM users u LEFT JOIN user_roles r ON r.user_id = u.id GROUP BY u.id ORDER BY u.display_name`,
  );
}

export function userDisplayName(db: DB, id: string | null | undefined) {
  if (!id) return null;
  return get<{ display_name: string }>(db, 'SELECT display_name FROM users WHERE id = ?', id)?.display_name ?? id;
}
