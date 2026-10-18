import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { pool, withTx, parseJson } from '../db.js';
import { config } from '../config.js';
import { parse } from '../lib/validate.js';
import { normalizePhone } from '../lib/phone.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { requireAssignable, get as getValue } from './selectable.js';
import { LEAD_SELECT, LEAD_JOINS, accessClause, toLeadDto } from './leadQuery.js';
import { dayBounds } from '../lib/time.js';

const optText = (max) => z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v || null));
const followup = z.string().nullable().refine((v) => v === null || DateTime.fromISO(v, { zone: config.tz }).isValid, 'Invalid date/time');

const fields = {
  email: z.union([z.literal('').transform(() => null), z.string().trim().toLowerCase().email().max(190)]).nullable().optional(),
  phone: optText(30),
  nickname: optText(120),
  business_name: optText(190),
  requirement: optText(255),
  budget: optText(100),
  message: optText(5000),
  enquiry_type_id: z.number().int().positive().nullable().optional(),
  source_id: z.number().int().positive().nullable().optional(),
  special_markup_id: z.number().int().positive().nullable().optional(),
  assigned_to: z.number().int().positive().nullable().optional(),
  next_followup_at: followup.optional(),
};
const createSchema = z.object({ ...fields, status_id: z.number().int().positive().optional(), created_at: z.string().optional() }).strict();
const updateSchema = z.object({ ...fields, status_id: z.number().int().positive().optional() }).strict();

export const parseFollowup = (v) => (v === null ? null : DateTime.fromISO(v, { zone: config.tz }).toUTC().toJSDate());

async function logActivity(conn, leadId, actorId, type, summary, before, after, now) {
  await conn.query(
    'INSERT INTO lead_activities (lead_id,actor_user_id,action_type,summary,before_data,after_data,created_at) VALUES (?,?,?,?,?,?,?)',
    [leadId, actorId, type, summary.slice(0, 500), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, now]);
}

const fmtFollowup = (d) => (d ? DateTime.fromJSDate(new Date(d), { zone: config.tz }).toFormat('dd LLL yyyy, hh:mm a') : 'none');

async function defaultStatus(conn) {
  const [[n]] = await conn.query(`SELECT id FROM selectable_values WHERE category='lead_status' AND is_active=1 AND is_new_state=1 AND status_category='active' LIMIT 1`);
  if (n) return n.id;
  const [[f]] = await conn.query(`SELECT id FROM selectable_values WHERE category='lead_status' AND is_active=1 AND status_category='active' ORDER BY sort_order LIMIT 1`);
  if (!f) throw badRequest('No active lead status is configured. Add one in Settings.');
  return f.id;
}

async function keyId(conn, category, key) {
  const [[r]] = await conn.query('SELECT id FROM selectable_values WHERE category=? AND value_key=? AND is_active=1', [category, key]);
  return r ? r.id : null;
}

/** Everyone who should hear about a new lead: admins plus the assignee, or all active agents when unassigned. */
async function newLeadRecipients(conn, assignedTo) {
  const [rows] = assignedTo
    ? await conn.query(`SELECT id FROM users WHERE is_active=1 AND (role='admin' OR id=?)`, [assignedTo])
    : await conn.query('SELECT id FROM users WHERE is_active=1');
  return rows.map((r) => r.id);
}

/**
 * THE single creation path (CRM form, website form, API all call this).
 * lead + activity + outbox event + notification rows commit atomically; the
 * realtime publisher only ever sees committed rows.
 */
export async function createLead(input, actor, { channel = 'manual', now = new Date(), lenientEmail = false } = {}) {
  // Public forms: keep a malformed email rather than losing the lead (agents can fix it in the CRM).
  let rawEmail;
  if (lenientEmail && typeof input.email === 'string') { rawEmail = input.email.trim().toLowerCase().slice(0, 190) || null; input = { ...input, email: null }; }
  const d = parse(createSchema, input);
  if (rawEmail !== undefined) d.email = rawEmail;
  if (!d.phone && !d.email) throw badRequest('Provide a phone number or an email address');
  let phone = null;
  if (d.phone) {
    phone = normalizePhone(d.phone);
    if (!phone) throw badRequest('Invalid phone number');
  }
  const actorId = actor?.id ?? null;

  // CRM users may back-date a lead's creation time (e.g. a phone enquiry logged later). Public intake never passes this.
  let createdAt = now;
  if (d.created_at) {
    const dt = DateTime.fromISO(d.created_at, { zone: config.tz });
    if (!dt.isValid) throw badRequest('Invalid creation date/time');
    if (dt.toMillis() > now.getTime() + 5 * 60 * 1000) throw badRequest('Creation date cannot be in the future');
    createdAt = dt.toUTC().toJSDate();
  }

  const created = await withTx(async (conn) => {
    const statusId = d.status_id ?? (await defaultStatus(conn));
    const status = await requireAssignable(conn, statusId, 'lead_status');
    if (d.enquiry_type_id) await requireAssignable(conn, d.enquiry_type_id, 'enquiry_type');
    let sourceId = d.source_id ?? null;
    if (sourceId) await requireAssignable(conn, sourceId, 'lead_source');
    else sourceId = await keyId(conn, 'lead_source', channel);
    let markupId = d.special_markup_id ?? null;
    if (markupId) await requireAssignable(conn, markupId, 'special_markup');
    else markupId = await keyId(conn, 'special_markup', 'normal');
    if (d.assigned_to) {
      const [[u]] = await conn.query('SELECT id FROM users WHERE id=? AND is_active=1', [d.assigned_to]);
      if (!u) throw badRequest('Assigned user not found or inactive');
    }
    const followupAt = d.next_followup_at ? parseFollowup(d.next_followup_at) : null;
    if (followupAt && status.status_category !== 'active') throw badRequest('Follow-ups can only be set on active leads');

    const [r] = await conn.query(
      `INSERT INTO leads (created_at,created_by,status_id,enquiry_type_id,source_id,email,phone,nickname,business_name,requirement,budget,message,next_followup_at,
         last_action_by,last_action_at,special_markup_id,assigned_to,updated_at,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [createdAt, actorId, statusId, d.enquiry_type_id ?? null, sourceId, d.email ?? null, phone, d.nickname ?? null, d.business_name ?? null, d.requirement ?? null, d.budget ?? null, d.message ?? null,
        followupAt, actorId, now, markupId, d.assigned_to ?? null, now, actorId]);
    const id = r.insertId;
    const code = `LD-${String(id).padStart(3, '0')}`;
    await conn.query('UPDATE leads SET lead_code = ? WHERE id = ?', [code, id]);

    await logActivity(conn, id, actorId, 'lead_created', `Lead created via ${channel}${d.created_at ? ' (creation date set manually)' : ''}`, null, { status: status.label, phone, email: d.email ?? null }, createdAt);
    if (followupAt) await logActivity(conn, id, actorId, 'followup_scheduled', `Follow-up scheduled for ${fmtFollowup(followupAt)}`, null, { next_followup_at: followupAt }, now);

    const enq = d.enquiry_type_id ? (await getValue(d.enquiry_type_id, conn)).label : 'General Enquiry';
    const recipients = await newLeadRecipients(conn, d.assigned_to);
    const eventUuid = randomUUID();
    const payload = {
      eventId: eventUuid, type: 'lead.created', leadId: id, leadCode: code, enquiry: enq,
      phone, nickname: d.nickname ?? null, receivedAt: now.toISOString(), channel, recipients,
    };
    const [ev] = await conn.query(
      'INSERT INTO event_outbox (event_uuid,event_type,lead_id,payload,created_at) VALUES (?,?,?,?,?)',
      [eventUuid, 'lead.created', id, JSON.stringify(payload), now]);
    if (recipients.length) {
      await conn.query('INSERT INTO notifications (user_id,event_id,lead_id,created_at) VALUES ?', [recipients.map((uid) => [uid, ev.insertId, id, now])]);
    }
    return id;
  });
  return getLead(created, actor ?? { id: 0, role: 'admin' }, now);
}

export async function getLead(id, user, now = new Date()) {
  const acc = accessClause(user);
  const [[row]] = await pool.query(`SELECT ${LEAD_SELECT} ${LEAD_JOINS} WHERE l.id = ? AND ${acc.sql}`, [id, ...acc.params]);
  if (!row) throw notFound('Lead not found');
  return toLeadDto(row, dayBounds(now), now);
}

async function lockLead(conn, id, user) {
  const [[row]] = await conn.query('SELECT * FROM leads WHERE id = ? FOR UPDATE', [id]);
  if (!row) throw notFound('Lead not found');
  if (user.role !== 'admin' && row.assigned_to !== null && row.assigned_to !== user.id && row.allocated_to !== user.id) throw notFound('Lead not found');
  return row;
}

const label = async (conn, id) => (id ? (await getValue(id, conn))?.label ?? `#${id}` : 'none');

export async function updateLead(id, input, user, now = new Date()) {
  const d = parse(updateSchema, input);
  if (!Object.keys(d).length) throw badRequest('Nothing to update');

  await withTx(async (conn) => {
    const cur = await lockLead(conn, id, user);
    if (cur.removed_at) throw conflict('This lead is removed. Restore it before editing.');
    const set = {}; const acts = [];
    const act = (type, summary, before, after) => acts.push([type, summary, before, after]);
    const [[curStatus]] = await conn.query('SELECT label, status_category FROM selectable_values WHERE id = ?', [cur.status_id]);
    let nextCategory = curStatus.status_category;

    if (d.status_id !== undefined && d.status_id !== cur.status_id) {
      const st = await requireAssignable(conn, d.status_id, 'lead_status');
      set.status_id = st.id; nextCategory = st.status_category;
      act('status_changed', `Status changed: ${curStatus.label} → ${st.label}`, { status: curStatus.label }, { status: st.label });
    }
    for (const [key, cat, type, noun] of [
      ['special_markup_id', 'special_markup', 'markup_changed', 'Special markup'],
      ['enquiry_type_id', 'enquiry_type', 'field_updated', 'Enquiry type'],
      ['source_id', 'lead_source', 'field_updated', 'Lead source'],
    ]) {
      if (d[key] !== undefined && d[key] !== cur[key]) {
        if (d[key] !== null) await requireAssignable(conn, d[key], cat);
        set[key] = d[key];
        const [b, a] = [await label(conn, cur[key]), await label(conn, d[key])];
        act(type, `${noun} changed: ${b} → ${a}`, { [key]: b }, { [key]: a });
      }
    }
    if (d.assigned_to !== undefined && d.assigned_to !== cur.assigned_to) {
      let after = 'Unassigned';
      if (d.assigned_to !== null) {
        const [[u]] = await conn.query('SELECT name FROM users WHERE id=? AND is_active=1', [d.assigned_to]);
        if (!u) throw badRequest('Assigned user not found or inactive');
        after = u.name;
      }
      let before = 'Unassigned';
      if (cur.assigned_to) { const [[u]] = await conn.query('SELECT name FROM users WHERE id=?', [cur.assigned_to]); before = u?.name ?? `#${cur.assigned_to}`; }
      set.assigned_to = d.assigned_to;
      act('assignment_changed', `Assignment changed: ${before} → ${after}`, { assigned_to: before }, { assigned_to: after });
    }
    if (d.phone !== undefined) {
      const p = d.phone === null ? null : normalizePhone(d.phone);
      if (d.phone !== null && !p) throw badRequest('Invalid phone number');
      if (p !== cur.phone) { set.phone = p; act('field_updated', `Phone changed: ${cur.phone ?? 'none'} → ${p ?? 'none'}`, { phone: cur.phone }, { phone: p }); }
    }
    for (const key of ['email', 'nickname', 'business_name', 'requirement', 'budget', 'message']) {
      if (d[key] !== undefined && (d[key] ?? null) !== cur[key]) {
        set[key] = d[key] ?? null;
        const shown = key === 'message' ? (v) => (v ? '(updated)' : 'none') : (v) => v ?? 'none';
        act('field_updated', `${key[0].toUpperCase()}${key.slice(1).replace('_', ' ')} changed: ${shown(cur[key])} → ${shown(set[key])}`,
          key === 'message' ? null : { [key]: cur[key] }, key === 'message' ? null : { [key]: set[key] });
      }
    }

    let nextFollowup = cur.next_followup_at;
    if (d.next_followup_at !== undefined) {
      const f = parseFollowup(d.next_followup_at);
      const same = (f?.getTime() ?? null) === (cur.next_followup_at ? new Date(cur.next_followup_at).getTime() : null);
      if (!same) {
        if (f && nextCategory !== 'active') throw badRequest('Follow-ups can only be set on active leads');
        nextFollowup = f; set.next_followup_at = f;
        const type = !f ? 'followup_cleared' : cur.next_followup_at ? 'followup_rescheduled' : 'followup_scheduled';
        const text = !f ? `Follow-up cleared (was ${fmtFollowup(cur.next_followup_at)})`
          : cur.next_followup_at ? `Follow-up rescheduled: ${fmtFollowup(cur.next_followup_at)} → ${fmtFollowup(f)}`
            : `Follow-up scheduled for ${fmtFollowup(f)}`;
        act(type, text, { next_followup_at: cur.next_followup_at }, { next_followup_at: f });
      }
    }
    // Leaving the Active section ends the follow-up cycle.
    if (nextCategory !== 'active' && nextFollowup) {
      set.next_followup_at = null;
      act('followup_cleared', `Follow-up cleared (lead moved out of active leads; was ${fmtFollowup(nextFollowup)})`, { next_followup_at: nextFollowup }, { next_followup_at: null });
    }

    if (!acts.length) return;
    set.last_action_by = user.id; set.last_action_at = now; set.updated_at = now; set.updated_by = user.id;
    const cols = Object.keys(set);
    await conn.query(`UPDATE leads SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => set[c]), id]);
    for (const [type, summary, before, after] of acts) await logActivity(conn, id, user.id, type, summary, before, after, now);
  });
  // Access was verified before the change; the actor may legitimately lose access by handing the lead on, so re-read without that check.
  return getLead(id, { id: user.id, role: 'admin' }, now);
}

const remarkSchema = z.object({ text: z.string().trim().min(1, 'Remark cannot be empty').max(5000) });

export async function addRemark(id, input, user, now = new Date()) {
  const { text } = parse(remarkSchema, input);
  const remarkId = await withTx(async (conn) => {
    const lead = await lockLead(conn, id, user);
    if (lead.removed_at) throw conflict('This lead is removed. Restore it before adding remarks.');
    const [r] = await conn.query('INSERT INTO lead_remarks (lead_id,remark_text,created_by,created_at) VALUES (?,?,?,?)', [id, text, user.id, now]);
    await conn.query(
      `UPDATE leads SET last_remark_text=?, last_remark_by=?, last_remark_at=?, remarks_count=remarks_count+1,
         last_action_by=?, last_action_at=?, updated_at=?, updated_by=? WHERE id=?`,
      [text, user.id, now, user.id, now, now, user.id, id]);
    await logActivity(conn, id, user.id, 'remark_added', `Remark added: ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`, null, null, now);
    return r.insertId;
  });
  return { id: remarkId };
}

export async function listRemarks(id, user) {
  await getLead(id, user);
  const [rows] = await pool.query(
    `SELECT r.id, r.remark_text AS text, r.created_at, r.created_by, u.name AS author
     FROM lead_remarks r LEFT JOIN users u ON u.id = r.created_by WHERE r.lead_id = ? ORDER BY r.created_at DESC, r.id DESC`, [id]);
  return rows;
}

export async function listActivities(id, user) {
  await getLead(id, user);
  const [rows] = await pool.query(
    `SELECT a.id, a.action_type, a.summary, a.before_data, a.after_data, a.created_at, a.actor_user_id, u.name AS actor
     FROM lead_activities a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.lead_id = ? ORDER BY a.created_at DESC, a.id DESC`, [id]);
  return rows.map((r) => ({ ...r, before_data: parseJson(r.before_data), after_data: parseJson(r.after_data) }));
}

const removeSchema = z.object({ reason: z.string().trim().min(1, 'A remark is required to remove a lead').max(5000) });

/** Soft-remove: the lead is kept (and restorable); the mandatory remark joins the normal remark history. */
export async function removeLead(id, input, user, now = new Date()) {
  const { reason } = parse(removeSchema, input);
  await withTx(async (conn) => {
    const cur = await lockLead(conn, id, user);
    if (cur.removed_at) throw conflict('This lead is already removed.');
    const text = `Removed: ${reason}`;
    await conn.query('INSERT INTO lead_remarks (lead_id,remark_text,created_by,created_at) VALUES (?,?,?,?)', [id, text, user.id, now]);
    await conn.query(
      `UPDATE leads SET removed_at=?, removed_by=?, removed_reason=?, last_remark_text=?, last_remark_by=?, last_remark_at=?, remarks_count=remarks_count+1,
         last_action_by=?, last_action_at=?, updated_at=?, updated_by=? WHERE id=?`,
      [now, user.id, reason, text, user.id, now, user.id, now, now, user.id, id]);
    await logActivity(conn, id, user.id, 'lead_removed', `Lead removed: ${reason.length > 120 ? `${reason.slice(0, 117)}…` : reason}`, null, null, now);
    // a removed lead must not leave "unread new lead" badges behind
    await conn.query('UPDATE notifications SET read_at = ? WHERE lead_id = ? AND read_at IS NULL', [now, id]);
  });
  return getLead(id, user, now);
}

export async function restoreLead(id, user, now = new Date()) {
  await withTx(async (conn) => {
    const cur = await lockLead(conn, id, user);
    if (!cur.removed_at) throw conflict('This lead is not removed.');
    await conn.query('UPDATE leads SET removed_at=NULL, removed_by=NULL, removed_reason=NULL, last_action_by=?, last_action_at=?, updated_at=?, updated_by=? WHERE id=?', [user.id, now, now, user.id, id]);
    await logActivity(conn, id, user.id, 'lead_restored', 'Lead restored from Removed', null, null, now);
  });
  return getLead(id, user, now);
}

const allocateSchema = z.object({
  lead_ids: z.array(z.number().int().positive()).min(1, 'Select at least one lead').max(1000),
  user_id: z.number().int().positive().nullable(), // null = clear the allocation
});

/**
 * Bulk allocate (or clear). Allocation is a temporary, priority hand-off and never touches `assigned_to`.
 * Only leads the actor can access are changed; the rest are reported as skipped.
 * Clearing is limited to admins, the current allocatee, or whoever allocated the lead.
 */
export async function allocateLeads(input, user, now = new Date()) {
  const { lead_ids: ids, user_id: toId } = parse(allocateSchema, input);
  const uniq = [...new Set(ids)];
  return withTx(async (conn) => {
    let target = null;
    if (toId !== null) {
      const [[u]] = await conn.query('SELECT id, name FROM users WHERE id = ? AND is_active = 1', [toId]);
      if (!u) throw badRequest('That user was not found or is inactive');
      target = u;
    }
    const acc = accessClause(user);
    const [rows] = await conn.query(
      `SELECT l.id, l.allocated_to, l.allocated_by, l.removed_at, au.name AS allocated_name FROM leads l LEFT JOIN users au ON au.id = l.allocated_to
       WHERE l.id IN (?) AND ${acc.sql} FOR UPDATE`, [uniq, ...acc.params]);
    const changed = []; const skipped = [];
    const found = new Set(rows.map((r) => r.id));
    for (const id of uniq) if (!found.has(id)) skipped.push({ id, reason: 'not found' });
    for (const r of rows) {
      if (r.removed_at) { skipped.push({ id: r.id, reason: 'removed' }); continue; }
      if (target === null) {
        const allowed = user.role === 'admin' || r.allocated_to === user.id || r.allocated_by === user.id;
        if (!r.allocated_to) { skipped.push({ id: r.id, reason: 'not allocated' }); continue; }
        if (!allowed) { skipped.push({ id: r.id, reason: 'not permitted' }); continue; }
      } else if (r.allocated_to === target.id) { skipped.push({ id: r.id, reason: 'already allocated to them' }); continue; }
      changed.push(r);
    }
    if (changed.length) {
      const idList = changed.map((r) => r.id);
      if (target) await conn.query('UPDATE leads SET allocated_to=?, allocated_by=?, allocated_at=?, last_action_by=?, last_action_at=?, updated_at=?, updated_by=? WHERE id IN (?)', [target.id, user.id, now, user.id, now, now, user.id, idList]);
      else await conn.query('UPDATE leads SET allocated_to=NULL, allocated_by=NULL, allocated_at=NULL, last_action_by=?, last_action_at=?, updated_at=?, updated_by=? WHERE id IN (?)', [user.id, now, now, user.id, idList]);
      const acts = changed.map((r) => [r.id, user.id, target ? 'lead_allocated' : 'allocation_cleared',
        target ? `Allocated to ${target.name}${r.allocated_name ? ` (was ${r.allocated_name})` : ''}` : `Allocation to ${r.allocated_name} cleared`,
        JSON.stringify({ allocated_to: r.allocated_name ?? null }), JSON.stringify({ allocated_to: target?.name ?? null }), now]);
      await conn.query('INSERT INTO lead_activities (lead_id,actor_user_id,action_type,summary,before_data,after_data,created_at) VALUES ?', [acts]);
    }
    return { allocated: changed.length, skipped, user: target };
  });
}

/**
 * Bulk (re)assign. Any user may hand leads they can access to any active user, or unassign them (`user_id: null`).
 * Unlike allocation this changes the lead's owner (`assigned_to`). Allocation is left untouched.
 */
export async function assignLeads(input, user, now = new Date()) {
  const { lead_ids: ids, user_id: toId } = parse(allocateSchema, input);
  const uniq = [...new Set(ids)];
  return withTx(async (conn) => {
    let target = null;
    if (toId !== null) {
      const [[u]] = await conn.query('SELECT id, name FROM users WHERE id = ? AND is_active = 1', [toId]);
      if (!u) throw badRequest('That user was not found or is inactive');
      target = u;
    }
    const acc = accessClause(user);
    const [rows] = await conn.query(
      `SELECT l.id, l.assigned_to, l.removed_at, au.name AS assigned_name FROM leads l LEFT JOIN users au ON au.id = l.assigned_to
       WHERE l.id IN (?) AND ${acc.sql} FOR UPDATE`, [uniq, ...acc.params]);
    const found = new Set(rows.map((r) => r.id));
    const skipped = uniq.filter((id) => !found.has(id)).map((id) => ({ id, reason: 'not found' }));
    const changed = [];
    for (const r of rows) {
      if (r.removed_at) skipped.push({ id: r.id, reason: 'removed' });
      else if ((r.assigned_to ?? null) === (target?.id ?? null)) skipped.push({ id: r.id, reason: target ? 'already assigned to them' : 'already unassigned' });
      else changed.push(r);
    }
    if (changed.length) {
      await conn.query('UPDATE leads SET assigned_to=?, last_action_by=?, last_action_at=?, updated_at=?, updated_by=? WHERE id IN (?)', [target?.id ?? null, user.id, now, now, user.id, changed.map((r) => r.id)]);
      const acts = changed.map((r) => [r.id, user.id, 'assignment_changed', `Assignment changed: ${r.assigned_name ?? 'Unassigned'} → ${target?.name ?? 'Unassigned'}`,
        JSON.stringify({ assigned_to: r.assigned_name ?? 'Unassigned' }), JSON.stringify({ assigned_to: target?.name ?? 'Unassigned' }), now]);
      await conn.query('INSERT INTO lead_activities (lead_id,actor_user_id,action_type,summary,before_data,after_data,created_at) VALUES ?', [acts]);
    }
    return { assigned: changed.length, skipped, user: target };
  });
}
