import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { config } from './config.js';
import { migrate } from './migrate.js';

const DEFAULTS = [
  // [category, key, label, colour, status_category, is_new_state]
  ['lead_status', 'new', 'New', '#2563eb', 'active', 1],
  ['lead_status', 'call_not_received', 'Call Not Received', '#d97706', 'active', 0],
  ['lead_status', 'in_progress', 'In Progress', '#7c3aed', 'active', 0],
  ['lead_status', 'followup_required', 'Follow-up Required', '#0891b2', 'active', 0],
  ['lead_status', 'not_interested', 'Not Interested', '#6b7280', 'not_interested', 0],
  ['lead_status', 'converted', 'Converted', '#16a34a', 'converted', 0],
  ['lead_status', 'few_days_later', 'Few Days Later', '#0ea5e9', 'active', 0],
  ['lead_status', 'least_interested', 'Least Interested', '#94a3b8', 'active', 0],
  ['remark_tag', 'call_not_picked', 'Call not picked', '#ef4444'],
  ['remark_tag', 'busy', 'Busy', '#f59e0b'],
  ['remark_tag', 'callback_requested', 'Callback requested', '#0ea5e9'],
  ['remark_tag', 'details_sent', 'Details sent', '#6366f1'],
  ['remark_tag', 'interested', 'Interested', '#16a34a'],
  ['remark_tag', 'wrong_number', 'Wrong number', '#64748b'],
  ['remark_tag', 'switched_off', 'Switched off', '#a855f7'],
  ['enquiry_type', 'website_development', 'Website Development Enquiry', '#2563eb'],
  ['enquiry_type', 'ecommerce', 'E-commerce Enquiry', '#7c3aed'],
  ['enquiry_type', 'redesign', 'Website Redesign', '#0891b2'],
  ['enquiry_type', 'seo_maintenance', 'SEO / Maintenance', '#d97706'],
  ['enquiry_type', 'general', 'General Enquiry', '#6b7280'],
  ['special_markup', 'normal', 'Normal', '#9ca3af'],
  ['special_markup', 'special_attention', 'Special Attention', '#dc2626'],
  ['special_markup', 'high_priority', 'High Priority', '#ea580c'],
  ['special_markup', 'less_attention', 'Less Attention', '#64748b'],
  ['lead_source', 'website', 'Website Form', '#2563eb'],
  ['lead_source', 'manual', 'Added in CRM', '#6b7280'],
  ['lead_source', 'referral', 'Referral', '#16a34a'],
  ['lead_source', 'api', 'API / Integration', '#7c3aed'],
];

/** Idempotent: only inserts missing (category,key) pairs, never overwrites admin edits. */
export async function seedDefaults() {
  const now = new Date();
  const counters = {};
  for (const [category, key, label, colour, statusCat = null, isNew = 0] of DEFAULTS) {
    counters[category] = (counters[category] || 0) + 10;
    await pool.query(
      `INSERT IGNORE INTO selectable_values (category,value_key,label,colour,status_category,is_new_state,sort_order,is_active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)`,
      [category, key, label, colour, statusCat, isNew, counters[category], now, now]);
  }
}

export async function createUser({ name, email, password, role = 'agent' }) {
  const now = new Date();
  const hash = await bcrypt.hash(password, 12);
  const [r] = await pool.query(
    'INSERT INTO users (name,email,password_hash,role,is_active,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    [name, email.toLowerCase(), hash, role, now, now]);
  await pool.query('INSERT INTO user_preferences (user_id, sound_enabled, browser_notifications, updated_at) VALUES (?,1,0,?)', [r.insertId, now]);
  return r.insertId;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    await migrate();
    await seedDefaults();
    const email = process.env.SEED_ADMIN_EMAIL;
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (email && password) {
      const min = config.isProd ? 10 : 8; // production keeps the stricter rule
      if (password.length < min) throw new Error(`SEED_ADMIN_PASSWORD must be at least ${min} characters`);
      const [[u]] = await pool.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
      if (!u) { await createUser({ name: 'Administrator', email, password, role: 'admin' }); console.log(`admin ${email} created`); }
      else console.log('admin already exists; left unchanged');
    }
    console.log(`defaults seeded (db: ${config.db.database})`);
    await pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
