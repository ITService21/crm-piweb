import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { wrap } from '../lib/errors.js';

export async function getPreferences(userId) {
  const [[p]] = await pool.query('SELECT sound_enabled, browser_notifications FROM user_preferences WHERE user_id = ?', [userId]);
  return { sound_enabled: p ? !!p.sound_enabled : true, browser_notifications: p ? !!p.browser_notifications : false };
}

const schema = z.object({ sound_enabled: z.boolean().optional(), browser_notifications: z.boolean().optional() }).strict();
const r = Router();
r.get('/', wrap(async (req, res) => ok(res, await getPreferences(req.user.id))));
r.put('/', wrap(async (req, res) => {
  const d = parse(schema, req.body);
  const cur = await getPreferences(req.user.id);
  const next = { ...cur, ...d };
  await pool.query(
    `INSERT INTO user_preferences (user_id, sound_enabled, browser_notifications, updated_at) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE sound_enabled=VALUES(sound_enabled), browser_notifications=VALUES(browser_notifications), updated_at=VALUES(updated_at)`,
    [req.user.id, next.sound_enabled ? 1 : 0, next.browser_notifications ? 1 : 0, new Date()]);
  ok(res, next);
}));
export default r;
