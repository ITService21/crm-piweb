import crypto from 'node:crypto';
import { z } from 'zod';
import { pool, withTx, parseJson } from '../db.js';
import { config } from '../config.js';
import { formatMoney } from '../lib/money.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../lib/errors.js';
import { DateTime } from 'luxon';
import { todayStr, dayStartUtc, nextDayStartUtc, addDaysStr } from '../lib/time.js';
import { storeProof, removeStored, proofPath } from './proofs.js';
import { computeLine, computeTotals, toMinor, toMilli, minorToString, milliToString, fromDb, amountInWordsINR } from '../lib/money.js';
import { issuerSnapshot } from '../config/issuer.js';
import { accessClause } from './leadQuery.js';
import { logActivity } from './leads.js';
import { renderPdf } from './pdf.js';
import { ISSUER, DEFAULT_PAYMENT_TERMS } from '../config/issuer.js';
import { sendMail, emailConfigured } from './mailer.js';

export const TYPES = {
  invoice: { prefix: 'INV', label: 'Invoice' },
  quotation: { prefix: 'QT', label: 'Quotation' },
};
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'];
const LEAD_CODE_RE = /^[A-Za-z]{1,6}-\d{1,10}$/;
const PAYABLE = ['issued', 'partially_paid'];

const isAdmin = (u) => u.role === 'admin';
/** Admins and agents can change quotations / invoices / payments; telecallers are view-only (enforced for every write route too). */
const canEdit = (u) => u.role === 'admin' || u.role === 'agent';
const dateOnly = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** INV-GN-LD-005, INV-GN-LD-005-02, INV-GN-LD-005-03 … (QT- for quotations). The lead number is used exactly as stored. */
export function documentNumber(type, leadCode, seq) {
  const base = `${TYPES[type].prefix}-GN-${leadCode}`;
  return seq === 1 ? base : `${base}-${String(seq).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- validation
const optText = (max) => z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v || null));
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');
const num = z.union([z.string(), z.number()]);

const CLIENT_KEYS = ['company_name', 'contact_name', 'email', 'phone', 'alt_phone', 'address', 'city', 'state', 'postal_code', 'country', 'gstin', 'pan', 'website', 'additional_details', 'notes'];
const clientSchema = z.object({
  company_name: optText(255), contact_name: optText(255), email: optText(190), phone: optText(40), alt_phone: optText(40),
  address: optText(1000), city: optText(120), state: optText(120), postal_code: optText(20), country: optText(120),
  gstin: optText(40), pan: optText(40), website: optText(255), additional_details: optText(3000), notes: optText(3000),
});
/** Every client field is optional; anything not supplied stays empty. */
const normalizeClient = (c = {}) => Object.fromEntries(CLIENT_KEYS.map((k) => [k, c?.[k] ?? null]));

const itemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required').max(255),
  description: optText(3000),
  quantity: num, unit_price: num,
  discount_type: z.enum(['none', 'percent', 'amount']).optional().default('none'),
  discount_value: num.nullish(),
  tax_rate: num.nullish(),
});

// Unknown keys (issuer, doc_number, status, totals…) are dropped: clients cannot supply them.
const bodySchema = z.object({
  issue_date: dateStr.optional(),
  due_date: dateStr.nullish(),
  currency: z.enum(CURRENCIES).optional(),
  payment_terms: optText(500), po_number: optText(100), place_of_supply: optText(150),
  client_notes: optText(5000), internal_notes: optText(5000),
  additional_charges: num.nullish(), additional_charges_label: optText(100),
  client: clientSchema.optional(),
  items: z.array(itemSchema).max(200).optional(),
});
const createSchema = bodySchema.extend({ lead_id: z.number().int().positive() });

// ---------------------------------------------------------------- calculation
function computeAll(items, additional) {
  const lines = items.map((it, i) => {
    try {
      return computeLine(it);
    } catch (e) {
      throw badRequest(`Item ${i + 1}: ${e.message}`, [{ path: `items.${i}`, message: e.message }]);
    }
  });
  let extra = 0;
  if (additional !== null && additional !== undefined && additional !== '') extra = toMinor(additional, 'Additional charges');
  return { lines, extra, totals: computeTotals(lines, extra) };
}

const lineOut = (l) => ({
  gross_amount: minorToString(l.gross), discount_amount: minorToString(l.discount), taxable_amount: minorToString(l.taxable),
  tax_amount: minorToString(l.tax), line_total: minorToString(l.total),
});
const totalsOut = (t) => ({
  subtotal: minorToString(t.subtotal), discount_total: minorToString(t.discount), taxable_amount: minorToString(t.taxable),
  tax_amount: minorToString(t.tax), additional_charges: minorToString(t.additional), total: minorToString(t.total),
});

/** Live preview helper: never throws; flags bad lines instead so the form can keep calculating while the user types. */
export function calculatePreview(input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const out = []; const good = [];
  for (const it of items) {
    try { const l = computeLine({ quantity: it.quantity, unit_price: it.unit_price, discount_type: it.discount_type || 'none', discount_value: it.discount_value, tax_rate: it.tax_rate }); out.push(lineOut(l)); good.push(l); }
    catch (e) { out.push({ error: e.message, gross_amount: '0.00', discount_amount: '0.00', taxable_amount: '0.00', tax_amount: '0.00', line_total: '0.00' }); }
  }
  let extra = 0; let extraError = null;
  try { if (input?.additional_charges !== null && input?.additional_charges !== undefined && input?.additional_charges !== '') extra = toMinor(input.additional_charges, 'Additional charges'); }
  catch (e) { extraError = e.message; }
  const t = computeTotals(good, extra);
  return { items: out, totals: totalsOut(t), amount_in_words: input?.currency && input.currency !== 'INR' ? null : amountInWordsINR(t.total), additional_charges_error: extraError };
}

// ---------------------------------------------------------------- DTOs
const clean = (v) => (v === null || v === undefined ? null : String(Number(v)));

function toDto(row, items = [], extra = {}) {
  const total = fromDb(row.total); const paid = fromDb(row.amount_paid); const outstanding = total - paid;
  const today = todayStr(); const due = dateOnly(row.due_date);
  const isInvoice = row.doc_type === 'invoice';
  return {
    id: row.id, type: row.doc_type, doc_number: row.doc_number, status: row.status, currency: row.currency,
    lead: { id: row.lead_id, lead_code: row.lead_code, nickname: row.lead_nickname ?? null, removed: !!row.lead_removed_at },
    issue_date: dateOnly(row.issue_date), due_date: due,
    payment_terms: row.payment_terms, po_number: row.po_number, place_of_supply: row.place_of_supply,
    client_notes: row.client_notes, internal_notes: row.internal_notes,
    client: normalizeClient(parseJson(row.client_snapshot)), issuer: parseJson(row.issuer_snapshot),
    items: items.map((i) => ({
      position: i.position, name: i.name, description: i.description, quantity: clean(i.quantity), unit_price: minorToString(fromDb(i.unit_price)),
      discount_type: i.discount_type, discount_value: clean(i.discount_value), tax_rate: clean(i.tax_rate),
      gross_amount: minorToString(fromDb(i.gross_amount)), discount_amount: minorToString(fromDb(i.discount_amount)),
      taxable_amount: minorToString(fromDb(i.taxable_amount)), tax_amount: minorToString(fromDb(i.tax_amount)), line_total: minorToString(fromDb(i.line_total)),
    })),
    subtotal: minorToString(fromDb(row.subtotal)), discount_total: minorToString(fromDb(row.discount_total)), taxable_amount: minorToString(fromDb(row.taxable_amount)),
    tax_amount: minorToString(fromDb(row.tax_amount)), additional_charges: minorToString(fromDb(row.additional_charges)),
    additional_charges_label: row.additional_charges_label, total: minorToString(total),
    amount_paid: minorToString(paid), outstanding: minorToString(outstanding),
    amount_in_words: row.currency === 'INR' ? amountInWordsINR(total) : null,
    payment_status: !isInvoice ? null : paid === 0 ? 'unpaid' : outstanding > 0 ? 'partial' : 'paid',
    is_overdue: isInvoice && PAYABLE.includes(row.status) && !!due && due < today && outstanding > 0,
    is_expired: !isInvoice && row.status === 'issued' && !!due && due < today,
    next_payment_due: dateOnly(row.next_payment_due),
    payment_followup_due: isInvoice && PAYABLE.includes(row.status) && !!row.next_payment_due && dateOnly(row.next_payment_due) <= today && outstanding > 0,
    source_quotation_id: row.source_quotation_id,
    issued_at: row.issued_at, responded_at: row.responded_at, cancelled_at: row.cancelled_at, cancel_reason: row.cancel_reason,
    created_by_name: row.created_by_name ?? null, created_at: row.created_at, updated_at: row.updated_at,
    ...extra,
  };
}

const DOC_SELECT = `SELECT d.*, l.lead_code, l.nickname AS lead_nickname, l.removed_at AS lead_removed_at, cu.name AS created_by_name
  FROM billing_documents d JOIN leads l ON l.id = d.lead_id LEFT JOIN users cu ON cu.id = d.created_by`;

async function loadRow(conn, id, type, user) {
  const acc = accessClause(user, 'l');
  const [[row]] = await conn.query(`${DOC_SELECT} WHERE d.id = ? AND d.doc_type = ? AND ${acc.sql}`, [id, type, ...acc.params]);
  if (!row) throw notFound(`${TYPES[type].label} not found`);
  return row;
}
/** Row lock on the document itself (not the lead) so concurrent edits/payments/status changes serialise safely. */
async function lockDoc(conn, id, type) {
  const [[r]] = await conn.query('SELECT id FROM billing_documents WHERE id = ? AND doc_type = ? FOR UPDATE', [id, type]);
  if (!r) throw notFound(`${TYPES[type].label} not found`);
}
const loadItems = async (conn, id) => (await conn.query('SELECT * FROM billing_document_items WHERE document_id = ? ORDER BY position', [id]))[0];

export async function getDocument(type, id, user) {
  const row = await loadRow(pool, id, type, user);
  const items = await loadItems(pool, id);
  const extra = {};
  if (type === 'invoice') {
    const [pay] = await pool.query('SELECT p.*, u.name AS created_by_name FROM invoice_payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.document_id = ? ORDER BY p.paid_on, p.id', [id]);
    const [att] = await pool.query('SELECT id, payment_id, original_name, mime, size_bytes, created_at FROM payment_attachments WHERE document_id = ? ORDER BY id', [id]);
    extra.payments = pay.map((p) => ({ id: p.id, amount: minorToString(fromDb(p.amount)), paid_on: dateOnly(p.paid_on), method: p.method, reference: p.reference, notes: p.notes, created_by_name: p.created_by_name, created_at: p.created_at,
      attachments: att.filter((a) => a.payment_id === p.id).map((a) => ({ id: a.id, name: a.original_name, mime: a.mime, size: a.size_bytes, created_at: a.created_at })) }));
  }
  const [em] = await pool.query('SELECT e.id, e.channel, e.to_email, e.cc_email, e.subject, e.status, e.error, e.created_at, u.name AS sent_by_name FROM document_emails e LEFT JOIN users u ON u.id = e.sent_by WHERE e.document_id = ? ORDER BY e.id DESC', [id]);
  extra.emails = em;
  if (type === 'quotation') {
    const [[inv]] = await pool.query("SELECT id, doc_number FROM billing_documents WHERE source_quotation_id = ? AND status <> 'cancelled' ORDER BY id LIMIT 1", [id]);
    extra.converted_invoice = inv ?? null;
  } else if (row.source_quotation_id) {
    const [[q]] = await pool.query('SELECT id, doc_number FROM billing_documents WHERE id = ?', [row.source_quotation_id]);
    extra.source_quotation = q ?? null;
  }
  return toDto(row, items, extra);
}

// ---------------------------------------------------------------- create
function prefillClient(lead) {
  const extra = [lead.requirement && `Requirement: ${lead.requirement}`, lead.budget && `Budget: ${lead.budget}`].filter(Boolean).join('\n');
  return normalizeClient({
    company_name: lead.business_name || lead.nickname || null, contact_name: lead.nickname || null,
    email: lead.email || null, phone: lead.phone || null, additional_details: extra || null,
  });
}

async function lockLeadFor(conn, leadId, user) {
  const acc = accessClause(user, 'l');
  const [[lead]] = await conn.query(`SELECT l.* FROM leads l WHERE l.id = ? AND ${acc.sql} FOR UPDATE`, [leadId, ...acc.params]);
  if (!lead) throw notFound('Lead not found');
  return lead;
}

function checkDates(issue, due) {
  if (due && issue && due < issue) throw badRequest('The due date cannot be before the invoice date');
}

/** Allocates the permanent number and inserts the draft. The lead row is locked first, so two users can never get the same number. */
async function insertDraft(conn, type, lead, user, data, now) {
  if (lead.removed_at) throw conflict('This lead has been removed. Restore it before creating documents.');
  if (!lead.lead_code || !LEAD_CODE_RE.test(lead.lead_code)) {
    throw new HttpError(422, 'This lead has no valid lead number, so a document number cannot be generated.', 'INVALID_LEAD_NUMBER');
  }
  const [[n]] = await conn.query('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM billing_documents WHERE lead_id = ? AND doc_type = ?', [lead.id, type]);
  const seq = n.seq; // MAX over ALL rows (including cancelled), so a number is never reused
  const number = documentNumber(type, lead.lead_code, seq);
  const issue = data.issue_date ?? todayStr(now);
  checkDates(issue, data.due_date);
  const { lines, extra, totals } = computeAll(data.items ?? [], data.additional_charges);
  const client = data.client ? normalizeClient(data.client) : prefillClient(lead);
  const [ins] = await conn.query(
    `INSERT INTO billing_documents (doc_type, doc_number, lead_id, seq, status, issue_date, due_date, currency, payment_terms, po_number, place_of_supply,
       client_notes, internal_notes, client_name, client_snapshot, issuer_snapshot, subtotal, discount_total, taxable_amount, tax_amount, additional_charges,
       additional_charges_label, total, source_quotation_id, idempotency_key, created_by, updated_by, created_at, updated_at)
     VALUES (?,?,?,?, 'draft', ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?,?)`,
    [type, number, lead.id, seq, issue, data.due_date ?? null, data.currency ?? 'INR', data.payment_terms ?? null, data.po_number ?? null, data.place_of_supply ?? null,
      data.client_notes ?? null, data.internal_notes ?? null, client.company_name || client.contact_name, JSON.stringify(client), JSON.stringify(issuerSnapshot()),
      minorToString(totals.subtotal), minorToString(totals.discount), minorToString(totals.taxable), minorToString(totals.tax), minorToString(extra),
      data.additional_charges_label ?? null, minorToString(totals.total), data.source_quotation_id ?? null, data.idempotency_key ?? null, user.id, user.id, now, now]);
  await insertItems(conn, ins.insertId, data.items ?? [], lines);
  await logActivity(conn, lead.id, user.id, 'document_created', `${TYPES[type].label} ${number} created (draft)`, null, null, now);
  return ins.insertId;
}

async function insertItems(conn, docId, items, lines) {
  if (!items.length) return;
  const rows = items.map((it, i) => [docId, i + 1, it.name, it.description ?? null, minorToStringQty(lines[i].qtyMilli), minorToString(lines[i].priceMinor),
    lines[i].discount > 0 ? it.discount_type : 'none', lines[i].discount > 0 ? minorToStringQty(toMilliSafe(it.discount_value)) : '0.000',
    lines[i].rateMilli === null ? null : minorToStringQty(lines[i].rateMilli),
    minorToString(lines[i].gross), minorToString(lines[i].discount), minorToString(lines[i].taxable), minorToString(lines[i].tax), minorToString(lines[i].total)]);
  await conn.query(
    `INSERT INTO billing_document_items (document_id, position, name, description, quantity, unit_price, discount_type, discount_value, tax_rate,
       gross_amount, discount_amount, taxable_amount, tax_amount, line_total) VALUES ?`, [rows]);
}
const minorToStringQty = (milli) => `${Math.floor(Math.abs(milli) / 1000)}.${String(Math.abs(milli) % 1000).padStart(3, '0')}`;
function toMilliSafe(v) { const s = String(v ?? 0).replace(/,/g, ''); const [i, f = ''] = s.split('.'); return Number(i) * 1000 + Number(f.padEnd(3, '0').slice(0, 3)); }

export async function createDraft(type, input, user, { idempotencyKey = null, now = new Date() } = {}) {
  const d = parse(createSchema, input);
  if (idempotencyKey && !/^[A-Za-z0-9_-]{8,40}$/.test(idempotencyKey)) throw badRequest('Invalid idempotency key');
  const key = idempotencyKey ? `${user.id}:${idempotencyKey}` : null;
  const id = await withTx(async (conn) => {
    const lead = await lockLeadFor(conn, d.lead_id, user);
    if (key) { // a retried/double-submitted request returns the draft it already created
      const [[ex]] = await conn.query('SELECT id, doc_type FROM billing_documents WHERE idempotency_key = ?', [key]);
      if (ex) { if (ex.doc_type !== type) throw conflict('This idempotency key was used for a different document type'); return ex.id; }
    }
    return insertDraft(conn, type, lead, user, { ...d, idempotency_key: key }, now);
  });
  return getDocument(type, id, user);
}

// ---------------------------------------------------------------- service presets
const presetSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255), description: optText(3000), unit_price: num, tax_rate: num.nullish(), discount_type: z.enum(['none', 'percent', 'amount']).optional(), discount_value: num.nullish(),
  is_default: z.boolean().optional(), is_active: z.boolean().optional(), sort_order: z.number().int().min(0).max(100000).optional(),
});
const presetOut = (r) => ({ id: r.id, name: r.name, description: r.description, unit_price: minorToString(fromDb(r.unit_price)), tax_rate: r.tax_rate === null ? null : String(Number(r.tax_rate)), discount_type: r.discount_type ?? 'none', discount_value: r.discount_type && r.discount_type !== 'none' && r.discount_value !== null ? String(Number(r.discount_value)) : null, is_default: !!r.is_default, is_active: !!r.is_active, sort_order: r.sort_order });

export async function listPresets(user, includeInactive = false) {
  const [rows] = await pool.query(`SELECT * FROM service_presets ${includeInactive && isAdmin(user) ? '' : 'WHERE is_active = 1'} ORDER BY sort_order, id`);
  return rows.map(presetOut);
}
function presetValues(d, cur = {}) {
  const price = d.unit_price !== undefined ? toMinor(d.unit_price, 'Unit price') : fromDb(cur.unit_price);
  const rate = d.tax_rate !== undefined ? (d.tax_rate === null || d.tax_rate === '' ? null : toMilli(d.tax_rate, 'Tax rate')) : (cur.tax_rate === null || cur.tax_rate === undefined ? null : Math.round(Number(cur.tax_rate) * 1000));
  if (rate !== null && rate > 100000) throw badRequest('Tax rate cannot exceed 100%');
  const dType = d.discount_type ?? cur.discount_type ?? 'none';
  let dVal = null;
  if (dType !== 'none') {
    const raw = d.discount_value !== undefined ? d.discount_value : cur.discount_value;
    if (raw === null || raw === undefined || raw === '') throw badRequest('Enter the discount value');
    const milli = d.discount_value !== undefined ? toMilli(raw, 'Discount') : Math.round(Number(raw) * 1000);
    if (dType === 'percent' && milli > 100000) throw badRequest('A percentage discount cannot exceed 100%');
    dVal = milliToString(milli);
  }
  return [d.name ?? cur.name, d.description !== undefined ? d.description : cur.description ?? null, minorToString(price), rate === null ? null : milliToString(rate),
    d.is_default !== undefined ? (d.is_default ? 1 : 0) : cur.is_default ?? 0, d.is_active !== undefined ? (d.is_active ? 1 : 0) : cur.is_active ?? 1, d.sort_order ?? cur.sort_order ?? 0, dType, dVal];
}
export async function createPreset(input, user) {
  if (!isAdmin(user)) throw forbidden('Only an administrator can manage service presets.');
  const d = parse(presetSchema, input); const now = new Date();
  const [[m]] = await pool.query('SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM service_presets');
  const vals = presetValues({ ...d, sort_order: d.sort_order ?? m.n });
  try {
    const [r] = await pool.query('INSERT INTO service_presets (name, description, unit_price, tax_rate, is_default, is_active, sort_order, discount_type, discount_value, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [...vals, now, now]);
    const [[row]] = await pool.query('SELECT * FROM service_presets WHERE id = ?', [r.insertId]); return presetOut(row);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict(`A preset named "${d.name}" already exists`); throw e; }
}
export async function updatePreset(id, input, user) {
  if (!isAdmin(user)) throw forbidden('Only an administrator can manage service presets.');
  const d = parse(presetSchema.partial(), input);
  const [[cur]] = await pool.query('SELECT * FROM service_presets WHERE id = ?', [id]); if (!cur) throw notFound('Preset not found');
  try {
    await pool.query('UPDATE service_presets SET name=?, description=?, unit_price=?, tax_rate=?, is_default=?, is_active=?, sort_order=?, discount_type=?, discount_value=?, updated_at=? WHERE id=?', [...presetValues(d, cur), new Date(), id]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict(`A preset named "${d.name}" already exists`); throw e; }
  const [[row]] = await pool.query('SELECT * FROM service_presets WHERE id = ?', [id]); return presetOut(row);
}
export async function deletePreset(id, user) {
  if (!isAdmin(user)) throw forbidden('Only an administrator can manage service presets.');
  const [r] = await pool.query('DELETE FROM service_presets WHERE id = ?', [id]); // documents hold copies, so nothing depends on a preset
  if (!r.affectedRows) throw notFound('Preset not found');
}

export async function getPrefill(type, leadId, user) {
  const acc = accessClause(user, 'l');
  const [[lead]] = await pool.query(`SELECT l.* FROM leads l WHERE l.id = ? AND ${acc.sql}`, [leadId, ...acc.params]);
  if (!lead) throw notFound('Lead not found');
  const valid = !!lead.lead_code && LEAD_CODE_RE.test(lead.lead_code);
  const [[n]] = await pool.query('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM billing_documents WHERE lead_id = ? AND doc_type = ?', [leadId, type]);
  return {
    lead: { id: lead.id, lead_code: lead.lead_code, nickname: lead.nickname, removed: !!lead.removed_at },
    client: prefillClient(lead), issuer: issuerSnapshot(),
    defaults: { issue_date: todayStr(), currency: 'INR', payment_terms: DEFAULT_PAYMENT_TERMS },
    default_items: (await listPresets(user)).filter((p) => p.is_default).map((p) => ({ name: p.name, description: p.description, quantity: '1', unit_price: p.unit_price, tax_rate: p.tax_rate, discount_type: p.discount_type, discount_value: p.discount_value })),
    expected_number: valid ? documentNumber(type, lead.lead_code, n.seq) : null, // a hint only; the real number is assigned when the draft is saved
    error: valid ? null : 'This lead has no valid lead number, so a document number cannot be generated.',
  };
}

// ---------------------------------------------------------------- update (draft only)
export async function updateDraft(type, id, input, user, now = new Date()) {
  const d = parse(bodySchema, input);
  await withTx(async (conn) => {
    await lockDoc(conn, id, type);
    const row = await loadRow(conn, id, type, user);
    if (row.status !== 'draft') throw conflict(`This ${TYPES[type].label.toLowerCase()} has been issued and can no longer be edited.`);
    const items = d.items ?? (await loadItems(conn, id)).map((i) => ({ name: i.name, description: i.description, quantity: clean(i.quantity), unit_price: minorToString(fromDb(i.unit_price)), discount_type: i.discount_type, discount_value: clean(i.discount_value), tax_rate: clean(i.tax_rate) }));
    const additional = d.additional_charges !== undefined ? d.additional_charges : minorToString(fromDb(row.additional_charges));
    const { lines, extra, totals } = computeAll(items, additional);
    const issue = d.issue_date ?? dateOnly(row.issue_date);
    const due = d.due_date !== undefined ? d.due_date : dateOnly(row.due_date);
    checkDates(issue, due);
    const client = d.client ? normalizeClient(d.client) : normalizeClient(parseJson(row.client_snapshot));
    const pick = (k) => (d[k] !== undefined ? d[k] : row[k]);
    await conn.query(
      `UPDATE billing_documents SET issue_date=?, due_date=?, currency=?, payment_terms=?, po_number=?, place_of_supply=?, client_notes=?, internal_notes=?,
         client_name=?, client_snapshot=?, issuer_snapshot=?, subtotal=?, discount_total=?, taxable_amount=?, tax_amount=?, additional_charges=?, additional_charges_label=?, total=?,
         updated_by=?, updated_at=? WHERE id=?`,
      [issue, due, d.currency ?? row.currency, pick('payment_terms'), pick('po_number'), pick('place_of_supply'), pick('client_notes'), pick('internal_notes'),
        client.company_name || client.contact_name, JSON.stringify(client), JSON.stringify(issuerSnapshot()), minorToString(totals.subtotal), minorToString(totals.discount), minorToString(totals.taxable),
        minorToString(totals.tax), minorToString(extra), pick('additional_charges_label'), minorToString(totals.total), user.id, now, id]);
    if (d.items) { await conn.query('DELETE FROM billing_document_items WHERE document_id = ?', [id]); await insertItems(conn, id, items, lines); }
    else if (d.additional_charges !== undefined) { /* totals already recomputed from stored lines */ }
  });
  return getDocument(type, id, user);
}

/** Internal notes are private bookkeeping, so they stay editable after issuing (nothing client-facing changes). */
export async function updateInternalNotes(type, id, input, user, now = new Date()) {
  const { internal_notes: notes } = parse(z.object({ internal_notes: optText(5000) }), input);
  await withTx(async (conn) => {
    await lockDoc(conn, id, type); await loadRow(conn, id, type, user);
    await conn.query('UPDATE billing_documents SET internal_notes=?, updated_by=?, updated_at=? WHERE id=?', [notes ?? null, user.id, now, id]);
  });
  return getDocument(type, id, user);
}

// ---------------------------------------------------------------- lifecycle
const confirmSchema = z.object({ confirm: z.literal(true, { message: 'Confirmation is required' }) });

export async function issueDocument(type, id, input, user, now = new Date()) {
  parse(confirmSchema, input);
  await withTx(async (conn) => {
    await lockDoc(conn, id, type);
    const row = await loadRow(conn, id, type, user);
    if (row.status !== 'draft') throw conflict(`This ${TYPES[type].label.toLowerCase()} is already ${row.status}.`);
    const items = await loadItems(conn, id);
    if (!items.length) throw badRequest('Add at least one line item before issuing.');
    if (fromDb(row.total) <= 0) throw badRequest('The total must be greater than zero before issuing.');
    checkDates(dateOnly(row.issue_date), dateOnly(row.due_date));
    // The company details are frozen at the moment a document is issued (from the trusted server config, never from the client).
    await conn.query("UPDATE billing_documents SET status='issued', issuer_snapshot=?, issued_at=?, issued_by=?, updated_by=?, updated_at=? WHERE id=?", [JSON.stringify(issuerSnapshot()), now, user.id, user.id, now, id]);
    await logActivity(conn, row.lead_id, user.id, 'document_issued', `${TYPES[type].label} ${row.doc_number} issued — ${minorToString(fromDb(row.total))} ${row.currency}`, null, null, now);
  });
  return getDocument(type, id, user);
}

export async function cancelDocument(type, id, input, user, now = new Date()) {
  const { reason } = parse(confirmSchema.extend({ reason: z.string().trim().min(1, 'A reason is required').max(500) }), input);
  await withTx(async (conn) => {
    await lockDoc(conn, id, type);
    const row = await loadRow(conn, id, type, user);
    if (row.status === 'cancelled') throw conflict('Already cancelled.');
    if (row.status !== 'draft' && !canEdit(user)) throw forbidden('Your role cannot cancel an issued document.');
    if (row.status === 'draft' && !isAdmin(user) && row.created_by !== user.id) throw forbidden('Only the author or an administrator can cancel this draft.');
    if (type === 'invoice' && (row.status === 'paid' || fromDb(row.amount_paid) > 0)) throw conflict('This invoice has payments recorded, so it cannot be cancelled.');
    if (type === 'quotation' && row.status === 'converted') throw conflict('This quotation has been converted to an invoice.');
    await conn.query("UPDATE billing_documents SET status='cancelled', cancelled_at=?, cancelled_by=?, cancel_reason=?, updated_by=?, updated_at=? WHERE id=?", [now, user.id, reason, user.id, now, id]);
    await logActivity(conn, row.lead_id, user.id, 'document_cancelled', `${TYPES[type].label} ${row.doc_number} cancelled: ${reason}`.slice(0, 480), null, null, now);
  });
  return getDocument(type, id, user);
}

// ---------------------------------------------------------------- payments (invoices)
const paymentSchema = z.object({
  amount: num, paid_on: dateStr.optional(),
  method: optText(40), reference: optText(150), notes: optText(2000),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/).optional(),
});

export async function recordPayment(id, input, user, now = new Date()) {
  if (!canEdit(user)) throw forbidden('Your role cannot record payments.');
  const d = parse(paymentSchema, input);
  const amount = toMinor(d.amount, 'Payment amount');
  if (amount <= 0) throw badRequest('Payment amount must be greater than zero');
  const paidOn = d.paid_on ?? todayStr(now);
  if (paidOn > todayStr(now)) throw badRequest('The payment date cannot be in the future');
  const result = await withTx(async (conn) => {
    await lockDoc(conn, id, 'invoice');
    const row = await loadRow(conn, id, 'invoice', user);
    // duplicate submission? same idempotency key, or an identical payment by the same user in the last 30 seconds
    if (d.idempotency_key) {
      const [[ex]] = await conn.query('SELECT id FROM invoice_payments WHERE document_id = ? AND idempotency_key = ?', [id, d.idempotency_key]);
      if (ex) return { duplicate: true };
    } else {
      const [[ex]] = await conn.query(
        'SELECT id FROM invoice_payments WHERE document_id = ? AND amount = ? AND paid_on = ? AND COALESCE(method,\'\') = ? AND COALESCE(reference,\'\') = ? AND created_by = ? AND created_at > ?',
        [id, minorToString(amount), paidOn, d.method ?? '', d.reference ?? '', user.id, new Date(now.getTime() - 30000)]);
      if (ex) return { duplicate: true };
    }
    if (!PAYABLE.includes(row.status)) throw conflict(row.status === 'draft' ? 'Issue the invoice before recording payments.' : `Payments cannot be recorded on a ${row.status} invoice.`);
    const total = fromDb(row.total); const paid = fromDb(row.amount_paid); const outstanding = total - paid;
    if (amount > outstanding) throw badRequest(`The payment exceeds the outstanding balance of ${minorToString(outstanding)}.`);
    await conn.query('INSERT INTO invoice_payments (document_id, amount, paid_on, method, reference, notes, idempotency_key, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, minorToString(amount), paidOn, d.method ?? null, d.reference ?? null, d.notes ?? null, d.idempotency_key ?? null, user.id, now]);
    const newPaid = paid + amount; const status = newPaid === total ? 'paid' : 'partially_paid';
    await conn.query('UPDATE billing_documents SET amount_paid=?, status=?, next_payment_due=?, updated_by=?, updated_at=? WHERE id=?', [minorToString(newPaid), status, status === 'paid' ? null : dateOnly(row.next_payment_due), user.id, now, id]);
    await logActivity(conn, row.lead_id, user.id, 'payment_recorded', `Payment ${minorToString(amount)} ${row.currency} recorded on ${row.doc_number} (${status === 'paid' ? 'paid in full' : `balance ${minorToString(total - newPaid)}`})`, null, null, now);
    return { duplicate: false };
  });
  return { ...result, invoice: await getDocument('invoice', id, user) };
}

// ---------------------------------------------------------------- quotations: accept / reject / convert
export async function respondQuotation(id, decision, user, now = new Date()) {
  await withTx(async (conn) => {
    await lockDoc(conn, id, 'quotation');
    const row = await loadRow(conn, id, 'quotation', user);
    if (row.status !== 'issued') throw conflict('Only an issued quotation can be accepted or rejected.');
    const status = decision === 'accept' ? 'accepted' : 'rejected';
    await conn.query('UPDATE billing_documents SET status=?, responded_at=?, updated_by=?, updated_at=? WHERE id=?', [status, now, user.id, now, id]);
    await logActivity(conn, row.lead_id, user.id, 'document_responded', `Quotation ${row.doc_number} marked ${status}`, null, null, now);
  });
  return getDocument('quotation', id, user);
}

/** Creates a new invoice DRAFT from a quotation (same client snapshot, items and notes) and marks the quotation converted. */
export async function convertQuotation(id, user, now = new Date()) {
  const invoiceId = await withTx(async (conn) => {
    await lockDoc(conn, id, 'quotation');
    const q = await loadRow(conn, id, 'quotation', user);
    if (!['issued', 'accepted'].includes(q.status)) throw conflict('Only an issued or accepted quotation can be converted to an invoice.');
    const [[existing]] = await conn.query("SELECT doc_number FROM billing_documents WHERE source_quotation_id = ? AND status <> 'cancelled' LIMIT 1", [id]);
    if (existing) throw conflict(`Already converted to ${existing.doc_number}.`);
    const lead = await lockLeadFor(conn, q.lead_id, user);
    const items = (await loadItems(conn, id)).map((i) => ({ name: i.name, description: i.description, quantity: clean(i.quantity), unit_price: minorToString(fromDb(i.unit_price)), discount_type: i.discount_type, discount_value: clean(i.discount_value), tax_rate: clean(i.tax_rate) }));
    const newId = await insertDraft(conn, 'invoice', lead, user, {
      client: parseJson(q.client_snapshot), items, currency: q.currency, payment_terms: q.payment_terms, po_number: q.po_number, place_of_supply: q.place_of_supply,
      client_notes: q.client_notes, internal_notes: q.internal_notes, additional_charges: minorToString(fromDb(q.additional_charges)),
      additional_charges_label: q.additional_charges_label, source_quotation_id: id,
    }, now);
    await conn.query("UPDATE billing_documents SET status='converted', updated_by=?, updated_at=? WHERE id=?", [user.id, now, id]);
    return newId;
  });
  return getDocument('invoice', invoiceId, user);
}

/**
 * Copy an existing document into a NEW draft (client, items, discounts, notes), e.g. to re-issue an invoice after the client asks for a discount.
 * The original is left exactly as it was; the copy gets its own number, today's date, no due date and no payments.
 */
export async function duplicateDocument(type, id, user, now = new Date()) {
  const newId = await withTx(async (conn) => {
    await lockDoc(conn, id, type);
    const src = await loadRow(conn, id, type, user);
    if (src.status === 'draft') throw conflict('This is already an editable draft.');
    const lead = await lockLeadFor(conn, src.lead_id, user);
    const items = (await loadItems(conn, id)).map((i) => ({ name: i.name, description: i.description, quantity: clean(i.quantity), unit_price: minorToString(fromDb(i.unit_price)), discount_type: i.discount_type, discount_value: clean(i.discount_value), tax_rate: clean(i.tax_rate) }));
    return insertDraft(conn, type, lead, user, {
      client: parseJson(src.client_snapshot), items, currency: src.currency, payment_terms: src.payment_terms, po_number: src.po_number, place_of_supply: src.place_of_supply,
      client_notes: src.client_notes, internal_notes: src.internal_notes, additional_charges: minorToString(fromDb(src.additional_charges)), additional_charges_label: src.additional_charges_label,
    }, now);
  });
  return getDocument(type, newId, user);
}

// ---------------------------------------------------------------- listing
const PERIODS = ['all', 'today', 'yesterday', 'last7', 'last_month', 'custom'];
const listSchema = z.object({
  q: z.string().trim().max(100).optional(), status: z.string().max(20).optional(), period: z.enum(PERIODS).optional(), followup: z.literal('due').optional(),
  from: dateStr.optional(), to: dateStr.optional(), lead_id: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().optional(), pageSize: z.coerce.number().int().positive().optional(),
});

/** [from, to) in UTC for a "generated on" period, using the business-timezone calendar. */
function periodBounds(period, now, from, to) {
  const today = todayStr(now); const day = (n) => dayStartUtc(addDaysStr(today, n));
  if (period === 'today') return [day(0), day(1)];
  if (period === 'yesterday') return [day(-1), day(0)];
  if (period === 'last7') return [day(-6), day(1)]; // today + the previous 6 days
  if (period === 'last_month') { // the previous calendar month
    const first = DateTime.fromISO(today, { zone: config.tz }).startOf('month');
    return [first.minus({ months: 1 }).toUTC().toJSDate(), first.toUTC().toJSDate()];
  }
  if (period === 'custom') return [from ? dayStartUtc(from) : null, to ? nextDayStartUtc(to) : null];
  return [null, null];
}

export async function listDocuments(type, user, query, now = new Date()) {
  const f = parse(listSchema, query);
  const page = f.page ?? 1; const pageSize = Math.min(100, f.pageSize ?? 20);
  const acc = accessClause(user, 'l'); const today = todayStr(now);
  const base = ['d.doc_type = ?', acc.sql]; const bp = [type, ...acc.params];
  if (f.q) { const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`; base.push('(d.doc_number LIKE ? OR d.client_name LIKE ? OR l.lead_code LIKE ?)'); bp.push(like, like, like); }
  if (f.lead_id) { base.push('d.lead_id = ?'); bp.push(f.lead_id); }
  if (!f.period) { // legacy: filter by the document's own date
    if (f.from) { base.push('d.issue_date >= ?'); bp.push(f.from); }
    if (f.to) { base.push('d.issue_date <= ?'); bp.push(f.to); }
  }
  const statusPart = () => {
    const c = []; const p = [];
    if (f.status === 'overdue') { c.push("d.status IN ('issued','partially_paid') AND d.due_date < ? AND d.total > d.amount_paid"); p.push(today); }
    else if (f.status === 'expired') { c.push("d.status = 'issued' AND d.due_date < ?"); p.push(today); }
    else if (f.status && f.status !== 'all') { c.push('d.status = ?'); p.push(f.status); }
    if (f.followup === 'due') { c.push("d.status IN ('issued','partially_paid') AND d.next_payment_due IS NOT NULL AND d.next_payment_due <= ? AND d.total > d.amount_paid"); p.push(today); }
    return [c, p];
  };
  const periodPart = (period) => {
    const [lo, hi] = periodBounds(period, now, f.from, f.to); const c = []; const p = [];
    if (lo) { c.push('d.created_at >= ?'); p.push(lo); } if (hi) { c.push('d.created_at < ?'); p.push(hi); }
    return [c, p];
  };
  const build = (...parts) => ({ sql: [...base, ...parts.flatMap((x) => x[0])].join(' AND '), params: [...bp, ...parts.flatMap((x) => x[1])] });
  const FROM = 'FROM billing_documents d JOIN leads l ON l.id = d.lead_id';

  const all = build(statusPart(), periodPart(f.period ?? 'all'));
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${FROM} WHERE ${all.sql}`, all.params);
  const [rows] = await pool.query(`${DOC_SELECT} WHERE ${all.sql} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`, [...all.params, pageSize, (page - 1) * pageSize]);

  // chip counts: statuses ignore the status filter; periods ignore the period filter; both honour search
  const sCount = build(periodPart(f.period ?? 'all'));
  const [sc] = await pool.query(`SELECT d.status, COUNT(*) AS n ${FROM} WHERE ${sCount.sql} GROUP BY d.status`, sCount.params);
  const withoutPeriod = build(statusPart());
  const cases = ['today', 'yesterday', 'last7', 'last_month'].map((k) => { const [lo, hi] = periodBounds(k, now); return { k, lo, hi }; });
  const [[pc]] = await pool.query(
    `SELECT COUNT(*) AS \`all\`, ${cases.map((c) => `COALESCE(SUM(d.created_at >= ? AND d.created_at < ?), 0) AS ${c.k}`).join(', ')} ${FROM} WHERE ${withoutPeriod.sql}`,
    [...cases.flatMap((c) => [c.lo, c.hi]), ...withoutPeriod.params]);
  const [[sm]] = await pool.query(
    `SELECT COUNT(*) AS n,
       COALESCE(SUM(CASE WHEN d.status NOT IN ('draft','cancelled') THEN d.total END), 0) AS value,
       COALESCE(SUM(CASE WHEN d.status NOT IN ('draft','cancelled') THEN d.amount_paid END), 0) AS paid,
       COALESCE(SUM(CASE WHEN d.status IN ('issued','partially_paid') THEN d.total - d.amount_paid END), 0) AS due ${FROM} WHERE ${all.sql}`, all.params);
  // how many invoices need a payment follow-up today (shown on the "Follow-up due" chip); honours search but not the other filters
  const [[fu]] = await pool.query(`SELECT COUNT(*) AS n ${FROM} WHERE ${base.join(' AND ')} AND d.status IN ('issued','partially_paid') AND d.next_payment_due IS NOT NULL AND d.next_payment_due <= ? AND d.total > d.amount_paid`, [...bp, today]);
  const followupDue = type === 'invoice' ? fu.n : 0;
  return {
    items: rows.map((r) => { const d = toDto(r); return { id: d.id, type: d.type, doc_number: d.doc_number, status: d.status, lead: d.lead, client_name: r.client_name, issue_date: d.issue_date, due_date: d.due_date, next_payment_due: d.next_payment_due, payment_followup_due: d.payment_followup_due, currency: d.currency, total: d.total, amount_paid: d.amount_paid, outstanding: d.outstanding, is_overdue: d.is_overdue, is_expired: d.is_expired, created_by_name: d.created_by_name, created_at: d.created_at }; }),
    meta: {
      page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
      status_counts: Object.fromEntries(sc.map((r) => [r.status, r.n])),
      period_counts: { all: Number(pc.all), today: Number(pc.today), yesterday: Number(pc.yesterday), last7: Number(pc.last7), last_month: Number(pc.last_month) },
      followup_due: followupDue,
      summary: { count: sm.n, value: minorToString(fromDb(sm.value)), paid: minorToString(fromDb(sm.paid)), due: minorToString(fromDb(sm.due)) },
    },
  };
}

/** Everything issued for one lead (both types) for the lead details screen. */
export async function documentsForLead(leadId, user) {
  const acc = accessClause(user, 'l');
  const [[lead]] = await pool.query(`SELECT l.id FROM leads l WHERE l.id = ? AND ${acc.sql}`, [leadId, ...acc.params]);
  if (!lead) throw notFound('Lead not found');
  const [rows] = await pool.query(`${DOC_SELECT} WHERE d.lead_id = ? ORDER BY d.created_at DESC, d.id DESC`, [leadId]);
  return rows.map((r) => { const d = toDto(r); return { id: d.id, type: d.type, doc_number: d.doc_number, status: d.status, total: d.total, outstanding: d.outstanding, currency: d.currency, is_overdue: d.is_overdue, is_expired: d.is_expired, created_at: d.created_at }; });
}

// ---------------------------------------------------------------- PDF + email
export async function documentPdf(type, id, user) {
  const dto = await getDocument(type, id, user);
  return { buffer: await renderPdf(dto), filename: `${dto.doc_number}.pdf`, dto };
}

const bankText = (issuer) => {
  const b = issuer?.bank ?? ISSUER.bank;
  return b ? ['Payment details:', `Account name: ${b.account_name}`, `Account number: ${b.account_number}`, `IFSC code: ${String(b.ifsc).toUpperCase()}`] : [];
};

export async function emailDefaults(type, id, user) {
  const dto = await getDocument(type, id, user);
  const label = TYPES[type].label;
  const name = dto.client.contact_name || dto.client.company_name || 'there';
  const company = dto.issuer.company_name;
  const lines = [`Dear ${name},`, '', type === 'invoice' ? `Please find attached ${label.toLowerCase()} ${dto.doc_number}${dto.due_date ? `, due on ${dto.due_date}` : ''}.` : `Thank you for your enquiry. Please find attached our ${label.toLowerCase()} ${dto.doc_number}${dto.due_date ? `, valid until ${dto.due_date}` : ''}.`, '', ...(bankText(dto.issuer).length ? [...bankText(dto.issuer), ''] : []), 'Please let us know if you have any questions.', '', 'Regards,', company, dto.issuer.phone, dto.issuer.website];
  return { to: dto.client.email || '', subject: `${label} ${dto.doc_number} from ${company}`, body: lines.join('\n'), configured: emailConfigured() };
}

const emailSchema = z.object({
  to: z.string().trim().email('Enter a valid recipient email address').max(190),
  cc: z.string().trim().email('Enter a valid CC email address').max(190).optional().or(z.literal('').transform(() => undefined)),
  subject: z.string().trim().min(1, 'Subject is required').max(255),
  body: z.string().trim().min(1, 'Message is required').max(10000),
  confirm: z.literal(true, { message: 'Confirm that you want to send this email' }),
});
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function emailDocument(type, id, input, user, now = new Date()) {
  const d = parse(emailSchema, input);
  const row = await loadRow(pool, id, type, user);
  if (['draft', 'cancelled'].includes(row.status)) throw conflict(row.status === 'draft' ? `Issue the ${TYPES[type].label.toLowerCase()} before emailing it.` : 'A cancelled document cannot be emailed.');
  if (!emailConfigured()) throw new HttpError(503, 'Email is not set up on the server yet. Ask the administrator to configure the SMTP settings. You can still download the PDF.', 'EMAIL_NOT_CONFIGURED');
  const { buffer, filename } = await documentPdf(type, id, user); // always rendered from the saved record
  const record = async (status, error, messageId) => {
    await pool.query('INSERT INTO document_emails (document_id, to_email, cc_email, subject, status, error, message_id, sent_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, d.to, d.cc ?? null, d.subject, status, error ? String(error).slice(0, 480) : null, messageId ?? null, user.id, now]);
  };
  try {
    const info = await sendMail({ to: d.to, cc: d.cc, subject: d.subject, text: d.body, html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(d.body)}</div>`, attachments: [{ filename, content: buffer, contentType: 'application/pdf' }] });
    await record('sent', null, info?.messageId);
    await withTx((conn) => logActivity(conn, row.lead_id, user.id, 'document_emailed', `${TYPES[type].label} ${row.doc_number} emailed to ${d.to}`, null, null, now));
  } catch (e) {
    await record('failed', e.message);
    throw new HttpError(502, `The email could not be sent (${String(e.message).slice(0, 200)}). The ${TYPES[type].label.toLowerCase()} is unchanged and you can still download the PDF.`, 'EMAIL_FAILED');
  }
  return getDocument(type, id, user);
}

// ---------------------------------------------------------------- WhatsApp (opens a prepared chat; nothing is sent automatically)
const shareUrl = (token) => `${config.appOrigin.replace(/\/$/, '')}/api/public/documents/${token}/pdf`;

async function ensureShareToken(conn, id) {
  const [[r]] = await conn.query('SELECT share_token FROM billing_documents WHERE id = ?', [id]);
  if (r.share_token) return r.share_token;
  const token = crypto.randomBytes(16).toString('hex'); // 128 bits, unguessable
  await conn.query('UPDATE billing_documents SET share_token = ? WHERE id = ? AND share_token IS NULL', [token, id]);
  const [[again]] = await conn.query('SELECT share_token FROM billing_documents WHERE id = ?', [id]);
  return again.share_token;
}

const sendable = (row, type) => {
  if (['draft', 'cancelled'].includes(row.status)) throw conflict(row.status === 'draft' ? `Issue the ${TYPES[type].label.toLowerCase()} before sending it.` : 'A cancelled document cannot be sent.');
};

/** Phone, ready-to-send message and PDF link for the WhatsApp dialog. Creates the share link on first use. */
export async function whatsappPrepare(type, id, user) {
  const row = await loadRow(pool, id, type, user);
  sendable(row, type);
  const token = await ensureShareToken(pool, id);
  const link = shareUrl(token);
  const client = normalizeClient(parseJson(row.client_snapshot)); const issuer = parseJson(row.issuer_snapshot);
  const total = fromDb(row.total); const outstanding = total - fromDb(row.amount_paid);
  const label = TYPES[type].label.toLowerCase(); const due = dateOnly(row.due_date);
  const lines = [
    `Hello ${client.contact_name || client.company_name || 'there'},`, '',
    type === 'invoice'
      ? `Please find your ${label} ${row.doc_number} from ${issuer.company_name}${outstanding > 0 ? ` — amount due ${formatMoney(outstanding, row.currency)}` : ` for ${formatMoney(total, row.currency)}`}${due ? `, due on ${due}` : ''}.`
      : `Thank you for your enquiry. Please find our ${label} ${row.doc_number} from ${issuer.company_name} for ${formatMoney(total, row.currency)}${due ? `, valid until ${due}` : ''}.`,
    '', `View / download the PDF: ${link}`, '', ...(bankText(issuer).length ? [...bankText(issuer), ''] : []), 'Please let us know if you have any questions.', 'Thank you!',
  ];
  return { phone: client.phone || client.alt_phone || '', message: lines.join('\n'), link };
}

const waSchema = z.object({ to: z.string().trim().min(6, 'Enter the WhatsApp number').max(30) });
/** Records that WhatsApp was opened for this document (history + lead activity). It does not claim delivery. */
export async function whatsappOpened(type, id, input, user, now = new Date()) {
  const d = parse(waSchema, input);
  const row = await loadRow(pool, id, type, user);
  sendable(row, type);
  await pool.query("INSERT INTO document_emails (document_id, channel, to_email, subject, status, sent_by, created_at) VALUES (?, 'whatsapp', ?, ?, 'opened', ?, ?)",
    [id, d.to, `WhatsApp message for ${row.doc_number}`, user.id, now]);
  await withTx((conn) => logActivity(conn, row.lead_id, user.id, 'document_whatsapp', `${TYPES[type].label} ${row.doc_number} opened in WhatsApp for ${d.to}`, null, null, now));
  return getDocument(type, id, user);
}

/** Public, read-only PDF for the unguessable link. Only issued documents; drafts and cancelled ones answer 404. */
export async function documentPdfByToken(token) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw notFound('Not found');
  const [[row]] = await pool.query(`${DOC_SELECT} WHERE d.share_token = ? AND d.status NOT IN ('draft','cancelled')`, [token]);
  if (!row) throw notFound('Not found');
  const items = await loadItems(pool, row.id);
  return { buffer: await renderPdf(toDto(row, items)), filename: `${row.doc_number}.pdf` };
}

// ---------------------------------------------------------------- payment proofs (screenshots / PDFs from the client)
async function loadPayment(conn, id, pid) {
  const [[p]] = await conn.query('SELECT * FROM invoice_payments WHERE id = ? AND document_id = ?', [pid, id]);
  if (!p) throw notFound('Payment not found');
  return p;
}

export async function addPaymentProofs(id, pid, files, user, now = new Date()) {
  if (!canEdit(user)) throw forbidden('Your role cannot attach payment proof.');
  if (!files?.length) throw badRequest('Choose at least one file');
  const row = await loadRow(pool, id, 'invoice', user);
  const payment = await loadPayment(pool, id, pid);
  const stored = [];
  try {
    for (const f of files) {
      const r = await storeProof(f);
      if (r.error) throw badRequest(r.error);
      stored.push(r);
    }
    await withTx(async (conn) => {
      for (const r of stored) {
        await conn.query('INSERT INTO payment_attachments (payment_id, document_id, original_name, stored_name, mime, size_bytes, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)', [pid, id, r.name, r.stored, r.mime, r.size, user.id, now]);
      }
      await logActivity(conn, row.lead_id, user.id, 'payment_proof_added', `${stored.length} proof file${stored.length === 1 ? '' : 's'} attached to the ${minorToString(fromDb(payment.amount))} payment on ${row.doc_number}`, null, null, now);
    });
  } catch (e) {
    await Promise.all(stored.map((r) => removeStored(r.stored))); // never leave orphan files behind
    throw e;
  }
  return getDocument('invoice', id, user);
}

/** Path + type of a proof file, after the usual per-lead access check. */
export async function proofFile(id, pid, aid, user) {
  await loadRow(pool, id, 'invoice', user);
  const [[a]] = await pool.query('SELECT * FROM payment_attachments WHERE id = ? AND payment_id = ? AND document_id = ?', [aid, pid, id]);
  if (!a) throw notFound('File not found');
  return { file: proofPath(a.stored_name), mime: a.mime, name: a.original_name };
}

export async function deleteProof(id, pid, aid, user, now = new Date()) {
  if (!canEdit(user)) throw forbidden('Your role cannot remove payment proof.');
  const row = await loadRow(pool, id, 'invoice', user);
  const [[a]] = await pool.query('SELECT * FROM payment_attachments WHERE id = ? AND payment_id = ? AND document_id = ?', [aid, pid, id]);
  if (!a) throw notFound('File not found');
  await withTx(async (conn) => {
    await conn.query('DELETE FROM payment_attachments WHERE id = ?', [aid]);
    await logActivity(conn, row.lead_id, user.id, 'payment_proof_removed', `A proof file ("${a.original_name}") was removed from a payment on ${row.doc_number}`, null, null, now);
  });
  await removeStored(a.stored_name);
  return getDocument('invoice', id, user);
}

// ---------------------------------------------------------------- next payment due date (collection follow-up)
export async function setNextPaymentDue(id, input, user, now = new Date()) {
  const { date } = parse(z.object({ date: dateStr.nullable() }), input);
  await withTx(async (conn) => {
    await lockDoc(conn, id, 'invoice');
    const row = await loadRow(conn, id, 'invoice', user);
    if (!PAYABLE.includes(row.status)) throw conflict(row.status === 'paid' ? 'This invoice is fully paid.' : `A payment date cannot be set on a ${row.status} invoice.`);
    if (date && date < todayStr(now)) throw badRequest('Choose today or a future date.');
    const before = dateOnly(row.next_payment_due);
    if (before === date) return;
    await conn.query('UPDATE billing_documents SET next_payment_due = ?, updated_by = ?, updated_at = ? WHERE id = ?', [date, user.id, now, id]);
    await logActivity(conn, row.lead_id, user.id, 'payment_due_set', date ? `Next payment for ${row.doc_number} expected on ${date}${before ? ` (was ${before})` : ''}` : `Next payment date for ${row.doc_number} cleared`, before ? { next_payment_due: before } : null, date ? { next_payment_due: date } : null, now);
  });
  return getDocument('invoice', id, user);
}

// ---------------------------------------------------------------- quotation status (manual)
export async function setQuotationStatus(id, input, user, now = new Date()) {
  const { status } = parse(z.object({ status: z.enum(['issued', 'accepted', 'rejected']) }), input);
  await withTx(async (conn) => {
    await lockDoc(conn, id, 'quotation');
    const row = await loadRow(conn, id, 'quotation', user);
    if (!['issued', 'accepted', 'rejected'].includes(row.status)) throw conflict(`The status of a ${row.status} quotation cannot be changed here.`);
    if (row.status === status) return;
    await conn.query('UPDATE billing_documents SET status = ?, responded_at = ?, updated_by = ?, updated_at = ? WHERE id = ?', [status, status === 'issued' ? null : now, user.id, now, id]);
    await logActivity(conn, row.lead_id, user.id, 'document_responded', `Quotation ${row.doc_number} status changed: ${row.status} → ${status}`, null, null, now);
  });
  return getDocument('quotation', id, user);
}
