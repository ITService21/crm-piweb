import { pool } from '../db.js';
import { addDaysStr, dayBounds, dayStartUtc, nextDayStartUtc, isValidDateStr } from '../lib/time.js';
import { badRequest } from '../lib/errors.js';

export const TABS = ['leads', 'not_interested', 'converted', 'scheduled', 'removed'];
const TAB_CATEGORY = { leads: 'active', scheduled: 'active', not_interested: 'not_interested', converted: 'converted' };

export const LEAD_SELECT = `
  l.*,
  st.label AS status_label, st.colour AS status_colour, st.status_category, st.is_new_state,
  et.label AS enquiry_label, src.label AS source_label,
  mk.label AS markup_label, mk.colour AS markup_colour, mk.value_key AS markup_key,
  au.name AS assigned_name, cu.name AS created_by_name, lau.name AS last_action_by_name, lru.name AS last_remark_by_name, rmu.name AS removed_by_name, alu.name AS allocated_to_name, alb.name AS allocated_by_name`;
export const LEAD_JOINS = `
  FROM leads l
  JOIN selectable_values st ON st.id = l.status_id
  LEFT JOIN selectable_values et ON et.id = l.enquiry_type_id
  LEFT JOIN selectable_values src ON src.id = l.source_id
  LEFT JOIN selectable_values mk ON mk.id = l.special_markup_id
  LEFT JOIN users au ON au.id = l.assigned_to
  LEFT JOIN users cu ON cu.id = l.created_by
  LEFT JOIN users lau ON lau.id = l.last_action_by
  LEFT JOIN users lru ON lru.id = l.last_remark_by
  LEFT JOIN users rmu ON rmu.id = l.removed_by
  LEFT JOIN users alu ON alu.id = l.allocated_to
  LEFT JOIN users alb ON alb.id = l.allocated_by`;

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Row-level access: admins see everything; agents see leads assigned to them, unassigned, or allocated to them. */
export function accessClause(user, alias = 'l') {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  return { sql: `(${alias}.assigned_to = ? OR ${alias}.assigned_to IS NULL OR ${alias}.allocated_to = ?)`, params: [user.id, user.id] };
}

function rangeFromTo(filters, field) {
  const { from, to } = filters;
  if (from && !isValidDateStr(from)) throw badRequest('Invalid "from" date');
  if (to && !isValidDateStr(to)) throw badRequest('Invalid "to" date');
  const parts = []; const params = [];
  if (from) { parts.push(`${field} >= ?`); params.push(dayStartUtc(from)); }
  if (to) { parts.push(`${field} < ?`); params.push(nextDayStartUtc(to)); }
  return { parts, params };
}

/**
 * Builds the WHERE clause. `includeStatus=false` is used for the per-status
 * counts so they reflect every *other* active filter.
 */
export function buildWhere(user, f, now, { includeStatus = true, includeMarkup = true } = {}) {
  if (!TABS.includes(f.tab)) throw badRequest('Unknown tab');
  const b = dayBounds(now);
  const where = []; const params = [];
  const acc = accessClause(user);
  where.push(acc.sql); params.push(...acc.params);

  if (f.tab === 'removed') {
    where.push('l.removed_at IS NOT NULL'); // removed leads live only here...
  } else {
    where.push('l.removed_at IS NULL'); // ...and are excluded from every other tab, count and badge
    where.push('st.status_category = ?'); params.push(TAB_CATEGORY[f.tab]);
  }

  if (f.tab === 'leads') {
    // follow-ups on future calendar days live in the Follow-up Scheduled tab
    where.push('(st.is_new_state = 1 OR l.next_followup_at IS NULL OR l.next_followup_at < ? OR l.allocated_to = ?)'); params.push(b.tomorrowStart, user.id);
  } else if (f.tab === 'scheduled') {
    where.push('st.is_new_state = 0 AND l.next_followup_at >= ? AND (l.allocated_to IS NULL OR l.allocated_to <> ?)'); params.push(b.tomorrowStart, user.id);
  }

  const df = f.dateFilter || (f.tab === 'scheduled' ? 'all' : 'all');
  if (f.tab === 'leads') {
    if (df === 'new') {
      // "New Leads" = created in the range AND still in the New state (worked-on leads drop out)
      const r = rangeFromTo({ from: f.from || b.today, to: f.to || b.today }, 'l.created_at');
      where.push('st.is_new_state = 1', ...r.parts); params.push(...r.params);
    } else if (df === 'today_leads') { // leads created today (business timezone), any status
      where.push('l.created_at >= ? AND l.created_at < ?'); params.push(b.todayStart, b.tomorrowStart);
    } else if (df === 'yesterday_leads') {
      where.push('l.created_at >= ? AND l.created_at < ?'); params.push(dayStartUtc(addDaysStr(b.today, -1)), b.todayStart);
    } else if (df === 'last7_leads') { // today + the previous 6 calendar days
      where.push('l.created_at >= ? AND l.created_at < ?'); params.push(dayStartUtc(addDaysStr(b.today, -6)), b.tomorrowStart);
    } else if (df === 'today') {
      where.push('l.next_followup_at >= ? AND l.next_followup_at < ?'); params.push(b.todayStart, b.tomorrowStart);
    } else if (df === 'overdue') {
      where.push('l.next_followup_at IS NOT NULL AND l.next_followup_at < ?'); params.push(now);
    } else if (df === 'custom') {
      if (!f.from && !f.to) throw badRequest('Custom range needs a start or end date');
      const r = rangeFromTo(f, f.dateField === 'followup' ? 'l.next_followup_at' : 'l.created_at');
      where.push(...r.parts); params.push(...r.params);
    } else if (df !== 'all') throw badRequest('Unknown date filter');
  } else if (f.tab === 'scheduled') {
    const startOf = (n) => dayStartUtc(addDaysStr(b.today, n));
    if (df === 'tomorrow') { where.push('l.next_followup_at < ?'); params.push(startOf(2)); }
    else if (df === 'next7') { where.push('l.next_followup_at < ?'); params.push(startOf(8)); }
    else if (df === 'next30') { where.push('l.next_followup_at < ?'); params.push(startOf(31)); }
    else if (df === 'custom') {
      if (!f.from && !f.to) throw badRequest('Custom range needs a start or end date');
      const r = rangeFromTo(f, 'l.next_followup_at');
      where.push(...r.parts); params.push(...r.params);
    } else if (df !== 'all') throw badRequest('Unknown date filter');
  }

  if (f.q) {
    const like = `%${escapeLike(f.q.trim())}%`;
    where.push(`(l.lead_code LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.nickname LIKE ? OR l.business_name LIKE ? OR l.last_remark_text LIKE ? OR l.message LIKE ?)`);
    params.push(like, like, like, like, like, like, like);
  }

  if (f.assigned === 'me') { where.push('l.assigned_to = ?'); params.push(user.id); }
  else if (f.assigned === 'unassigned') where.push('l.assigned_to IS NULL');
  else if (f.assigned && f.assigned !== 'all') {
    const id = Number(f.assigned);
    if (!Number.isInteger(id)) throw badRequest('Invalid assignee filter');
    where.push('l.assigned_to = ?'); params.push(id);
  }

  if (includeStatus && f.statusId) { where.push('l.status_id = ?'); params.push(f.statusId); }
  if (includeMarkup && f.markupId) { where.push('l.special_markup_id = ?'); params.push(f.markupId); }
  return { where: where.join(' AND '), params, bounds: b };
}

const SORTABLE = { created_at: 'l.created_at', next_followup_at: 'l.next_followup_at', last_action_at: 'l.last_action_at', nickname: 'l.nickname', status: 'st.label' };

/**
 * Default order for the Leads tab (one query, one ordering, so pagination is stable):
 *   1. new leads, newest first
 *   2. today's follow-ups: overdue first (oldest first), then upcoming (nearest first)
 *   3. everything else by next follow-up (NULLs last), then newest
 * A lead falls into exactly one group because the group is a single CASE.
 */
function orderBy(f, bounds, now, user) {
  if (f.sort) {
    const col = SORTABLE[f.sort];
    if (!col) throw badRequest('Unknown sort column');
    const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
    const nullsLast = f.sort === 'next_followup_at' ? `${col} IS NULL, ` : '';
    return { sql: `${nullsLast}${col} ${dir}, l.id DESC`, params: [] };
  }
  // Leads allocated to the viewer always come first (newest allocation first), above every other rule.
  const mine = { sql: 'CASE WHEN l.allocated_to = ? THEN 0 ELSE 1 END, CASE WHEN l.allocated_to = ? THEN l.allocated_at END DESC,', params: [user.id, user.id] };
  if (f.tab === 'leads') {
    const grp = `CASE WHEN st.is_new_state = 1 THEN 1 WHEN l.next_followup_at >= ? AND l.next_followup_at < ? THEN 2 ELSE 3 END`;
    return {
      sql: `${mine.sql} ${grp},
        CASE WHEN st.is_new_state = 1 THEN l.created_at END DESC,
        CASE WHEN st.is_new_state = 0 AND l.next_followup_at >= ? AND l.next_followup_at < ? THEN (l.next_followup_at >= ?) END ASC,
        CASE WHEN st.is_new_state = 0 AND l.next_followup_at >= ? AND l.next_followup_at < ? THEN l.next_followup_at END ASC,
        (l.next_followup_at IS NULL) ASC, l.next_followup_at ASC, l.created_at DESC, l.id DESC`,
      params: [...mine.params, bounds.todayStart, bounds.tomorrowStart, bounds.todayStart, bounds.tomorrowStart, now, bounds.todayStart, bounds.tomorrowStart],
    };
  }
  if (f.tab === 'scheduled') return { sql: `${mine.sql} l.next_followup_at ASC, l.id ASC`, params: mine.params };
  if (f.tab === 'removed') return { sql: 'l.removed_at DESC, l.id DESC', params: [] };
  return { sql: `${mine.sql} l.last_action_at DESC, l.id DESC`, params: mine.params };
}

export function priorityReason(row, bounds, now) {
  if (row.status_category !== 'active' || row.removed_at) return null;
  if (row.is_new_state) return 'new';
  const f = row.next_followup_at ? new Date(row.next_followup_at) : null;
  if (!f) return null;
  if (f < now) return 'overdue';
  if (f >= bounds.todayStart && f < bounds.tomorrowStart) return 'followup_today';
  return null;
}

export function toLeadDto(r, bounds, now, tagMap = new Map()) {
  return {
    id: r.id, lead_code: r.lead_code, created_at: r.created_at,
    status: { id: r.status_id, label: r.status_label, colour: r.status_colour, category: r.status_category, is_new_state: !!r.is_new_state },
    enquiry_type: r.enquiry_type_id ? { id: r.enquiry_type_id, label: r.enquiry_label } : null,
    source: r.source_id ? { id: r.source_id, label: r.source_label } : null,
    special_markup: r.special_markup_id ? { id: r.special_markup_id, label: r.markup_label, colour: r.markup_colour, key: r.markup_key } : null,
    email: r.email, phone: r.phone, nickname: r.nickname, business_name: r.business_name, requirement: r.requirement, budget: r.budget, message: r.message,
    next_followup_at: r.next_followup_at,
    last_action_by: r.last_action_by ? { id: r.last_action_by, name: r.last_action_by_name } : null,
    last_action_at: r.last_action_at,
    assigned_to: r.assigned_to ? { id: r.assigned_to, name: r.assigned_name } : null,
    created_by: r.created_by ? { id: r.created_by, name: r.created_by_name } : null,
    last_remark: r.last_remark_at ? { text: r.last_remark_text || '', by: r.last_remark_by_name, at: r.last_remark_at, tags: tagMap.get(r.last_remark_id) ?? [] } : null,
    remarks_count: r.remarks_count,
    updated_at: r.updated_at,
    allocated: r.allocated_to ? { to: { id: r.allocated_to, name: r.allocated_to_name }, by: r.allocated_by ? { id: r.allocated_by, name: r.allocated_by_name } : null, at: r.allocated_at } : null,
    removed: r.removed_at ? { at: r.removed_at, by: r.removed_by_name, reason: r.removed_reason } : null,
    priority_reason: priorityReason(r, bounds, now),
  };
}

export async function listLeads(user, f, now = new Date()) {
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 25));
  const w = buildWhere(user, f, now);
  const ord = orderBy(f, w.bounds, now, user);

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${LEAD_JOINS} WHERE ${w.where}`, w.params);
  const [rows] = await pool.query(
    `SELECT ${LEAD_SELECT} ${LEAD_JOINS} WHERE ${w.where} ORDER BY ${ord.sql} LIMIT ? OFFSET ?`,
    [...w.params, ...ord.params, pageSize, (page - 1) * pageSize]);
  const tagMap = await tagsForRemarks(rows.map((r) => r.last_remark_id));
  return {
    items: rows.map((r) => toLeadDto(r, w.bounds, now, tagMap)),
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

/** Per-status counts for the filter bar, honouring every filter except the status itself. */
export async function countByStatus(user, f, now = new Date()) {
  const w = buildWhere(user, f, now, { includeStatus: false });
  const [rows] = await pool.query(`SELECT l.status_id AS id, COUNT(*) AS n ${LEAD_JOINS} WHERE ${w.where} GROUP BY l.status_id`, w.params);
  const byStatus = {}; let all = 0;
  for (const r of rows) { byStatus[r.id] = r.n; all += r.n; }
  // priority-markup counts honour every filter except the markup itself (incl. the selected status)
  const m = buildWhere(user, f, now, { includeMarkup: false });
  const [mrows] = await pool.query(`SELECT l.special_markup_id AS id, COUNT(*) AS n ${LEAD_JOINS} WHERE ${m.where} GROUP BY l.special_markup_id`, m.params);
  const byMarkup = {}; let markupAll = 0;
  for (const r of mrows) { byMarkup[r.id ?? 0] = r.n; markupAll += r.n; }
  return { all, byStatus, byMarkup, markupAll };
}

/** Sidebar badges: unread new-lead notifications, overdue follow-ups, and tab totals. */
export async function sidebarSummary(user, now = new Date()) {
  const acc = accessClause(user);
  const b = dayBounds(now);
  const [[over]] = await pool.query(
    `SELECT COUNT(*) AS n ${LEAD_JOINS} WHERE ${acc.sql} AND l.removed_at IS NULL AND st.status_category='active' AND l.next_followup_at IS NOT NULL AND l.next_followup_at < ?`,
    [...acc.params, now]);
  const [[unread]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [user.id]);
  const [[sched]] = await pool.query(
    `SELECT COUNT(*) AS n ${LEAD_JOINS} WHERE ${acc.sql} AND l.removed_at IS NULL AND st.status_category='active' AND st.is_new_state=0 AND l.next_followup_at >= ?`,
    [...acc.params, b.tomorrowStart]);
  const [[rem]] = await pool.query(`SELECT COUNT(*) AS n ${LEAD_JOINS} WHERE ${acc.sql} AND l.removed_at IS NOT NULL`, acc.params);
  // invoices whose promised payment date has arrived and still have a balance
  const [[pay]] = await pool.query(
    `SELECT COUNT(*) AS n FROM billing_documents d JOIN leads l ON l.id = d.lead_id WHERE ${acc.sql} AND d.doc_type = 'invoice' AND d.status IN ('issued','partially_paid')
       AND d.next_payment_due IS NOT NULL AND d.next_payment_due <= ? AND d.total > d.amount_paid`, [...acc.params, b.today]);
  return { unread_new_leads: unread.n, overdue_followups: over.n, scheduled_followups: sched.n, removed: rem.n, payment_followups: pay.n };
}

const DATE_KEYS = { leads: ['all', 'today_leads', 'yesterday_leads', 'last7_leads', 'new', 'today', 'overdue', 'custom'], scheduled: ['tomorrow', 'next7', 'next30', 'custom', 'all'] };

/** Count per date-filter button, honouring search / agent / status but not the date filter itself. */
export async function countByDateFilter(user, f, now = new Date()) {
  const out = {};
  for (const key of DATE_KEYS[f.tab] || []) {
    const g = { ...f, dateFilter: key, from: undefined, to: undefined, dateField: undefined };
    if (key === 'new' && f.dateFilter === 'new') { g.from = f.from; g.to = f.to; }
    if (key === 'custom') {
      if (f.dateFilter !== 'custom' || (!f.from && !f.to)) { out[key] = null; continue; }
      g.from = f.from; g.to = f.to; g.dateField = f.dateField;
    }
    const w = buildWhere(user, g, now);
    const [[r]] = await pool.query(`SELECT COUNT(*) AS n ${LEAD_JOINS} WHERE ${w.where}`, w.params);
    out[key] = r.n;
  }
  return out;
}

/** Ids of every lead matching the filters (all pages) — powers "Select all" for bulk actions. Capped for safety. */
export const ID_CAP = 1000;
export async function listLeadIds(user, f, now = new Date()) {
  const w = buildWhere(user, f, now);
  const [rows] = await pool.query(`SELECT l.id ${LEAD_JOINS} WHERE ${w.where} ORDER BY l.id DESC LIMIT ?`, [...w.params, ID_CAP + 1]);
  return { ids: rows.slice(0, ID_CAP).map((r) => r.id), capped: rows.length > ID_CAP };
}

/** Tags for a set of remark ids -> Map(remarkId -> [{id,label,colour}]) */
export async function tagsForRemarks(remarkIds, conn = pool) {
  const ids = [...new Set(remarkIds.filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const [rows] = await conn.query(
    `SELECT rt.remark_id, t.id, t.label, t.colour FROM lead_remark_tags rt JOIN selectable_values t ON t.id = rt.tag_id
     WHERE rt.remark_id IN (?) ORDER BY t.sort_order, t.id`, [ids]);
  for (const r of rows) { if (!map.has(r.remark_id)) map.set(r.remark_id, []); map.get(r.remark_id).push({ id: r.id, label: r.label, colour: r.colour }); }
  return map;
}

