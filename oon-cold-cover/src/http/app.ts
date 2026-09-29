import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { DB } from '../db.js';
import { AppError } from '../errors.js';
import type { StorageAdapter } from '../domain/documents.js';
import { sessionFromToken } from '../domain/users.js';
import type { Actor } from '../domain/types.js';
import { apiRouter } from './api.js';
import { uiRouter } from './ui/routes.js';
import { errorPage } from './ui/pages.js';

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    csrf?: string;
    sessionToken?: string;
  }
}

export interface AppDeps {
  db: DB;
  storage: StorageAdapter;
}

export const SESSION_COOKIE = 'oon_session';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res: Response, token: string, expires: string) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires: new Date(expires), path: '/' });
}

/** Simple fixed-window limiter for login attempts (per IP). In-memory: single-process only. */
const attempts = new Map<string, { n: number; reset: number }>();
export function loginRateLimit(req: Request) {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const cur = attempts.get(key);
  if (!cur || cur.reset < now) {
    attempts.set(key, { n: 1, reset: now + 15 * 60_000 });
    return;
  }
  cur.n++;
  if (cur.n > 20) throw new AppError('FORBIDDEN', 'Too many login attempts. Try again later.');
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
  app.use('/static', express.static(publicDir, { index: false, maxAge: 0 }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // session
  app.use((req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const s = sessionFromToken(deps.db, token);
    if (s) {
      req.actor = s.actor;
      req.csrf = s.csrf;
      req.sessionToken = token;
    }
    next();
  });

  // CSRF: every state-changing request from a session must echo the session's token.
  app.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.path === '/login' || req.path === '/api/auth/login') return next();
    if (!req.actor) return next(); // handlers reject unauthenticated calls
    const sent = (req.headers['x-csrf-token'] as string | undefined) ?? (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>)._csrf : undefined) ?? (req.query._csrf as string | undefined);
    if (sent !== req.csrf) return next(new AppError('CSRF', 'Missing or invalid CSRF token.'));
    next();
  });

  app.use('/api', apiRouter(deps));
  app.use('/', uiRouter(deps));

  app.use((req, _res, next) => next(new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}`)));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const multerErr = err as { code?: string; name?: string };
    const e =
      err instanceof AppError
        ? err
        : multerErr?.name === 'MulterError'
          ? new AppError('VALIDATION_FAILED', multerErr.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${config.maxUploadBytes} bytes.` : 'Invalid upload.')
          : (err as { type?: string })?.type === 'entity.parse.failed'
            ? new AppError('VALIDATION_FAILED', 'Malformed JSON body.')
            : null;
    if (!e) {
      // Log without request bodies (which may contain sensitive fields or document data).
      console.error(`[error] ${req.method} ${req.path}:`, err instanceof Error ? err.message : err);
    }
    const status = e?.status ?? 500;
    const payload = { error: { code: e?.code ?? 'INTERNAL', message: e?.message ?? 'Internal error.', details: e?.details } };
    if (req.path.startsWith('/api/')) return res.status(status).json(payload);
    if (status === 401) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.status(status).type('html').send(errorPage(req, status, payload.error.code, payload.error.message, payload.error.details));
  });

  return app;
}
