import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { wrap } from '../lib/errors.js';

const r = Router();

r.get('/', wrap(async (req, res) => {
  const unreadOnly = req.query.unread === '1';
  const [rows] = await pool.query(
    `SELECT n.id, n.lead_id, n.created_at, n.read_at, l.lead_code, l.phone, et.label AS enquiry
     FROM notifications n JOIN leads l ON l.id = n.lead_id LEFT JOIN selectable_values et ON et.id = l.enquiry_type_id
     WHERE n.user_id = ? ${unreadOnly ? 'AND n.read_at IS NULL' : ''} ORDER BY n.id DESC LIMIT 50`, [req.user.id]);
  ok(res, rows);
}));

const readSchema = z.object({
  ids: z.array(z.number().int().positive()).max(200).optional(),
  lead_id: z.number().int().positive().optional(),
  all: z.boolean().optional(),
}).refine((v) => v.ids || v.lead_id || v.all, 'Specify ids, lead_id or all');

r.post('/read', wrap(async (req, res) => {
  const d = parse(readSchema, req.body);
  let sql = 'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL';
  const params = [new Date(), req.user.id];
  if (!d.all) {
    if (d.ids?.length) { sql += ' AND id IN (?)'; params.push(d.ids); }
    if (d.lead_id) { sql += ' AND lead_id = ?'; params.push(d.lead_id); }
  }
  const [r2] = await pool.query(sql, params);
  ok(res, { updated: r2.affectedRows });
}));
export default r;
