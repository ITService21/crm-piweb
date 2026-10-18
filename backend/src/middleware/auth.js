import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db.js';
import { forbidden, unauthorized, wrap } from '../lib/errors.js';

export const COOKIE_NAME = 'piweb_crm_session';

export function signSession(user) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
}

export function setSessionCookie(res, user) {
  res.cookie(COOKIE_NAME, signSession(user), {
    httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: config.sessionHours * 3600 * 1000, path: '/',
  });
}
export const clearSessionCookie = (res) => res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });

export const requireAuth = wrap(async (req, _res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) throw unauthorized();
  let sub;
  try { ({ sub } = jwt.verify(token, config.jwtSecret)); } catch { throw unauthorized('Session expired'); }
  const [[u]] = await pool.query('SELECT id, name, email, role, is_active FROM users WHERE id = ?', [sub]);
  if (!u || !u.is_active) throw unauthorized('Account disabled');
  req.user = { id: u.id, name: u.name, email: u.email, role: u.role };
  next();
});

export const requireAdmin = (req, _res, next) => (req.user?.role === 'admin' ? next() : next(forbidden('Administrator access required')));

/**
 * CSRF defence for cookie auth: SameSite=Lax cookie + a custom header that
 * cross-site forms cannot send and cross-origin fetches need a CORS preflight for.
 */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') === 'piweb-crm') return next();
  return next(forbidden('Missing CSRF header'));
}

export const permissionsFor = (role) => (role === 'admin'
  ? ['leads:read', 'leads:write', 'leads:assign_any', 'settings:manage', 'users:manage']
  : ['leads:read', 'leads:write']);
