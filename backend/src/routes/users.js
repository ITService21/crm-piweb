import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db.js';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import { createUser } from '../seed.js';

const r = Router();
const id = (req) => parse(z.coerce.number().int().positive(), req.params.id);
const password = z.string().min(10, 'Use at least 10 characters').max(200);

// Agents get a minimal directory (for the assignment dropdown); admins get full detail.
r.get('/', wrap(async (req, res) => {
  if (req.user.role !== 'admin') {
    const [rows] = await pool.query('SELECT id, name FROM users WHERE is_active = 1 ORDER BY name');
    return ok(res, rows);
  }
  const [rows] = await pool.query('SELECT id, name, email, role, is_active, last_login_at, created_at FROM users ORDER BY name');
  ok(res, rows.map((u) => ({ ...u, is_active: !!u.is_active })));
}));

r.post('/', requireAdmin, wrap(async (req, res) => {
  const d = parse(z.object({
    name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email().max(190),
    password, role: z.enum(['admin', 'agent']).default('agent'),
  }), req.body);
  try {
    const newId = await createUser(d);
    ok(res, { id: newId, name: d.name, email: d.email, role: d.role, is_active: true }, undefined, 201);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict('A user with this email already exists');
    throw e;
  }
}));

r.patch('/:id', requireAdmin, wrap(async (req, res) => {
  const uid = id(req);
  const d = parse(z.object({
    name: z.string().trim().min(1).max(120).optional(), role: z.enum(['admin', 'agent']).optional(),
    is_active: z.boolean().optional(), password: password.optional(),
  }).strict(), req.body);
  const [[cur]] = await pool.query('SELECT * FROM users WHERE id = ?', [uid]);
  if (!cur) throw notFound('User not found');
  const demoting = (d.role && d.role !== 'admin') || d.is_active === false;
  if (cur.role === 'admin' && demoting) {
    const [[n]] = await pool.query(`SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1 AND id <> ?`, [uid]);
    if (n.n === 0) throw badRequest('There must be at least one active administrator');
  }
  const next = {
    name: d.name ?? cur.name, role: d.role ?? cur.role, is_active: d.is_active === undefined ? cur.is_active : d.is_active ? 1 : 0,
    password_hash: d.password ? await bcrypt.hash(d.password, 12) : cur.password_hash,
  };
  await pool.query('UPDATE users SET name=?, role=?, is_active=?, password_hash=?, updated_at=? WHERE id=?',
    [next.name, next.role, next.is_active, next.password_hash, new Date(), uid]);
  ok(res, { id: uid, name: next.name, email: cur.email, role: next.role, is_active: !!next.is_active });
}));
export default r;
