import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { resetDb, makeUsers, startServer, Client, pool } from './helpers.js';
const { setTransport } = await import('../src/services/mailer.js');
const { ISSUER } = await import('../src/config/issuer.js');

let srv; let U; let admin; let a1; let a2; let t1;
const sent = []; let failNext = false;
const item = (over = {}) => ({ name: 'Website development', description: 'Custom site', quantity: '1', unit_price: '10000', ...over });
const text = async (buf) => (await pdfParse(buf)).text.replace(/\s+/g, ' ');
const mkLead = async (c, extra = {}) => (await c.req('POST', '/api/leads', { phone: `98${Math.floor(10000000 + Math.random() * 89999999)}`, nickname: 'Ridham', business_name: 'PR Enterprises', email: 'ridham@example.com', requirement: 'E-commerce', budget: '15000', ...extra })).body.data;
const create = (c, type, body, headers) => c.req('POST', `/api/${type}`, body, headers);
const pdfOf = async (c, path) => { const res = await fetch(srv.base + path, { headers: { cookie: c.cookie } }); return { res, buf: Buffer.from(await res.arrayBuffer()) }; };

before(async () => {
  await resetDb(); U = await makeUsers({ telecaller: true }); srv = await startServer();
  admin = new Client(srv.base); a1 = new Client(srv.base); a2 = new Client(srv.base); t1 = new Client(srv.base);
  await admin.login('admin@t.test', 'password-admin-1'); await a1.login('a1@t.test', 'password-agent-1'); await a2.login('a2@t.test', 'password-agent-2'); await t1.login('t1@t.test', 'password-tele-1');
  setTransport({ sendMail: async (msg) => { if (failNext) { failNext = false; throw new Error('SMTP connection refused'); } sent.push(msg); return { messageId: '<test@piweb>' }; } });
});
after(async () => { setTransport(null); await srv.close(); await pool.end(); });

// ------------------------------------------------------------------ numbering
test('numbering: first, second, third documents keep the lead number (incl. leading zeros); quotations use QT-', async () => {
  const lead = await mkLead(admin);
  assert.match(lead.lead_code, /^LD-\d{3,}$/);
  const n = [];
  for (let i = 0; i < 3; i++) n.push((await create(admin, 'invoices', { lead_id: lead.id })).body.data.doc_number);
  assert.deepEqual(n, [`INV-GN-${lead.lead_code}`, `INV-GN-${lead.lead_code}-02`, `INV-GN-${lead.lead_code}-03`]);
  const q = [(await create(admin, 'quotations', { lead_id: lead.id })).body.data.doc_number, (await create(admin, 'quotations', { lead_id: lead.id })).body.data.doc_number];
  assert.deepEqual(q, [`QT-GN-${lead.lead_code}`, `QT-GN-${lead.lead_code}-02`], 'quotation sequence is independent of invoices');
  const other = await mkLead(admin);
  assert.equal((await create(admin, 'invoices', { lead_id: other.id })).body.data.doc_number, `INV-GN-${other.lead_code}`, 'each lead starts at its own first number');
});

test('numbering: multiple drafts, number is permanent and cannot be set by the client', async () => {
  const lead = await mkLead(admin);
  const d1 = (await create(admin, 'invoices', { lead_id: lead.id })).body.data; const d2 = (await create(admin, 'invoices', { lead_id: lead.id })).body.data;
  assert.equal(d1.status, 'draft'); assert.equal(d2.status, 'draft'); assert.notEqual(d1.doc_number, d2.doc_number);
  const upd = await admin.req('PUT', `/api/invoices/${d2.id}`, { doc_number: 'INV-HACKED', status: 'paid', total: '1.00', po_number: 'PO-1', items: [item()] });
  assert.equal(upd.status, 200); assert.equal(upd.body.data.doc_number, d2.doc_number); assert.equal(upd.body.data.status, 'draft'); assert.equal(upd.body.data.total, '10000.00');
  const again = (await admin.req('PUT', `/api/invoices/${d2.id}`, { po_number: 'PO-2' })).body.data;
  assert.equal(again.doc_number, d2.doc_number, 'saving repeatedly never changes or duplicates the number');
  const [[c]] = await pool.query('SELECT COUNT(*) n FROM billing_documents WHERE lead_id = ? AND doc_type = ?', [lead.id, 'invoice']);
  assert.equal(c.n, 2);
});

test('numbering: concurrent creation never produces duplicates (10 parallel requests, one lead)', async () => {
  const lead = await mkLead(admin);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => create(i % 2 ? a1 : admin, 'invoices', { lead_id: lead.id })));
  assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join());
  const numbers = results.map((r) => r.body.data.doc_number);
  assert.equal(new Set(numbers).size, 10);
  const expected = [`INV-GN-${lead.lead_code}`, ...Array.from({ length: 9 }, (_, i) => `INV-GN-${lead.lead_code}-${String(i + 2).padStart(2, '0')}`)];
  assert.deepEqual([...numbers].sort(), expected.sort());
});

test('numbering: double submit with the same Idempotency-Key creates one draft; cancelled numbers are never reused', async () => {
  const lead = await mkLead(admin);
  const key = 'abcDEF123456xyz';
  const [r1, r2] = await Promise.all([create(admin, 'invoices', { lead_id: lead.id }, { 'Idempotency-Key': key }), create(admin, 'invoices', { lead_id: lead.id }, { 'Idempotency-Key': key })]);
  assert.equal(r1.body.data.id, r2.body.data.id);
  const third = (await create(admin, 'invoices', { lead_id: lead.id })).body.data; // -02
  const fourth = (await create(admin, 'invoices', { lead_id: lead.id })).body.data; // -03
  assert.equal((await admin.req('POST', `/api/invoices/${fourth.id}/cancel`, { confirm: true, reason: 'Created by mistake' })).body.data.status, 'cancelled');
  const next = (await create(admin, 'invoices', { lead_id: lead.id })).body.data;
  assert.equal(next.doc_number, `INV-GN-${lead.lead_code}-04`, 'the cancelled -03 is retained and skipped');
  const [[c]] = await pool.query("SELECT COUNT(*) n FROM billing_documents WHERE lead_id = ? AND doc_type = 'invoice'", [lead.id]);
  assert.equal(c.n, 4); assert.ok(third.doc_number.endsWith('-02'));
});

test('numbering: a missing or malformed lead number blocks creation with a clear error', async () => {
  const lead = await mkLead(admin);
  await pool.query('UPDATE leads SET lead_code = NULL WHERE id = ?', [lead.id]);
  const r = await create(admin, 'invoices', { lead_id: lead.id });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'INVALID_LEAD_NUMBER');
  await pool.query("UPDATE leads SET lead_code = 'garbage code!' WHERE id = ?", [lead.id]);
  assert.equal((await create(admin, 'invoices', { lead_id: lead.id })).status, 422);
  const pre = await admin.req('GET', `/api/invoices/prefill/${lead.id}`);
  assert.ok(pre.body.data.error && pre.body.data.expected_number === null);
});

// ------------------------------------------------------------------ client + issuer
test('prefill from the lead; every client field optional; edits stay on the invoice and never touch the lead', async () => {
  const lead = await mkLead(admin, { nickname: 'Ridham', business_name: 'PR Enterprises', email: 'r@pr.example', requirement: 'E-commerce', budget: 'Less than 15000' });
  const pre = (await admin.req('GET', `/api/invoices/prefill/${lead.id}`)).body.data;
  assert.equal(pre.client.company_name, 'PR Enterprises'); assert.equal(pre.client.contact_name, 'Ridham'); assert.equal(pre.client.email, 'r@pr.example');
  assert.equal(pre.client.phone, lead.phone); assert.match(pre.client.additional_details, /Requirement: E-commerce\nBudget: Less than 15000/);
  assert.equal(pre.client.gstin, null); assert.equal(pre.client.address, null);
  assert.equal(pre.expected_number, `INV-GN-${lead.lead_code}`);

  const empty = (await create(admin, 'invoices', { lead_id: lead.id, client: {} })).body.data;       // nothing required
  assert.ok(Object.values(empty.client).every((v) => v === null));
  const doc = (await create(admin, 'invoices', { lead_id: lead.id })).body.data;                          // defaults come from the lead
  assert.equal(doc.client.company_name, 'PR Enterprises');
  const edited = (await admin.req('PUT', `/api/invoices/${doc.id}`, { client: { company_name: 'Changed Co', address: 'Line 1\nLine 2', gstin: 'X', additional_details: 'odd details' } })).body.data;
  assert.equal(edited.client.company_name, 'Changed Co'); assert.equal(edited.client.address, 'Line 1\nLine 2'); assert.equal(edited.client.email, null, 'unsupplied fields are empty, not inherited');
  const leadAfter = (await admin.req('GET', `/api/leads/${lead.id}`)).body.data;
  assert.equal(leadAfter.business_name, 'PR Enterprises', 'the lead is untouched by invoice edits');
  // and the other way round: lead edits do not rewrite the saved snapshot
  await admin.req('PATCH', `/api/leads/${lead.id}`, { business_name: 'Totally Different Ltd', email: 'new@x.com' });
  const snap = (await admin.req('GET', `/api/invoices/${doc.id}`)).body.data;
  assert.equal(snap.client.company_name, 'Changed Co'); assert.equal(snap.client.email, null);
  const fresh = (await create(admin, 'invoices', { lead_id: lead.id })).body.data;
  assert.equal(fresh.client.company_name, 'Totally Different Ltd', 'a NEW invoice picks up the current lead data');
});

test('issuer: exact fixed details with both addresses; the API cannot change them; snapshots are per document', async () => {
  const lead = await mkLead(admin);
  const doc = (await create(admin, 'invoices', { lead_id: lead.id, issuer: { company_name: 'Evil Corp', cin: 'X' } })).body.data;
  assert.equal(doc.issuer.company_name, ISSUER.company_name); assert.equal(doc.issuer.cin, 'U62010RJ2025PTC102136');
  assert.deepEqual(doc.issuer.headquarters.lines, ['Ganesh Nagar, Jaipur, Rajasthan, India']); assert.equal(doc.issuer.headquarters.label, 'Headquarters');
  assert.deepEqual(doc.issuer.office.lines, ['33, Golf Course Extension Road', 'Sector 50', 'Gurugram', 'Haryana - 122101', 'India']); assert.equal(doc.issuer.office.label, 'Office Address');
  assert.equal(doc.issuer.phone, '7296003817'); assert.equal(doc.issuer.website, 'https://www.piwebtechnology.com/landing-page');
  assert.deepEqual(doc.issuer, JSON.parse(JSON.stringify(ISSUER)));
  const upd = (await admin.req('PUT', `/api/invoices/${doc.id}`, { issuer: { company_name: 'Hacked' }, items: [item()] })).body.data;
  assert.equal(upd.issuer.company_name, ISSUER.company_name);
  const pre = (await admin.req('GET', `/api/invoices/prefill/${lead.id}`)).body.data;
  assert.deepEqual(pre.issuer, JSON.parse(JSON.stringify(ISSUER)));
  // historic documents keep their own snapshot even if the stored copy differs from the current config
  await pool.query("UPDATE billing_documents SET issuer_snapshot = JSON_SET(issuer_snapshot, '$.phone', '1111111111') WHERE id = ?", [doc.id]);
  assert.equal((await admin.req('GET', `/api/invoices/${doc.id}`)).body.data.issuer.phone, '1111111111');
  assert.ok(!('nickname' in doc.issuer));
});

// ------------------------------------------------------------------ lifecycle, calculations
test('lifecycle: draft → issue (explicit confirmation, validated) → locked; issuing sends no email; lead status untouched', async () => {
  const lead = await mkLead(admin);
  const before = (await admin.req('GET', `/api/leads/${lead.id}`)).body.data.status.id;
  const doc = (await create(admin, 'invoices', { lead_id: lead.id })).body.data;
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/issue`, { confirm: true })).status, 400, 'needs line items');
  await admin.req('PUT', `/api/invoices/${doc.id}`, { items: [item()], due_date: '2026-12-31' });
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/issue`, {})).status, 400, 'needs explicit confirmation');
  const mails = sent.length;
  const issued = await admin.req('POST', `/api/invoices/${doc.id}/issue`, { confirm: true });
  assert.equal(issued.status, 200); assert.equal(issued.body.data.status, 'issued'); assert.ok(issued.body.data.issued_at);
  assert.equal(sent.length, mails, 'issuing never emails');
  assert.equal((await admin.req('PUT', `/api/invoices/${doc.id}`, { po_number: 'X' })).status, 409, 'issued invoices are locked');
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/issue`, { confirm: true })).status, 409);
  assert.equal((await admin.req('PATCH', `/api/invoices/${doc.id}/internal-notes`, { internal_notes: 'chased on phone' })).body.data.internal_notes, 'chased on phone', 'only private notes remain editable');
  assert.equal((await admin.req('GET', `/api/leads/${lead.id}`)).body.data.status.id, before);
  const types = (await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data.map((a) => a.action_type);
  assert.ok(types.includes('document_created') && types.includes('document_issued'));
});

test('calculations: line items, percent/flat discount, optional tax, additional charges — preview equals saved totals', async () => {
  const lead = await mkLead(admin);
  const items = [
    item({ name: 'A', quantity: '2', unit_price: '1000', discount_type: 'percent', discount_value: '10', tax_rate: '18' }),
    item({ name: 'B', quantity: '1', unit_price: '250.50' }),
    item({ name: 'C', quantity: '3', unit_price: '99.99', discount_type: 'amount', discount_value: '50', tax_rate: '5' }),
  ];
  const body = { items, additional_charges: '100', additional_charges_label: 'Setup fee' };
  const calc = (await admin.req('POST', '/api/invoices/calculate', body)).body.data;
  const doc = (await create(admin, 'invoices', { lead_id: lead.id, ...body })).body.data;
  assert.equal(doc.subtotal, '2550.47'); assert.equal(doc.discount_total, '250.00'); assert.equal(doc.taxable_amount, '2300.47');
  assert.equal(doc.tax_amount, '336.50'); assert.equal(doc.additional_charges, '100.00'); assert.equal(doc.total, '2736.97'); // 1800*18% + 249.97*5%=12.50
  for (const k of ['subtotal', 'discount_total', 'taxable_amount', 'tax_amount', 'additional_charges', 'total']) assert.equal(calc.totals[k], doc[k], k);
  assert.deepEqual(doc.items.map((i) => i.line_total), calc.items.map((i) => i.line_total));
  assert.equal(doc.outstanding, doc.total); assert.equal(doc.payment_status, 'unpaid');
  // tax is optional and never applied automatically
  const plain = (await create(admin, 'invoices', { lead_id: lead.id, items: [item({ unit_price: '500' })] })).body.data;
  assert.equal(plain.tax_amount, '0.00'); assert.equal(plain.total, '500.00');
  // bad input is rejected with a clear message
  assert.equal((await create(admin, 'invoices', { lead_id: lead.id, items: [item({ unit_price: '1.234' })] })).status, 400);
  assert.equal((await create(admin, 'invoices', { lead_id: lead.id, items: [item({ quantity: '0' })] })).status, 400);
  const live = (await admin.req('POST', '/api/invoices/calculate', { items: [item({ quantity: 'abc' }), item()] })).body.data;
  assert.ok(live.items[0].error && live.items[1].line_total === '10000.00', 'the live preview flags a bad line but keeps calculating');
});

test('cancellation keeps the record; permissions: agents and admins change documents, payments and status', async () => {
  const lead = await mkLead(admin);
  const d = (await create(a1, 'invoices', { lead_id: lead.id, items: [item()] })).body.data; // agent creates (unassigned lead is visible to agents)
  assert.equal((await a1.req('POST', `/api/invoices/${d.id}/issue`, { confirm: true })).status, 200);
  const other = await issuedInvoice('1000');
  assert.equal((await a1.req('POST', `/api/invoices/${other.id}/payments`, { amount: '100' })).status, 201, 'agents can record payments');
  const d2 = await issuedInvoice('1000');
  assert.equal((await a1.req('POST', `/api/invoices/${d2.id}/cancel`, { confirm: true, reason: 'agent cancels an issued document' })).status, 200, 'agents can cancel issued documents');
  const draft2 = (await create(a1, 'invoices', { lead_id: lead.id })).body.data;
  assert.equal((await a2.req('POST', `/api/invoices/${draft2.id}/cancel`, { confirm: true, reason: 'x' })).status, 403, "another agent cannot cancel someone else's draft");
  assert.equal((await a1.req('POST', `/api/invoices/${draft2.id}/cancel`, { confirm: true, reason: 'wrong client' })).status, 200, 'the author can');
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/cancel`, { confirm: true })).status, 400, 'a reason is required');
  const c = await admin.req('POST', `/api/invoices/${d.id}/cancel`, { confirm: true, reason: 'Client withdrew' });
  assert.equal(c.body.data.status, 'cancelled'); assert.equal(c.body.data.cancel_reason, 'Client withdrew'); assert.equal(c.body.data.doc_number, d.doc_number);
  assert.equal((await admin.req('GET', `/api/invoices/${d.id}`)).status, 200, 'retained and viewable');
  assert.equal((await admin.req('PUT', `/api/invoices/${d.id}`, { po_number: 'x' })).status, 409);
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/cancel`, { confirm: true, reason: 'again' })).status, 409);
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '1' })).status, 409, 'no payments on a cancelled invoice');
  // there is no delete endpoint at all
  assert.equal((await admin.req('DELETE', `/api/invoices/${d.id}`)).status, 404);
  assert.equal((await new Client(srv.base).req('GET', `/api/invoices/${d.id}`)).status, 401);
});

test('access: an agent cannot see or create documents for a lead they cannot access', async () => {
  const lead = await mkLead(admin, { assigned_to: U.a1.id });
  const doc = (await create(admin, 'invoices', { lead_id: lead.id, items: [item()] })).body.data;
  assert.equal((await a2.req('GET', `/api/invoices/${doc.id}`)).status, 404);
  assert.equal((await a2.req('GET', `/api/invoices/${doc.id}/pdf`)).status, 404);
  assert.equal((await create(a2, 'invoices', { lead_id: lead.id })).status, 404);
  assert.equal((await a2.req('GET', `/api/billing/by-lead/${lead.id}`)).status, 404);
  assert.ok(!(await a2.req('GET', '/api/invoices?pageSize=100')).body.data.some((x) => x.id === doc.id));
  assert.equal((await a1.req('GET', `/api/invoices/${doc.id}`)).status, 200);
  const removedLead = await mkLead(admin); await admin.req('POST', `/api/leads/${removedLead.id}/remove`, { reason: 'dup' });
  assert.equal((await create(admin, 'invoices', { lead_id: removedLead.id })).status, 409, 'no documents for removed leads');
});

// ------------------------------------------------------------------ payments
async function issuedInvoice(total = '1000', due = null, issue = undefined) {
  const lead = await mkLead(admin);
  const d = (await create(admin, 'invoices', { lead_id: lead.id, items: [item({ unit_price: total })], due_date: due, issue_date: issue })).body.data;
  await admin.req('POST', `/api/invoices/${d.id}/issue`, { confirm: true });
  return d;
}

test('payments: partial → partially paid, full → paid; overpayment, drafts and bad amounts rejected; invoice amounts never change', async () => {
  const draft = (await create(admin, 'invoices', { lead_id: (await mkLead(admin)).id, items: [item()] })).body.data;
  assert.equal((await admin.req('POST', `/api/invoices/${draft.id}/payments`, { amount: '10' })).status, 409, 'issue first');
  const d = await issuedInvoice('1000');
  const p1 = await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '400', method: 'UPI', reference: 'UTR123', notes: 'advance' });
  assert.equal(p1.status, 201); assert.equal(p1.body.data.invoice.status, 'partially_paid'); assert.equal(p1.body.data.invoice.amount_paid, '400.00');
  assert.equal(p1.body.data.invoice.outstanding, '600.00'); assert.equal(p1.body.data.invoice.payment_status, 'partial'); assert.equal(p1.body.data.invoice.total, '1000.00');
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '600.01' })).status, 400, 'cannot exceed the balance');
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '0' })).status, 400);
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '-5' })).status, 400);
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '10', paid_on: '2999-01-01' })).status, 400);
  const p2 = await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '600', paid_on: '2026-10-01' });
  assert.equal(p2.body.data.invoice.status, 'paid'); assert.equal(p2.body.data.invoice.outstanding, '0.00'); assert.equal(p2.body.data.invoice.payment_status, 'paid');
  assert.equal(p2.body.data.invoice.payments.length, 2); assert.equal(p2.body.data.invoice.payments.find((x) => x.reference === 'UTR123').method, 'UPI');
  assert.deepEqual(p2.body.data.invoice.payments.map((x) => x.paid_on), ['2026-10-01', new Date().toISOString().slice(0, 10)], 'listed by payment date');
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '1' })).status, 409, 'nothing left to pay');
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/cancel`, { confirm: true, reason: 'x' })).status, 409, 'paid invoices cannot be cancelled');
  assert.deepEqual((await admin.req('GET', `/api/invoices/${d.id}`)).body.data.items.map((i) => i.line_total), ['1000.00'], 'payments never alter line items');
  assert.ok((await admin.req('GET', `/api/leads/${d.lead.id}/activities`)).body.data.some((a) => a.action_type === 'payment_recorded'));
});

test('payments: duplicate submissions (same key, parallel double click, identical retry) record one payment', async () => {
  const d = await issuedInvoice('1000');
  const key = 'pay-key-0001234';
  const [a, b] = await Promise.all([admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '100', idempotency_key: key }), admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '100', idempotency_key: key })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  const again = await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '100' }, { 'Idempotency-Key': key });
  assert.equal(again.status, 200); assert.equal(again.body.data.duplicate, true);
  let inv = (await admin.req('GET', `/api/invoices/${d.id}`)).body.data;
  assert.equal(inv.payments.length, 1); assert.equal(inv.amount_paid, '100.00');
  // no key at all: an identical payment moments later is treated as a double click
  await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '50', method: 'Cash', paid_on: '2026-10-02' });
  const dup = await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '50', method: 'Cash', paid_on: '2026-10-02' });
  assert.equal(dup.body.data.duplicate, true);
  inv = (await admin.req('GET', `/api/invoices/${d.id}`)).body.data;
  assert.equal(inv.payments.length, 2); assert.equal(inv.amount_paid, '150.00'); assert.equal(inv.status, 'partially_paid');
});

test('overdue is derived from the due date and the outstanding balance, never for fully paid invoices', async () => {
  const d = await issuedInvoice('1000', '2020-01-01', '2019-12-01');
  assert.equal((await admin.req('GET', `/api/invoices/${d.id}`)).body.data.is_overdue, true);
  assert.ok((await admin.req('GET', '/api/invoices?status=overdue&pageSize=100')).body.data.some((x) => x.id === d.id));
  await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '1000' });
  assert.equal((await admin.req('GET', `/api/invoices/${d.id}`)).body.data.is_overdue, false);
  assert.ok(!(await admin.req('GET', '/api/invoices?status=overdue&pageSize=100')).body.data.some((x) => x.id === d.id));
  assert.equal((await create(admin, 'invoices', { lead_id: d.lead.id, issue_date: '2026-10-10', due_date: '2026-10-01' })).status, 400, 'due date cannot precede the invoice date');
});

// ------------------------------------------------------------------ quotations
test('quotations: issue → accept/reject; convert creates an invoice DRAFT with the same client and items, once', async () => {
  const lead = await mkLead(admin);
  const q = (await create(admin, 'quotations', { lead_id: lead.id, due_date: '2026-12-31', client: { company_name: 'Quote Co', gstin: 'G1' }, items: [item({ unit_price: '5000', tax_rate: '18' })], client_notes: 'Valid for 30 days' })).body.data;
  assert.equal(q.type, 'quotation'); assert.equal(q.payment_status, null); assert.equal(q.total, '5900.00');
  assert.equal((await admin.req('POST', `/api/quotations/${q.id}/accept`)).status, 409, 'must be issued first');
  assert.equal((await admin.req('POST', `/api/quotations/${q.id}/convert`)).status, 409);
  assert.equal((await admin.req('POST', `/api/quotations/${q.id}/payments`, { amount: '1' })).status, 404, 'quotations have no payments');
  await admin.req('POST', `/api/quotations/${q.id}/issue`, { confirm: true });
  assert.equal((await admin.req('POST', `/api/quotations/${q.id}/accept`)).body.data.status, 'accepted');
  const conv = await admin.req('POST', `/api/quotations/${q.id}/convert`);
  assert.equal(conv.status, 201); const inv = conv.body.data;
  assert.equal(inv.type, 'invoice'); assert.equal(inv.status, 'draft'); assert.equal(inv.doc_number, `INV-GN-${lead.lead_code}`);
  assert.equal(inv.client.company_name, 'Quote Co'); assert.equal(inv.client.gstin, 'G1'); assert.equal(inv.total, '5900.00'); assert.equal(inv.client_notes, 'Valid for 30 days');
  assert.equal(inv.source_quotation.doc_number, q.doc_number);
  const q2 = (await admin.req('GET', `/api/quotations/${q.id}`)).body.data;
  assert.equal(q2.status, 'converted'); assert.equal(q2.converted_invoice.doc_number, inv.doc_number);
  assert.equal((await admin.req('POST', `/api/quotations/${q.id}/convert`)).status, 409, 'converted only once');
  const q3 = (await create(admin, 'quotations', { lead_id: lead.id, items: [item()] })).body.data;
  await admin.req('POST', `/api/quotations/${q3.id}/issue`, { confirm: true });
  assert.equal((await admin.req('POST', `/api/quotations/${q3.id}/reject`)).body.data.status, 'rejected');
  assert.equal((await admin.req('POST', `/api/quotations/${q3.id}/convert`)).status, 409, 'rejected quotations cannot be converted');
});

// ------------------------------------------------------------------ PDF
test('PDF: rendered from the saved record with every required fact, internal notes excluded', async () => {
  const lead = await mkLead(admin);
  const doc = (await create(admin, 'invoices', { lead_id: lead.id, due_date: '2026-12-31', payment_terms: 'Net 15', client_notes: 'Thanks for choosing us', internal_notes: 'TOP-SECRET-INTERNAL',
    client: { company_name: 'PR Enterprises', contact_name: 'Ridham', email: 'r@pr.example', city: 'Jaipur', gstin: '08AAAAA0000A1Z5', notes: 'CLIENT-PRIVATE-NOTE' },
    items: [item({ name: 'E-commerce build', description: 'Storefront and checkout', quantity: '2', unit_price: '12345.50', discount_type: 'percent', discount_value: '10', tax_rate: '18' })] })).body.data;
  const draftPdf = await pdfOf(admin, `/api/invoices/${doc.id}/pdf`);
  assert.equal(draftPdf.res.status, 200); assert.equal(draftPdf.res.headers.get('content-type'), 'application/pdf');
  assert.match(draftPdf.res.headers.get('content-disposition'), new RegExp(`inline; filename="${doc.doc_number}.pdf"`));
  assert.equal(draftPdf.buf.subarray(0, 5).toString(), '%PDF-');
  await admin.req('POST', `/api/invoices/${doc.id}/issue`, { confirm: true });
  const { res, buf } = await pdfOf(admin, `/api/invoices/${doc.id}/pdf?download=1`);
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
  const t = await text(buf);
  for (const must of [ISSUER.company_name, 'U62010RJ2025PTC102136', 'Headquarters', 'Ganesh Nagar, Jaipur, Rajasthan, India', 'Office Address', '33, Golf Course Extension Road', 'Sector 50', 'Gurugram', 'Haryana - 122101', '7296003817', 'https://www.piwebtechnology.com/landing-page',
    doc.doc_number, 'INVOICE', 'PR Enterprises', 'Ridham', 'r@pr.example', '08AAAAA0000A1Z5', 'E-commerce build', 'Storefront and checkout', 'Net 15', 'Thanks for choosing us', '31 Dec 2026']) assert.ok(t.includes(must), `PDF should contain "${must}"`);
  const dto = (await admin.req('GET', `/api/invoices/${doc.id}`)).body.data;
  const inr = (s) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(s));
  assert.ok(t.includes(inr(dto.total)), `PDF shows the saved total ${inr(dto.total)}`); assert.ok(t.includes(inr(dto.tax_amount))); assert.ok(t.includes('Rupees'));
  assert.ok(!t.includes('TOP-SECRET-INTERNAL') && !t.includes('CLIENT-PRIVATE-NOTE'), 'internal notes never reach the PDF');
  assert.ok(t.includes('Piweb'), 'brand watermark');
  for (const status of ['DRAFT', 'ISSUED', 'PAID', 'CANCELLED', 'OVERDUE', 'PARTIALLY PAID']) assert.ok(!t.includes(status), `no workflow status on the document (${status})`);
  assert.ok(t.indexOf('Office Address') < t.indexOf('Headquarters'), 'Office Address comes before Headquarters');
  assert.ok(t.includes('Amount Due') && t.includes('Authorised Signatory') && t.includes('Thank you for your business'));
  // paid + balance lines appear once payments exist
  await admin.req('POST', `/api/invoices/${doc.id}/payments`, { amount: '1000' });
  const t2 = await text((await pdfOf(admin, `/api/invoices/${doc.id}/pdf`)).buf);
  assert.ok(t2.includes('Balance due') && t2.includes('Amount paid') && !t2.includes('PARTIALLY PAID'));
});

test('PDF: many items flow across pages with the header repeated, page numbers and wrapped descriptions', async () => {
  const lead = await mkLead(admin);
  const long = 'A very long description that has to wrap over several lines inside the narrow description column so that the row grows taller than a normal row. '.repeat(3);
  const items = Array.from({ length: 45 }, (_, i) => item({ name: `Service item ${i + 1}`, description: i % 4 === 0 ? long : null, quantity: String(1 + (i % 3)), unit_price: String(500 + i), tax_rate: i % 2 ? '18' : null }));
  const doc = (await create(admin, 'invoices', { lead_id: lead.id, items, client_notes: 'End of invoice notes' })).body.data;
  await admin.req('POST', `/api/invoices/${doc.id}/issue`, { confirm: true });
  const { buf } = await pdfOf(admin, `/api/invoices/${doc.id}/pdf`);
  const parsed = await pdfParse(buf);
  assert.ok(parsed.numpages >= 3, `expected several pages, got ${parsed.numpages}`);
  assert.ok(parsed.text.includes(`Page 1 of ${parsed.numpages}`) && parsed.text.includes(`Page ${parsed.numpages} of ${parsed.numpages}`));
  assert.ok(parsed.text.includes('Service item 45') && parsed.text.includes('End of invoice notes'));
  assert.ok((parsed.text.match(/continued/g) || []).length >= 2, 'continuation pages are labelled');
  assert.ok(parsed.text.includes('Description') && (parsed.text.match(/Description/g) || []).length >= 2, 'table header repeats');
  const dto = (await admin.req('GET', `/api/invoices/${doc.id}`)).body.data;
  assert.ok(parsed.text.includes(new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(dto.total))));
});

test('PDF: quotation wording, no status marking, and non-INR currency', async () => {
  const lead = await mkLead(admin);
  const q = (await create(admin, 'quotations', { lead_id: lead.id, currency: 'USD', due_date: '2026-12-31', items: [item({ unit_price: '2500' })] })).body.data;
  const t = await text((await pdfOf(admin, `/api/quotations/${q.id}/pdf`)).buf);
  assert.ok(t.includes('QUOTATION') && t.includes('Prepared For') && t.includes('Valid until') && t.includes('Estimated Total') && t.includes('Estimated total') && t.includes('not a tax invoice') && t.includes('$2,500.00') && !t.includes('DRAFT'));
  assert.ok(!t.includes('Rupees'), 'amount in words is INR only');
  await admin.req('POST', `/api/quotations/${q.id}/cancel`, { confirm: true, reason: 'superseded' });
  const cancelled = await text((await pdfOf(admin, `/api/quotations/${q.id}/pdf`)).buf);
  assert.ok(cancelled.includes(q.doc_number) && !cancelled.includes('CANCELLED'), 'cancelled documents stay downloadable; the document itself shows no status');
});

// ------------------------------------------------------------------ email
test('email: only issued documents; correct PDF attached; explicit confirmation; delivery recorded', async () => {
  const lead = await mkLead(admin, { email: 'client@pr.example' });
  const doc = (await create(admin, 'invoices', { lead_id: lead.id, items: [item({ unit_price: '2000' })] })).body.data;
  const body = { to: 'client@pr.example', subject: `Invoice ${doc.doc_number}`, body: 'Hello,\nPlease find the invoice <attached> & thanks.', confirm: true };
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/email`, body)).status, 409, 'drafts cannot be emailed');
  await admin.req('POST', `/api/invoices/${doc.id}/issue`, { confirm: true });
  const defs = (await admin.req('GET', `/api/invoices/${doc.id}/email-defaults`)).body.data;
  assert.equal(defs.to, 'client@pr.example'); assert.match(defs.subject, new RegExp(doc.doc_number)); assert.ok(defs.body.includes(ISSUER.company_name)); assert.equal(defs.configured, true);
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/email`, { ...body, confirm: undefined })).status, 400, 'explicit confirmation required');
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/email`, { ...body, to: 'not-an-email' })).status, 400);
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/email`, { ...body, subject: '' })).status, 400);
  const n = sent.length;
  const r = await admin.req('POST', `/api/invoices/${doc.id}/email`, { ...body, to: 'corrected@pr.example', cc: 'boss@pr.example' }); // recipient corrected before sending
  assert.equal(r.status, 200); assert.equal(sent.length, n + 1);
  const mail = sent.at(-1);
  assert.equal(mail.to, 'corrected@pr.example'); assert.equal(mail.cc, 'boss@pr.example'); assert.equal(mail.subject, body.subject);
  assert.match(mail.text, /Please find the invoice <attached> & thanks\./); assert.match(mail.html, /&lt;attached&gt; &amp; thanks/, 'html body is escaped');
  assert.equal(mail.attachments.length, 1); assert.equal(mail.attachments[0].filename, `${doc.doc_number}.pdf`); assert.equal(mail.attachments[0].contentType, 'application/pdf');
  assert.equal(mail.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.ok((await text(mail.attachments[0].content)).includes(doc.doc_number), 'the attachment is this invoice');
  assert.equal(r.body.data.emails[0].status, 'sent'); assert.equal(r.body.data.emails[0].to_email, 'corrected@pr.example');
  assert.equal(r.body.data.status, 'issued', 'emailing is not payment and changes no status');
  assert.equal(r.body.data.amount_paid, '0.00');
  assert.ok((await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data.some((a) => a.action_type === 'document_emailed'));
});

test('email: a delivery failure is reported and recorded without losing the document; unconfigured SMTP is explained; PDFs stay downloadable', async () => {
  const lead = await mkLead(admin);
  const doc = (await create(admin, 'invoices', { lead_id: lead.id, items: [item()] })).body.data;
  await admin.req('POST', `/api/invoices/${doc.id}/issue`, { confirm: true });
  const body = { to: 'client@pr.example', subject: 'Invoice', body: 'Hi', confirm: true };
  failNext = true;
  const fail = await admin.req('POST', `/api/invoices/${doc.id}/email`, body);
  assert.equal(fail.status, 502); assert.equal(fail.body.error.code, 'EMAIL_FAILED'); assert.match(fail.body.error.message, /SMTP connection refused/);
  const after = (await admin.req('GET', `/api/invoices/${doc.id}`)).body.data;
  assert.equal(after.status, 'issued'); assert.equal(after.emails[0].status, 'failed'); assert.match(after.emails[0].error, /refused/);
  assert.equal((await pdfOf(admin, `/api/invoices/${doc.id}/pdf`)).res.status, 200);
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/email`, body)).status, 200, 'retry works');
  setTransport(null); // nothing configured (no SMTP_HOST in the test environment)
  const nope = await admin.req('POST', `/api/invoices/${doc.id}/email`, body);
  assert.equal(nope.status, 503); assert.equal(nope.body.error.code, 'EMAIL_NOT_CONFIGURED');
  assert.equal((await admin.req('GET', `/api/invoices/${doc.id}/email-defaults`)).body.data.configured, false);
  assert.equal((await pdfOf(admin, `/api/invoices/${doc.id}/pdf`)).res.status, 200);
  setTransport({ sendMail: async (msg) => { sent.push(msg); return { messageId: '<test@piweb>' }; } });
});

// ------------------------------------------------------------------ lists + lead integration
test('invoice list: search, status filter, date range, pagination, counts; lead integration', async () => {
  const lead = await mkLead(admin, { business_name: 'Zebra Traders' });
  const a = (await create(admin, 'invoices', { lead_id: lead.id, items: [item({ unit_price: '700' })], issue_date: '2026-03-05' })).body.data;
  const b = (await create(admin, 'invoices', { lead_id: lead.id, items: [item({ unit_price: '900' })], issue_date: '2026-04-05' })).body.data;
  await admin.req('POST', `/api/invoices/${b.id}/issue`, { confirm: true });
  const list = async (qs) => (await admin.req('GET', `/api/invoices?${qs}`)).body;
  assert.deepEqual((await list(`q=Zebra`)).data.map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.deepEqual((await list(`q=${b.doc_number}`)).data.map((x) => x.id), [b.id]);
  assert.equal((await list(`q=${lead.lead_code}&pageSize=100`)).data.length, 2);
  assert.deepEqual((await list(`q=Zebra&status=issued`)).data.map((x) => x.id), [b.id]);
  assert.deepEqual((await list(`q=Zebra&from=2026-04-01&to=2026-04-30`)).data.map((x) => x.id), [b.id]);
  const page = await list(`q=Zebra&pageSize=1&page=2`);
  assert.equal(page.meta.total, 2); assert.equal(page.meta.totalPages, 2); assert.equal(page.data.length, 1);
  assert.deepEqual((await list('q=Zebra')).meta.status_counts, { draft: 1, issued: 1 });
  const row = (await list('q=Zebra')).data[0];
  for (const k of ['doc_number', 'client_name', 'lead', 'issue_date', 'due_date', 'total', 'amount_paid', 'outstanding', 'status', 'created_at']) assert.ok(k in row, k);
  assert.equal((await list('q=NoSuchThing12345')).data.length, 0);
  assert.equal((await admin.req('GET', '/api/invoices?status=bogus%27%3B--')).status, 200, 'odd input is just a filter that matches nothing');
  const byLead = (await admin.req('GET', `/api/billing/by-lead/${lead.id}`)).body.data;
  assert.deepEqual(byLead.map((x) => x.doc_number).sort(), [a.doc_number, b.doc_number].sort());
  assert.ok(byLead.every((x) => x.type === 'invoice' && x.total && x.created_at));
});

// ------------------------------------------------------------------ service presets + draft company details
test('service presets: seeded defaults pre-fill new documents; admins manage them; documents keep copies', async () => {
  const lead = await mkLead(admin);
  const pre = (await admin.req('GET', `/api/invoices/prefill/${lead.id}`)).body.data;
  assert.deepEqual(pre.default_items.map((i) => [i.name, i.unit_price, i.discount_type, i.discount_value]), [
    ['Website development & Testing', '14000.00', 'none', null], ['Google Indexing & Basic SEO setup', '1200.00', 'none', null],
    ['Hosting Server + Domain (1 Year)', '2400.00', 'percent', '100'], ['Site Maintenance', '3000.00', 'percent', '100'], ['Website Landing Page', '8000.00', 'percent', '100']]);
  assert.equal(pre.defaults.payment_terms, '20% Advanced', 'payment terms are pre-filled');
  assert.ok(pre.default_items.every((i) => i.quantity === '1'));
  assert.deepEqual((await a1.req('GET', '/api/billing/presets')).body.data.map((p) => p.name), pre.default_items.map((i) => i.name), 'everyone can read');
  // the seeded items produce the expected total when saved as-is
  const doc = (await create(admin, 'quotations', { lead_id: lead.id, items: pre.default_items })).body.data;
  assert.equal(doc.total, '15200.00', 'complimentary (100% discount) items cost nothing but stay on the document');
  assert.equal(doc.items.length, 5); assert.equal(doc.discount_total, '13400.00');
  const dpdf = await text((await pdfOf(admin, `/api/quotations/${doc.id}/pdf`)).buf);
  assert.ok(dpdf.includes('Authorised Signatory') && dpdf.includes(`For ${ISSUER.company_name}`), 'signature block is always printed');
  // admin-only management
  assert.equal((await a1.req('POST', '/api/billing/presets', { name: 'X', unit_price: '1' })).status, 403);
  const added = await admin.req('POST', '/api/billing/presets', { name: 'Logo design', unit_price: '3500', description: 'Three concepts', tax_rate: '18', is_default: false });
  assert.equal(added.status, 201); assert.equal(added.body.data.tax_rate, '18');
  assert.equal((await admin.req('POST', '/api/billing/presets', { name: 'Logo design', unit_price: '1' })).status, 409);
  assert.equal((await admin.req('POST', '/api/billing/presets', { name: 'Bad', unit_price: '1.234' })).status, 400);
  const preAfter = (await admin.req('GET', `/api/invoices/prefill/${lead.id}`)).body.data;
  assert.equal(preAfter.default_items.length, 5, 'a non-default preset is not pre-filled');
  assert.ok((await a1.req('GET', '/api/billing/presets')).body.data.some((p) => p.name === 'Logo design'), 'but it is available for quick-add');
  assert.equal((await admin.req('POST', '/api/billing/presets', { name: 'Bad disc', unit_price: '1', discount_type: 'percent', discount_value: '150' })).status, 400, 'discount over 100%');
  assert.equal((await admin.req('POST', '/api/billing/presets', { name: 'No value', unit_price: '1', discount_type: 'percent' })).status, 400);
  await admin.req('PATCH', `/api/billing/presets/${added.body.data.id}`, { is_default: true, unit_price: '4000' });
  assert.equal((await admin.req('GET', `/api/invoices/prefill/${lead.id}`)).body.data.default_items.at(-1).unit_price, '4000.00');
  await admin.req('PATCH', `/api/billing/presets/${added.body.data.id}`, { is_active: false });
  assert.ok(!(await a1.req('GET', '/api/billing/presets')).body.data.some((p) => p.name === 'Logo design'), 'inactive presets are hidden');
  assert.ok((await admin.req('GET', '/api/billing/presets?include_inactive=1')).body.data.some((p) => p.name === 'Logo design'));
  const copy = (await admin.req('PATCH', '/api/billing/presets/' + (await admin.req('GET', '/api/billing/presets')).body.data[0].id, { unit_price: '99999' })).body.data;
  assert.equal(copy.unit_price, '99999.00');
  assert.equal((await admin.req('GET', `/api/quotations/${doc.id}`)).body.data.items[0].unit_price, '14000.00', 'existing documents are unaffected by preset edits');
  assert.equal((await admin.req('DELETE', `/api/billing/presets/${added.body.data.id}`)).status, 200);
  assert.equal((await admin.req('DELETE', `/api/billing/presets/${added.body.data.id}`)).status, 404);
  await admin.req('PATCH', `/api/billing/presets/${copy.id}`, { unit_price: '12000' }); // restore the seed
});

test('company details: drafts follow the trusted config, issued documents are frozen', async () => {
  const lead = await mkLead(admin);
  const doc = (await create(admin, 'invoices', { lead_id: lead.id, items: [item()] })).body.data;
  await pool.query("UPDATE billing_documents SET issuer_snapshot = JSON_SET(issuer_snapshot, '$.company_name', 'Old Name Pvt Ltd') WHERE id = ?", [doc.id]); // as if created before a config change
  assert.equal((await admin.req('GET', `/api/invoices/${doc.id}`)).body.data.issuer.company_name, 'Old Name Pvt Ltd');
  assert.equal((await admin.req('PUT', `/api/invoices/${doc.id}`, { po_number: 'P1' })).body.data.issuer.company_name, ISSUER.company_name, 'saving a draft refreshes it');
  await pool.query("UPDATE billing_documents SET issuer_snapshot = JSON_SET(issuer_snapshot, '$.company_name', 'Old Name Pvt Ltd') WHERE id = ?", [doc.id]);
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/issue`, { confirm: true })).body.data.issuer.company_name, ISSUER.company_name, 'issuing freezes the current details');
  await pool.query("UPDATE billing_documents SET issuer_snapshot = JSON_SET(issuer_snapshot, '$.company_name', 'Frozen Name') WHERE id = ?", [doc.id]);
  await admin.req('PATCH', `/api/invoices/${doc.id}/internal-notes`, { internal_notes: 'x' });
  assert.equal((await admin.req('GET', `/api/invoices/${doc.id}`)).body.data.issuer.company_name, 'Frozen Name', 'issued snapshots never change');
});

// ------------------------------------------------------------------ WhatsApp
test('WhatsApp: prepares the lead\'s number, a ready message and a secure PDF link; only issued documents; nothing is auto-sent', async () => {
  const lead = await mkLead(admin);
  const doc = (await create(admin, 'invoices', { lead_id: lead.id, items: [item({ unit_price: '2500' })], due_date: '2026-12-31' })).body.data;
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/whatsapp-prepare`)).status, 409, 'drafts cannot be shared');
  await admin.req('POST', `/api/invoices/${doc.id}/issue`, { confirm: true });
  const mails = sent.length;
  const p = (await admin.req('POST', `/api/invoices/${doc.id}/whatsapp-prepare`)).body.data;
  assert.equal(p.phone, lead.phone, "defaults to the lead's number");
  assert.ok(p.message.includes(doc.doc_number) && p.message.includes(ISSUER.company_name) && p.message.includes('₹2,500.00') && p.message.includes(p.link));
  assert.match(p.link, /\/api\/public\/documents\/[a-f0-9]{32}\/pdf$/);
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/whatsapp-prepare`)).body.data.link, p.link, 'the same link every time');
  assert.equal(sent.length, mails, 'no email, nothing sent automatically');

  // the link works without logging in and returns this invoice's PDF
  const path = new URL(p.link).pathname;
  const pub = await fetch(srv.base + path); const buf = Buffer.from(await pub.arrayBuffer());
  assert.equal(pub.status, 200); assert.equal(pub.headers.get('content-type'), 'application/pdf'); assert.match(pub.headers.get('x-robots-tag'), /noindex/);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.ok((await text(buf)).includes(doc.doc_number));
  assert.equal((await fetch(srv.base + '/api/public/documents/' + 'a'.repeat(32) + '/pdf')).status, 404, 'unknown tokens');
  assert.equal((await fetch(srv.base + '/api/public/documents/not-a-token/pdf')).status, 404);

  // recorded in history + lead activity; the document itself is untouched
  const rec = await admin.req('POST', `/api/invoices/${doc.id}/whatsapp-opened`, { to: p.phone });
  assert.equal(rec.status, 200); assert.equal(rec.body.data.emails[0].channel, 'whatsapp'); assert.equal(rec.body.data.emails[0].status, 'opened'); assert.equal(rec.body.data.status, 'issued');
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/whatsapp-opened`, { to: '12' })).status, 400);
  assert.ok((await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data.some((a) => a.action_type === 'document_whatsapp'));

  // cancelling kills the link; other agents cannot prepare links for leads they cannot access
  await admin.req('POST', `/api/invoices/${doc.id}/cancel`, { confirm: true, reason: 'test' });
  assert.equal((await fetch(srv.base + path)).status, 404, 'cancelled documents are no longer reachable by link');
  assert.equal((await admin.req('POST', `/api/invoices/${doc.id}/whatsapp-prepare`)).status, 409);
  const priv = await mkLead(admin, { assigned_to: U.a1.id });
  const pd = (await create(admin, 'invoices', { lead_id: priv.id, items: [item()] })).body.data; await admin.req('POST', `/api/invoices/${pd.id}/issue`, { confirm: true });
  assert.equal((await a2.req('POST', `/api/invoices/${pd.id}/whatsapp-prepare`)).status, 404);
  assert.equal((await new Client(srv.base).req('POST', `/api/invoices/${pd.id}/whatsapp-prepare`)).status, 401);
  assert.equal((await a1.req('POST', `/api/invoices/${pd.id}/whatsapp-prepare`)).status, 200);
});

// ------------------------------------------------------------------ bank details, periods, proofs, next-due, quotation status
const issuedFresh = async (c = admin, over = {}) => {
  const lead = await mkLead(c);
  const d = (await create(c, 'invoices', { lead_id: lead.id, items: [item({ unit_price: '10000' })], ...over })).body.data;
  await admin.req('POST', `/api/invoices/${d.id}/issue`, { confirm: true });
  return (await admin.req('GET', `/api/invoices/${d.id}`)).body.data;
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const upload = async (c, path, files) => {
  const fd = new FormData();
  for (const [name, buf, type] of files) fd.append('files', new Blob([buf], { type }), name);
  const res = await fetch(srv.base + path, { method: 'POST', headers: { cookie: c.cookie, 'x-requested-with': 'piweb-crm' }, body: fd });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('bank details: printed on invoice and quotation PDFs and in the email / WhatsApp messages', async () => {
  assert.equal(ISSUER.bank.ifsc, 'AUBL0002444');
  const inv = await issuedFresh();
  const t = await text((await pdfOf(admin, `/api/invoices/${inv.id}/pdf`)).buf);
  for (const s of ['Piweb Tech Software Solutions PVT LTD', '2502244481711832', 'AUBL0002444']) assert.ok(t.includes(s), `invoice PDF has ${s}`);
  const lead = await mkLead(admin);
  const q = (await create(admin, 'quotations', { lead_id: lead.id, items: [item()] })).body.data;
  await admin.req('POST', `/api/quotations/${q.id}/issue`, { confirm: true });
  const qt = await text((await pdfOf(admin, `/api/quotations/${q.id}/pdf`)).buf);
  for (const s of ['2502244481711832', 'AUBL0002444']) assert.ok(qt.includes(s), `quotation PDF has ${s}`);
  const wa = (await admin.req('POST', `/api/invoices/${inv.id}/whatsapp-prepare`)).body.data;
  assert.ok(wa.message.includes('2502244481711832') && wa.message.includes('AUBL0002444'));
});

test('list: generated-date periods, counts and summary (business timezone)', async () => {
  const a = await issuedFresh();
  const list = async (qs) => (await admin.req('GET', `/api/invoices?pageSize=100&${qs}`)).body;
  const today = await list('period=today');
  assert.ok(today.data.some((x) => x.id === a.id));
  assert.ok(today.meta.period_counts.today >= 1 && today.meta.period_counts.all >= today.meta.period_counts.today);
  assert.ok(!(await list('period=yesterday')).data.some((x) => x.id === a.id));
  assert.ok((await list('period=last7')).data.some((x) => x.id === a.id));
  assert.ok(!(await list('period=last_month')).data.some((x) => x.id === a.id));
  const iso = new Date().toISOString().slice(0, 10);
  assert.ok((await list(`period=custom&from=${iso}&to=${iso}`)).data.some((x) => x.id === a.id));
  assert.ok(!(await list('period=custom&from=2000-01-01&to=2000-01-02')).data.some((x) => x.id === a.id));
  const s = today.meta.summary;
  assert.ok(s.count >= 1 && Number(s.value) >= 10000);
  assert.equal((await admin.req('GET', '/api/invoices?period=bogus')).status, 400);
});

test('payment proofs: admin attaches images/PDF per payment; content is verified; access is enforced', async () => {
  const lead = await mkLead(admin, { assigned_to: U.a1.id });
  const d0 = (await create(admin, 'invoices', { lead_id: lead.id, items: [item()] })).body.data;
  await admin.req('POST', `/api/invoices/${d0.id}/issue`, { confirm: true });
  const inv = d0;
  const p = (await admin.req('POST', `/api/invoices/${inv.id}/payments`, { amount: '3000', method: 'upi' })).body.data.invoice.payments[0];
  const base = `/api/invoices/${inv.id}/payments/${p.id}/attachments`;
  assert.equal((await upload(admin, base, [])).status, 400, 'needs a file');
  assert.equal((await upload(admin, base, [['evil.png', Buffer.from('<script>alert(1)</script>'), 'image/png']])).status, 400, 'extension/type are not trusted');
  assert.equal((await upload(admin, base, [['big.png', Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]), 'image/png']])).status, 413, 'over 8 MB');
  const ok = await upload(admin, base, [['proof 1.png', PNG, 'image/png'], ['receipt.pdf', Buffer.from('%PDF-1.4\n%test\n'), 'application/pdf']]);
  assert.equal(ok.status, 201);
  const att = ok.body.data.payments[0].attachments; assert.equal(att.length, 2);
  const img = await fetch(srv.base + `${base}/${att[0].id}`, { headers: { cookie: admin.cookie } });
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png'); assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.equal((await fetch(srv.base + `${base}/${att[0].id}`)).status, 401, 'login required');
  assert.equal((await fetch(srv.base + `${base}/${att[0].id}`, { headers: { cookie: a2.cookie } })).status, 404, 'no access to the lead -> not found');
  assert.equal((await upload(t1, base, [['x.png', PNG, 'image/png']])).status, 403, 'telecallers cannot attach');
  assert.equal((await t1.req('DELETE', `${base}/${att[0].id}`)).status, 403);
  const del = await admin.req('DELETE', `${base}/${att[0].id}`);
  assert.equal(del.status, 200); assert.equal(del.body.data.payments[0].attachments.length, 1);
  assert.equal((await fetch(srv.base + `${base}/${att[0].id}`, { headers: { cookie: admin.cookie } })).status, 404);
});

test('next payment due: set/change/clear on payable invoices, validated, cleared when paid, counted for follow-up', async () => {
  const inv = await issuedFresh();
  const url = `/api/invoices/${inv.id}/next-due`;
  const iso = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  assert.equal((await admin.req('PATCH', url, { date: '2000-01-01' })).status, 400, 'not in the past');
  assert.equal((await admin.req('PATCH', url, { date: 'soon' })).status, 400);
  assert.equal((await admin.req('PATCH', url, { date: iso(5) })).body.data.next_payment_due, iso(5));
  assert.equal((await admin.req('PATCH', url, { date: iso(9) })).body.data.next_payment_due, iso(9), 'can be changed');
  assert.equal((await admin.req('PATCH', url, { date: null })).body.data.next_payment_due, null, 'can be cleared');
  await admin.req('PATCH', url, { date: iso(0) });
  const due = (await admin.req('GET', '/api/invoices?followup=due&pageSize=100')).body;
  assert.ok(due.data.some((x) => x.id === inv.id) && due.meta.followup_due >= 1);
  assert.ok((await admin.req('GET', '/api/leads/summary')).body.data.payment_followups >= 1);
  await admin.req('POST', `/api/invoices/${inv.id}/payments`, { amount: '10000' });
  const paid = (await admin.req('GET', `/api/invoices/${inv.id}`)).body.data;
  assert.equal(paid.status, 'paid'); assert.equal(paid.next_payment_due, null, 'cleared once fully paid');
  assert.equal((await admin.req('PATCH', url, { date: iso(3) })).status, 409);
  const draft = (await create(admin, 'invoices', { lead_id: inv.lead.id })).body.data;
  assert.equal((await admin.req('PATCH', `/api/invoices/${draft.id}/next-due`, { date: iso(3) })).status, 409, 'drafts have no payment date');
});

test('quotation status: manual change among issued / accepted / rejected only', async () => {
  const lead = await mkLead(admin);
  const q = (await create(admin, 'quotations', { lead_id: lead.id, items: [item()] })).body.data;
  const set = (status) => admin.req('POST', `/api/quotations/${q.id}/status`, { status });
  assert.equal((await set('accepted')).status, 409, 'draft must be issued first');
  await admin.req('POST', `/api/quotations/${q.id}/issue`, { confirm: true });
  assert.equal((await set('rejected')).body.data.status, 'rejected');
  assert.equal((await set('accepted')).body.data.status, 'accepted', 'a changed mind is allowed');
  assert.equal((await set('issued')).body.data.status, 'issued');
  assert.equal((await set('paid')).status, 400);
  assert.equal((await set('draft')).status, 400);
});

test('duplicate: an issued invoice or quotation becomes a new editable draft; the original is untouched', async () => {
  const lead = await mkLead(admin, { assigned_to: U.a1.id });
  const d = (await create(admin, 'invoices', { lead_id: lead.id, payment_terms: '20% Advanced', client_notes: 'Hello', items: [item({ unit_price: '10000' }), item({ name: 'Hosting', unit_price: '2000', discount_type: 'percent', discount_value: '100' })] })).body.data;
  assert.equal((await admin.req('POST', `/api/invoices/${d.id}/duplicate`)).status, 409, 'a draft is already editable');
  await admin.req('POST', `/api/invoices/${d.id}/issue`, { confirm: true });
  await admin.req('POST', `/api/invoices/${d.id}/payments`, { amount: '1000' });
  assert.equal((await a2.req('POST', `/api/invoices/${d.id}/duplicate`)).status, 404, 'needs access to the lead');
  const copy = await a1.req('POST', `/api/invoices/${d.id}/duplicate`);
  assert.equal(copy.status, 201); const c = copy.body.data;
  assert.equal(c.status, 'draft'); assert.equal(c.doc_number, `INV-GN-${lead.lead_code}-02`);
  assert.equal(c.total, '10000.00'); assert.equal(c.payment_terms, '20% Advanced'); assert.equal(c.client_notes, 'Hello');
  assert.deepEqual(c.items.map((i) => [i.name, i.discount_type, i.discount_type === 'none' ? null : i.discount_value]), [['Website development', 'none', null], ['Hosting', 'percent', '100']]);
  assert.equal(c.amount_paid, '0.00'); assert.equal(c.due_date, null);
  // the copy is freely editable (e.g. a discount for the client) while the original keeps its record
  const edited = await a1.req('PUT', `/api/invoices/${c.id}`, { items: [item({ unit_price: '9000' })] });
  assert.equal(edited.body.data.total, '9000.00');
  const orig = (await admin.req('GET', `/api/invoices/${d.id}`)).body.data;
  assert.equal(orig.status, 'partially_paid'); assert.equal(orig.total, '10000.00'); assert.equal(orig.payments.length, 1);
  // quotations too
  const q = (await create(admin, 'quotations', { lead_id: lead.id, items: [item()] })).body.data;
  await admin.req('POST', `/api/quotations/${q.id}/issue`, { confirm: true });
  const qc = await admin.req('POST', `/api/quotations/${q.id}/duplicate`);
  assert.equal(qc.status, 201); assert.equal(qc.body.data.type, 'quotation'); assert.equal(qc.body.data.status, 'draft');
});

test('roles: admins and agents change documents, payments and status; telecallers can only view', async () => {
  const lead = await mkLead(admin);
  const inv = (await create(admin, 'invoices', { lead_id: lead.id, items: [item({ unit_price: '5000' })] })).body.data;
  await admin.req('POST', `/api/invoices/${inv.id}/issue`, { confirm: true });
  const q = (await create(admin, 'quotations', { lead_id: lead.id, items: [item()] })).body.data;
  await admin.req('POST', `/api/quotations/${q.id}/issue`, { confirm: true });
  // telecaller: sees everything the lead gives access to…
  assert.equal((await t1.req('GET', `/api/invoices/${inv.id}`)).status, 200);
  assert.equal((await t1.req('GET', '/api/invoices?pageSize=5')).status, 200);
  assert.equal((await pdfOf(t1, `/api/invoices/${inv.id}/pdf`)).res.status, 200);
  // …but cannot change anything
  const refused = [
    ['POST', '/api/invoices', { lead_id: lead.id }], ['PUT', `/api/invoices/${inv.id}`, { po_number: 'x' }], ['POST', `/api/invoices/${inv.id}/issue`, { confirm: true }],
    ['POST', `/api/invoices/${inv.id}/cancel`, { confirm: true, reason: 'x' }], ['POST', `/api/invoices/${inv.id}/payments`, { amount: '100' }],
    ['PATCH', `/api/invoices/${inv.id}/next-due`, { date: null }], ['POST', `/api/invoices/${inv.id}/duplicate`], ['PATCH', `/api/invoices/${inv.id}/internal-notes`, { internal_notes: 'x' }],
    ['POST', `/api/quotations/${q.id}/status`, { status: 'accepted' }], ['POST', `/api/quotations/${q.id}/convert`], ['POST', '/api/billing/presets', { name: 'T', unit_price: '1' }],
  ];
  for (const [m, url, body] of refused) assert.equal((await t1.req(m, url, body)).status, 403, `telecaller ${m} ${url}`);
  assert.equal((await admin.req('GET', `/api/invoices/${inv.id}`)).body.data.amount_paid, '0.00', 'nothing changed');
  // agents can: record payment, set next payment date, change quotation status, cancel an issued document
  const pay = await a1.req('POST', `/api/invoices/${inv.id}/payments`, { amount: '2000' });
  assert.equal(pay.status, 201); assert.equal(pay.body.data.invoice.status, 'partially_paid');
  const day = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  assert.equal((await a1.req('PATCH', `/api/invoices/${inv.id}/next-due`, { date: day })).status, 200);
  assert.equal((await a1.req('POST', `/api/quotations/${q.id}/status`, { status: 'accepted' })).body.data.status, 'accepted');
  const fresh = await issuedInvoice('800'); assert.equal((await a1.req('POST', `/api/invoices/${fresh.id}/cancel`, { confirm: true, reason: 'client withdrew' })).body.data.status, 'cancelled');
  // the role can be given from Settings → Users
  const mk = await admin.req('POST', '/api/users', { name: 'Tele Two', email: 't2@t.test', password: 'password-tele-2', role: 'telecaller' });
  assert.equal(mk.status, 201); assert.equal(mk.body.data.role, 'telecaller');
  assert.equal((await admin.req('PATCH', `/api/users/${mk.body.data.id}`, { role: 'agent' })).body.data.role, 'agent');
});
