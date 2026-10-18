import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { unauthorized, wrap } from '../lib/errors.js';
import { clearSessionCookie, permissionsFor, requireAuth, setSessionCookie } from '../middleware/auth.js';
import { getPreferences } from './preferences.js';

const r = Router();
// Throttle per IP+email so one attacker cannot lock out everybody, and one email cannot be hammered from many IPs cheaply.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').toLowerCase()}`,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again in 15 minutes.' } },
});
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });

r.post('/login', loginLimiter, wrap(async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const [[u]] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const good = await bcrypt.compare(password, u?.password_hash || DUMMY_HASH);
  if (!u || !good || !u.is_active) throw unauthorized('Invalid email or password');
  await pool.query('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date(), u.id]);
  setSessionCookie(res, u);
  ok(res, { id: u.id, name: u.name, email: u.email, role: u.role, permissions: permissionsFor(u.role) });
}));

r.post('/logout', (_req, res) => { clearSessionCookie(res); ok(res, { loggedOut: true }); });

r.get('/me', requireAuth, wrap(async (req, res) => {
  ok(res, { ...req.user, permissions: permissionsFor(req.user.role), preferences: await getPreferences(req.user.id), timezone: (await import('../config.js')).config.tz });
}));

export default r;
