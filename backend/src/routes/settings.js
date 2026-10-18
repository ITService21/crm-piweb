import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { wrap } from '../lib/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import * as sv from '../services/selectable.js';

const r = Router();

// Any signed-in user may read ACTIVE values (dropdowns); the full list incl. inactive is admin-only.
r.get('/values', wrap(async (req, res) => {
  const includeInactive = req.query.include_inactive === '1';
  if (includeInactive && req.user.role !== 'admin') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Administrator access required' } });
  const rows = await sv.list({ category: req.query.category, includeInactive });
  if (includeInactive) {
    for (const row of rows) row.usage_count = await sv.usageCount(row);
  }
  ok(res, rows);
}));
r.get('/categories', wrap(async (_req, res) => ok(res, await sv.listCategories())));

r.post('/values', requireAdmin, wrap(async (req, res) => ok(res, await sv.create(req.body), undefined, 201)));
r.patch('/values/:id', requireAdmin, wrap(async (req, res) => ok(res, await sv.update(parse(z.coerce.number().int().positive(), req.params.id), req.body))));
r.delete('/values/:id', requireAdmin, wrap(async (req, res) => {
  await sv.remove(parse(z.coerce.number().int().positive(), req.params.id));
  ok(res, { deleted: true });
}));
r.post('/values/:id/migrate', requireAdmin, wrap(async (req, res) => {
  const { to_id } = parse(z.object({ to_id: z.number().int().positive() }), req.body);
  ok(res, await sv.migrateLeads(parse(z.coerce.number().int().positive(), req.params.id), to_id, req.user.id));
}));
export default r;
