import { Router } from 'express';
import { AppError } from '../../errors.js';
import { login, logout } from '../../domain/users.js';
import type { AppDeps } from '../app.js';
import { loginRateLimit, SESSION_COOKIE, setSessionCookie } from '../app.js';
import { registerJobPages } from './job-pages.js';
import { registerMiscPages } from './misc-pages.js';
import { registerOwnerOperatorPages } from './oo-pages.js';
import { loginPage, registerDashboard } from './pages.js';

export function uiRouter({ db, storage }: AppDeps) {
  const r = Router();
  r.get('/login', (req, res) => res.type('html').send(loginPage(req)));
  r.post('/login', (req, res, next) => {
    try {
      loginRateLimit(req);
      const s = login(db, req.body?.email, req.body?.password);
      setSessionCookie(res, s.token, s.expires);
      const nxt = typeof req.body?.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/';
      res.redirect(303, nxt);
    } catch (e) {
      if (e instanceof AppError && e.code === 'UNAUTHENTICATED') return res.status(401).type('html').send(loginPage(req, e.message));
      next(e);
    }
  });
  r.post('/logout', (req, res) => {
    logout(db, req.sessionToken);
    res.clearCookie(SESSION_COOKIE);
    res.redirect(303, '/login');
  });
  registerDashboard(r, db);
  registerOwnerOperatorPages(r, db, storage);
  registerJobPages(r, db, storage);
  registerMiscPages(r, db, storage);
  return r;
}
