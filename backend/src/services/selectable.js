import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

export const STATUS_CATEGORIES = ['active', 'not_interested', 'converted'];
export const CATEGORY_LEAD_COLUMN = {
  lead_status: 'status_id',
  enquiry_type: 'enquiry_type_id',
  special_markup: 'special_markup_id',
  lead_source: 'source_id',
};
export const BUILTIN_CATEGORIES = Object.keys(CATEGORY_LEAD_COLUMN);

const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB colour').nullable().optional();
const slug = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,63}$/, 'Use lowercase letters, digits and underscores');

const createSchema = z.object({
  category: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,49}$/),
  value_key: slug.optional(),
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().max(255).nullable().optional(),
  colour,
  status_category: z.enum(STATUS_CATEGORIES).nullable().optional(),
  is_new_state: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
  is_active: z.boolean().optional(),
});
const updateSchema = createSchema.omit({ category: true, value_key: true }).partial();

const toKey = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'value';

function validateStatusRules(category, row) {
  if (category === 'lead_status') {
    if (!row.status_category) throw badRequest('A lead status needs a section (status_category)');
    if (row.is_new_state && row.status_category !== 'active') throw badRequest('Only an Active status can be the "New" state');
  } else if (row.status_category || row.is_new_state) {
    throw badRequest('status_category / is_new_state only apply to lead statuses');
  }
}

const shape = (r) => ({ ...r, is_active: !!r.is_active, is_new_state: !!r.is_new_state });

export async function list({ category, includeInactive = false } = {}) {
  const params = [];
  let sql = 'SELECT * FROM selectable_values WHERE 1=1';
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (!includeInactive) sql += ' AND is_active = 1';
  sql += ' ORDER BY category, sort_order, id';
  const [rows] = await pool.query(sql, params);
  return rows.map(shape);
}

export async function listCategories() {
  const [rows] = await pool.query('SELECT DISTINCT category FROM selectable_values');
  const set = new Set([...BUILTIN_CATEGORIES, ...rows.map((r) => r.category)]);
  return [...set];
}

export async function get(id, conn = pool) {
  const [[row]] = await conn.query('SELECT * FROM selectable_values WHERE id = ?', [id]);
  return row ? shape(row) : null;
}

/** Returns the value if it exists, is active and belongs to `category`; throws otherwise. */
export async function requireAssignable(conn, id, category) {
  const v = await get(id, conn);
  if (!v || v.category !== category) throw badRequest(`Invalid ${category.replace('_', ' ')}`);
  if (!v.is_active) throw badRequest(`"${v.label}" is inactive and cannot be assigned`);
  return v;
}

export async function usageCount(row) {
  const col = CATEGORY_LEAD_COLUMN[row.category];
  if (!col) return 0;
  const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM leads WHERE ${col} = ?`, [row.id]);
  return r.n;
}

export async function create(input) {
  const d = parse(createSchema, input);
  const row = {
    category: d.category,
    value_key: d.value_key || toKey(d.label),
    label: d.label,
    description: d.description ?? null,
    colour: d.colour ?? null,
    status_category: d.category === 'lead_status' ? d.status_category ?? null : null,
    is_new_state: d.category === 'lead_status' && d.is_new_state ? 1 : 0,
    sort_order: d.sort_order ?? 0,
    is_active: d.is_active === false ? 0 : 1,
  };
  validateStatusRules(row.category, row);
  const now = new Date();
  try {
    return await withTx(async (conn) => {
      if (row.is_new_state) await conn.query('UPDATE selectable_values SET is_new_state = 0, updated_at = ? WHERE category = ?', [now, 'lead_status']);
      if (!d.sort_order) {
        const [[m]] = await conn.query('SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM selectable_values WHERE category = ?', [row.category]);
        row.sort_order = m.n;
      }
      const [r] = await conn.query(
        `INSERT INTO selectable_values (category,value_key,label,description,colour,status_category,is_new_state,sort_order,is_active,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [row.category, row.value_key, row.label, row.description, row.colour, row.status_category, row.is_new_state, row.sort_order, row.is_active, now, now]);
      return get(r.insertId, conn);
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict(`A value with key "${row.value_key}" already exists in this category`);
    throw e;
  }
}

export async function update(id, input) {
  const d = parse(updateSchema, input);
  return withTx(async (conn) => {
    const [[cur]] = await conn.query('SELECT * FROM selectable_values WHERE id = ? FOR UPDATE', [id]);
    if (!cur) throw notFound('Value not found');
    const next = { ...cur };
    for (const k of Object.keys(d)) if (d[k] !== undefined) next[k] = typeof d[k] === 'boolean' ? (d[k] ? 1 : 0) : d[k];
    if (cur.category === 'lead_status' && cur.status_category !== next.status_category) {
      const n = await usageCount(cur);
      if (n > 0 && !input.confirm_section_change) {
        throw conflict(`${n} lead(s) use this status. Changing its section moves them between tabs; resend with confirm_section_change=true to proceed.`, { leads: n });
      }
    }
    validateStatusRules(cur.category, next);
    const now = new Date();
    if (cur.category === 'lead_status' && next.is_new_state && !cur.is_new_state) {
      await conn.query('UPDATE selectable_values SET is_new_state = 0, updated_at = ? WHERE category = ?', [now, 'lead_status']);
    }
    await conn.query(
      `UPDATE selectable_values SET label=?, description=?, colour=?, status_category=?, is_new_state=?, sort_order=?, is_active=?, updated_at=? WHERE id=?`,
      [next.label, next.description, next.colour, next.status_category, next.is_new_state, next.sort_order, next.is_active, now, id]);
    return get(id, conn);
  });
}

/** Hard delete only when unused; otherwise tell the caller to deactivate or migrate. */
export async function remove(id) {
  const row = await get(id);
  if (!row) throw notFound('Value not found');
  const n = await usageCount(row);
  if (n > 0) throw conflict(`"${row.label}" is used by ${n} lead(s). Deactivate it, or migrate those leads to another value first.`, { leads: n, action: 'deactivate_or_migrate' });
  await pool.query('DELETE FROM selectable_values WHERE id = ?', [id]);
}

/** Reassign every lead from one value to another in the same category. Each lead gets an activity record. */
export async function migrateLeads(fromId, toId, actorId) {
  if (fromId === toId) throw badRequest('Choose a different target value');
  return withTx(async (conn) => {
    const from = await get(fromId, conn);
    const to = await get(toId, conn);
    if (!from || !to) throw notFound('Value not found');
    if (from.category !== to.category) throw badRequest('Values must be in the same category');
    if (!to.is_active) throw badRequest('Target value is inactive');
    const col = CATEGORY_LEAD_COLUMN[from.category];
    if (!col) return { moved: 0 };
    const now = new Date();
    const [ids] = await conn.query(`SELECT id FROM leads WHERE ${col} = ? FOR UPDATE`, [fromId]);
    if (!ids.length) return { moved: 0 };
    const leadIds = ids.map((r) => r.id);
    await conn.query(`UPDATE leads SET ${col} = ?, updated_at = ?, updated_by = ? WHERE ${col} = ?`, [toId, now, actorId, fromId]);
    const type = col === 'status_id' ? 'status_changed' : col === 'special_markup_id' ? 'markup_changed' : 'field_updated';
    const rows = leadIds.map((id) => [id, actorId, type,
      `${from.category.replace('_', ' ')} migrated: ${from.label} → ${to.label}`,
      JSON.stringify({ [col]: from.label }), JSON.stringify({ [col]: to.label }), now]);
    await conn.query('INSERT INTO lead_activities (lead_id,actor_user_id,action_type,summary,before_data,after_data,created_at) VALUES ?', [rows]);
    return { moved: leadIds.length };
  });
}

export async function statusMap() {
  const rows = await list({ category: 'lead_status', includeInactive: true });
  return new Map(rows.map((r) => [r.id, r]));
}
