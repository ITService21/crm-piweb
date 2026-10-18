import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUsers, valueId, startServer, Client, pool } from './helpers.js';

let srv; let U; let admin; let a1; let a2; let S;
before(async () => {
  await resetDb(); U = await makeUsers(); srv = await startServer();
  admin = new Client(srv.base); a1 = new Client(srv.base); a2 = new Client(srv.base);
  assert.equal((await admin.login('admin@t.test', 'password-admin-1')).status, 200);
  assert.equal((await a1.login('a1@t.test', 'password-agent-1')).status, 200);
  assert.equal((await a2.login('a2@t.test', 'password-agent-2')).status, 200);
  S = { new: await valueId('lead_status', 'new'), prog: await valueId('lead_status', 'in_progress'), conv: await valueId('lead_status', 'converted') };
});
after(async () => { await srv.close(); await pool.end(); });

test('auth: wrong password 401, unauthenticated 401, missing CSRF header 403, cookie is httpOnly', async () => {
  assert.equal((await new Client(srv.base).login('admin@t.test', 'nope-nope-nope')).status, 401);
  assert.equal((await new Client(srv.base).req('GET', '/api/leads')).status, 401);
  assert.equal((await admin.req('POST', '/api/leads', { phone: '9811111111' }, { 'x-requested-with': '' })).status, 403);
  const raw = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'piweb-crm' }, body: JSON.stringify({ email: 'admin@t.test', password: 'password-admin-1' }) });
  assert.match(raw.headers.get('set-cookie'), /HttpOnly/i);
  const me = await admin.req('GET', '/api/auth/me');
  assert.equal(me.body.data.role, 'admin');
  assert.ok(me.body.data.permissions.includes('settings:manage'));
});

test('validation errors are 400 with a consistent envelope; SQL-ish input is just text', async () => {
  const r = await admin.req('POST', '/api/leads', { email: 'not-an-email' });
  assert.equal(r.status, 400); assert.equal(r.body.success, false); assert.ok(r.body.error.details.length);
  assert.equal((await admin.req('POST', '/api/leads', {})).status, 400);
  const ok = await admin.req('POST', '/api/leads', { phone: '9822222222', nickname: "x'); DROP TABLE leads;--" });
  assert.equal(ok.status, 201);
  const list = await admin.req('GET', `/api/leads?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(list.status, 200); assert.equal(list.body.data.length, 0);
  assert.equal((await admin.req('GET', '/api/leads?tab=bogus')).status, 400);
});

test('a new lead appears in Leads with New status; manual create logs activity + outbox + notifications', async () => {
  const r = await admin.req('POST', '/api/leads', { phone: '98 33333 333', email: 'A@B.com', nickname: 'Rahul' });
  assert.equal(r.status, 201);
  const lead = r.body.data;
  assert.equal(lead.phone, '+919833333333'); assert.equal(lead.email, 'a@b.com');
  assert.equal(lead.status.label, 'New'); assert.equal(lead.priority_reason, 'new');
  const list = await admin.req('GET', '/api/leads?tab=leads');
  assert.ok(list.body.data.some((l) => l.id === lead.id));
  const [[ob]] = await pool.query('SELECT COUNT(*) n FROM event_outbox WHERE lead_id=?', [lead.id]);
  assert.equal(ob.n, 1);
  const [[nt]] = await pool.query('SELECT COUNT(*) n FROM notifications WHERE lead_id=?', [lead.id]);
  assert.equal(nt.n, 3); // admin + both active agents
});

test('failed creation leaves no lead, no outbox row (events only after commit)', async () => {
  const [[b]] = await pool.query('SELECT (SELECT COUNT(*) FROM leads) l, (SELECT COUNT(*) FROM event_outbox) o');
  const r = await admin.req('POST', '/api/leads', { phone: '9844444444', enquiry_type_id: 999999 });
  assert.equal(r.status, 400);
  const [[a]] = await pool.query('SELECT (SELECT COUNT(*) FROM leads) l, (SELECT COUNT(*) FROM event_outbox) o');
  assert.deepEqual(a, b);
});

test('remarks: unlimited, newest first with author; latest shown on the lead; activity logged', async () => {
  const lead = (await admin.req('POST', '/api/leads', { phone: '9855555555' })).body.data;
  for (const t of ['first', 'second', 'third']) {
    assert.equal((await (t === 'second' ? a1 : admin).req('POST', `/api/leads/${lead.id}/remarks`, { text: t })).status, 201);
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal((await admin.req('POST', `/api/leads/${lead.id}/remarks`, { text: '   ' })).status, 400);
  const remarks = (await admin.req('GET', `/api/leads/${lead.id}/remarks`)).body.data;
  assert.deepEqual(remarks.map((r) => r.text), ['third', 'second', 'first']);
  assert.equal(remarks[1].author, 'Agent One');
  const got = (await admin.req('GET', `/api/leads/${lead.id}`)).body.data;
  assert.equal(got.last_remark.text, 'third'); assert.equal(got.remarks_count, 3);
});

test('every important change creates an activity record; agents cannot edit or delete activities', async () => {
  const lead = (await admin.req('POST', '/api/leads', { phone: '9866666666' })).body.data;
  const markup = await valueId('special_markup', 'special_attention');
  await admin.req('PATCH', `/api/leads/${lead.id}`, { status_id: S.prog });
  await admin.req('POST', `/api/leads/${lead.id}/followup`, { next_followup_at: '2030-01-05T10:00' });
  await admin.req('POST', `/api/leads/${lead.id}/followup`, { next_followup_at: '2030-01-06T10:00' });
  await admin.req('PATCH', `/api/leads/${lead.id}`, { special_markup_id: markup });
  await admin.req('PATCH', `/api/leads/${lead.id}`, { assigned_to: U.a1.id });
  await admin.req('PATCH', `/api/leads/${lead.id}`, { nickname: 'Priya', email: 'p@x.com' });
  await a1.req('POST', `/api/leads/${lead.id}/remarks`, { text: 'called' });
  const acts = (await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data;
  const types = acts.map((a) => a.action_type);
  for (const t of ['lead_created', 'status_changed', 'followup_scheduled', 'followup_rescheduled', 'markup_changed', 'assignment_changed', 'field_updated', 'remark_added']) assert.ok(types.includes(t), t);
  assert.ok(acts.every((a) => a.summary && a.created_at));
  const resched = acts.find((a) => a.action_type === 'followup_rescheduled');
  assert.ok(resched.before_data && resched.after_data);
  assert.equal(acts.find((a) => a.action_type === 'status_changed').actor, 'Admin');
  // No write endpoints exist for activities
  for (const m of ['PATCH', 'PUT', 'DELETE', 'POST']) assert.equal((await a1.req(m, `/api/leads/${lead.id}/activities/${acts[0].id}`, {})).status, 404);
  assert.equal((await a1.req('POST', `/api/leads/${lead.id}/activities`, { summary: 'fake' })).status, 404);
  // no-op update creates nothing
  const before = acts.length;
  await admin.req('PATCH', `/api/leads/${lead.id}`, { nickname: 'Priya' });
  assert.equal((await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data.length, before);
});

test('PATCH leaves omitted fields untouched', async () => {
  const lead = (await admin.req('POST', '/api/leads', { phone: '9877777777', nickname: 'Keep', email: 'keep@x.com', message: 'hello' })).body.data;
  const r = (await admin.req('PATCH', `/api/leads/${lead.id}`, { status_id: S.prog })).body.data;
  assert.equal(r.nickname, 'Keep'); assert.equal(r.email, 'keep@x.com'); assert.equal(r.message, 'hello'); assert.equal(r.phone, '+919877777777');
});

test('role permissions: agents only see unassigned/own leads; handing a lead on removes their access', async () => {
  const lead = (await admin.req('POST', '/api/leads', { phone: '9888888888', assigned_to: U.a1.id })).body.data;
  assert.equal((await a1.req('GET', `/api/leads/${lead.id}`)).status, 200);
  assert.equal((await a2.req('GET', `/api/leads/${lead.id}`)).status, 404);
  assert.equal((await a2.req('PATCH', `/api/leads/${lead.id}`, { nickname: 'hax' })).status, 404);
  assert.equal((await a2.req('POST', `/api/leads/${lead.id}/remarks`, { text: 'x' })).status, 404);
  assert.equal((await a2.req('GET', `/api/leads/${lead.id}/activities`)).status, 404);
  const list2 = (await a2.req('GET', '/api/leads?tab=leads&pageSize=100')).body.data;
  assert.ok(!list2.some((l) => l.id === lead.id));
  const pool1 = (await admin.req('POST', '/api/leads', { phone: '9899999999' })).body.data; // unassigned
  const pool2 = (await admin.req('POST', '/api/leads', { phone: '9899999990' })).body.data; // unassigned
  assert.equal((await a2.req('PATCH', `/api/leads/${pool1.id}`, { assigned_to: U.a1.id })).status, 200, 'any user may hand a lead to another user');
  assert.equal((await a2.req('GET', `/api/leads/${pool1.id}`)).status, 404, 'and then no longer sees it');
  assert.equal((await a2.req('PATCH', `/api/leads/${pool2.id}`, { assigned_to: U.a2.id })).status, 200); // claim
  // agents' counts never include others' leads
  const c = (await a2.req('GET', '/api/leads/counts?tab=leads')).body.data;
  const mine = (await a2.req('GET', '/api/leads?tab=leads&pageSize=100')).body.meta.total;
  assert.equal(c.all, mine);
});

test('settings: admin-only writes; agents read active values only', async () => {
  assert.equal((await a1.req('POST', '/api/settings/values', { category: 'lead_status', label: 'X', status_category: 'active' })).status, 403);
  assert.equal((await a1.req('GET', '/api/settings/values?include_inactive=1')).status, 403);
  assert.equal((await a1.req('GET', '/api/users')).body.data[0].email, undefined);
  assert.equal((await a1.req('POST', '/api/users', { name: 'x', email: 'x@x.com', password: 'longenough-pass' })).status, 403);
  const r = await admin.req('POST', '/api/settings/values', { category: 'lead_status', label: 'Proposal Sent', status_category: 'active', colour: '#112233' });
  assert.equal(r.status, 201); assert.equal(r.body.data.value_key, 'proposal_sent');
  assert.equal((await admin.req('POST', '/api/settings/values', { category: 'lead_status', label: 'Proposal Sent', status_category: 'active' })).status, 409);
  assert.equal((await admin.req('POST', '/api/settings/values', { category: 'lead_status', label: 'No section' })).status, 400);
  // appears as a filter-bar status for the tab it maps to
  const vals = (await admin.req('GET', '/api/settings/values?category=lead_status')).body.data;
  assert.ok(vals.find((v) => v.label === 'Proposal Sent' && v.status_category === 'active'));
});

test('safe deletion: used values cannot be deleted, can be deactivated, not newly assigned, and can be migrated', async () => {
  const st = (await admin.req('POST', '/api/settings/values', { category: 'lead_status', label: 'Old Stage', status_category: 'active' })).body.data;
  const lead = (await admin.req('POST', '/api/leads', { phone: '9810101010', status_id: st.id })).body.data;
  const del = await admin.req('DELETE', `/api/settings/values/${st.id}`);
  assert.equal(del.status, 409); assert.equal(del.body.error.details.leads, 1);
  assert.equal((await admin.req('PATCH', `/api/settings/values/${st.id}`, { is_active: false })).status, 200);
  assert.equal((await admin.req('POST', '/api/leads', { phone: '9810101011', status_id: st.id })).status, 400);
  assert.equal((await admin.req('PATCH', `/api/leads/${lead.id}`, { status_id: st.id })).status, 200); // unchanged value is a no-op, not an error
  const hist = (await admin.req('GET', `/api/leads/${lead.id}`)).body.data;
  assert.equal(hist.status.label, 'Old Stage', 'history preserved');
  const mig = await admin.req('POST', `/api/settings/values/${st.id}/migrate`, { to_id: S.prog });
  assert.equal(mig.body.data.moved, 1);
  assert.equal((await admin.req('GET', `/api/leads/${lead.id}`)).body.data.status.label, 'In Progress');
  assert.ok((await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data.some((a) => /migrated/.test(a.summary)));
  assert.equal((await admin.req('DELETE', `/api/settings/values/${st.id}`)).status, 200);
});

test('changing a status section moves leads between tabs (with confirmation) — no hardcoded names', async () => {
  const st = (await admin.req('POST', '/api/settings/values', { category: 'lead_status', label: 'Won Later', status_category: 'active' })).body.data;
  const lead = (await admin.req('POST', '/api/leads', { phone: '9820202020', status_id: st.id })).body.data;
  assert.equal((await admin.req('PATCH', `/api/settings/values/${st.id}`, { status_category: 'converted' })).status, 409);
  assert.equal((await admin.req('PATCH', `/api/settings/values/${st.id}`, { status_category: 'converted', confirm_section_change: true })).status, 200);
  const conv = (await admin.req('GET', '/api/leads?tab=converted')).body.data;
  assert.ok(conv.some((l) => l.id === lead.id));
});

test('website form: no key needed, creates the same lead + event + notifications', async () => {
  const anon = new Client(srv.base);
  const r = await anon.req('POST', '/api/public/leads', { name: 'Web User', phone: '9830303030', message: 'Need a site', enquiry_type: 'website_development' }, { 'x-api-key': 'test-public-key' });
  assert.equal(r.status, 201);
  const lead = (await admin.req('GET', `/api/leads/${r.body.data.id}`)).body.data;
  assert.equal(lead.source.label, 'Website Form'); assert.equal(lead.enquiry_type.label, 'Website Development Enquiry');
  const [[ob]] = await pool.query('SELECT payload FROM event_outbox WHERE lead_id=?', [lead.id]);
  assert.ok(ob);
  const [[nt]] = await pool.query('SELECT COUNT(*) n FROM notifications WHERE lead_id=?', [lead.id]);
  assert.equal(nt.n, 3);
});

test('notifications: unread count in summary, mark read', async () => {
  const s = (await a1.req('GET', '/api/leads/summary')).body.data;
  assert.ok(s.unread_new_leads > 0);
  assert.equal((await a1.req('POST', '/api/notifications/read', { all: true })).status, 200);
  assert.equal((await a1.req('GET', '/api/leads/summary')).body.data.unread_new_leads, 0);
});

test('preferences persist per user', async () => {
  assert.equal((await a1.req('PUT', '/api/preferences', { sound_enabled: false })).body.data.sound_enabled, false);
  assert.equal((await a1.req('GET', '/api/preferences')).body.data.sound_enabled, false);
  assert.equal((await a2.req('GET', '/api/preferences')).body.data.sound_enabled, true);
});

test('cannot demote/disable the last administrator', async () => {
  assert.equal((await admin.req('PATCH', `/api/users/${U.admin.id}`, { is_active: false })).status, 400);
  assert.equal((await admin.req('PATCH', `/api/users/${U.admin.id}`, { role: 'agent' })).status, 400);
});

test('deactivated user is locked out immediately', async () => {
  assert.equal((await admin.req('PATCH', `/api/users/${U.a2.id}`, { is_active: false })).status, 200);
  assert.equal((await a2.req('GET', '/api/leads')).status, 401);
  assert.equal((await new Client(srv.base).login('a2@t.test', 'password-agent-2')).status, 401);
});

test('landing page payload (exact sample, malformed email kept) maps to lead columns', async () => {
  const anon = new Client(srv.base);
  const r = await anon.req('POST', '/api/public/leads', {
    Name: 'Ridham', Phone: '9518046177', Email: 'yadavridham@349.gmail', 'Business Name': 'PR enterprises',
    Requirement: 'E-commerce', Budget: 'Less than ₹15,000', Message: 'Interested in website development.',
  }, { 'x-api-key': 'test-public-key' });
  assert.equal(r.status, 201);
  const [[row]] = await pool.query('SELECT * FROM leads WHERE id=?', [r.body.data.id]);
  assert.equal(row.nickname, 'Ridham'); assert.equal(row.phone, '+919518046177'); assert.equal(row.email, 'yadavridham@349.gmail');
  assert.equal(row.business_name, 'PR enterprises'); assert.equal(row.requirement, 'E-commerce');
  assert.equal(row.budget, 'Less than ₹15,000'); assert.equal(row.message, 'Interested in website development.');
  const lead = (await admin.req('GET', `/api/leads/${row.id}`)).body.data;
  assert.equal(lead.enquiry_type.label, 'E-commerce Enquiry'); assert.equal(lead.source.label, 'Website Form');
  // snake_case keys work too, and a payload with neither phone nor email is rejected
  assert.equal((await anon.req('POST', '/api/public/leads', { name: 'X', business_name: 'Y', budget: '5k' }, { 'x-api-key': 'test-public-key' })).status, 400);
  const q = (await admin.req('GET', '/api/leads?q=PR%20enterprises')).body.data;
  assert.ok(q.some((l) => l.id === row.id));
});

test('anonymous POST /api/leads (no cookie, no CSRF header) saves a lead; internal fields are ignored', async () => {
  const res = await fetch(srv.base + '/api/leads', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://other-site.example' },
    body: JSON.stringify({ nickname: 'Ridham', phone: '9518046177', email: 'r@example.com', business_name: 'PR enterprises', requirement: 'E-commerce', budget: 'Less than 15000', message: 'Test lead',
      status_id: S.conv, assigned_to: U.a1.id, special_markup_id: 1 }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  const [[row]] = await pool.query('SELECT * FROM leads WHERE id=?', [body.data.id]);
  assert.equal(row.business_name, 'PR enterprises'); assert.equal(row.phone, '+919518046177'); assert.equal(row.created_by, null);
  assert.equal(row.status_id, S.new, 'caller cannot choose status'); assert.equal(row.assigned_to, null, 'caller cannot assign');
  const [[nt]] = await pool.query('SELECT COUNT(*) n FROM notifications WHERE lead_id=?', [row.id]);
  assert.ok(nt.n >= 1, 'notification rows created');
});

test('anonymous endpoint: CORS preflight, validation, honeypot; other routes stay protected', async () => {
  const pre = await fetch(srv.base + '/api/leads', { method: 'OPTIONS', headers: { origin: 'https://x.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.ok(pre.status < 300); assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const anon = new Client(srv.base);
  assert.equal((await fetch(srv.base + '/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'no contact' }) })).status, 400);
  const [[b]] = await pool.query('SELECT COUNT(*) n FROM leads');
  const bot = await fetch(srv.base + '/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '9800099999', website: 'http://spam' }) });
  assert.equal(bot.status, 201);
  assert.equal((await pool.query('SELECT COUNT(*) n FROM leads'))[0][0].n, b.n, 'honeypot saves nothing');
  assert.equal((await anon.req('GET', '/api/leads')).status, 401, 'listing still needs login');
  assert.equal((await anon.req('PATCH', '/api/leads/1', { nickname: 'x' })).status, 401);
  assert.equal((await anon.req('GET', '/api/leads/1')).status, 401);
});

test('logged-in CRM create on the same URL still records the creator and still needs the CSRF header', async () => {
  const r = await admin.req('POST', '/api/leads', { phone: '9811100001', status_id: S.prog });
  assert.equal(r.status, 201); assert.equal(r.body.data.created_by.name, 'Admin'); assert.equal(r.body.data.status.label, 'In Progress');
  assert.equal((await admin.req('POST', '/api/leads', { phone: '9811100002' }, { 'x-requested-with': '' })).status, 403);
});

test('lead codes are short: LD-005 style, growing past 999', async () => {
  const r = (await admin.req('POST', '/api/leads', { phone: '9811200001' })).body.data;
  assert.match(r.lead_code, /^LD-\d{3,}$/);
  assert.equal(r.lead_code, `LD-${String(r.id).padStart(3, '0')}`);
  assert.ok(r.lead_code.length <= 7 || r.id > 999);
});

test('notes: create/validate, subject rules, copy ranking per category, permissions', async () => {
  const wa = await admin.req('POST', '/api/notes', { category: 'whatsapp', title: 'Intro', content: 'Hi! Thanks for your enquiry.', subject: 'ignored' });
  assert.equal(wa.status, 201); assert.equal(wa.body.data.subject, null, 'whatsapp notes have no subject');
  assert.equal((await admin.req('POST', '/api/notes', { category: 'email', title: 'No subject', content: 'x' })).status, 400);
  assert.equal((await admin.req('POST', '/api/notes', { category: 'sms', title: 't', content: 'x' })).status, 400);
  assert.equal((await admin.req('POST', '/api/notes', { category: 'whatsapp', title: '  ', content: 'x' })).status, 400);
  const em = (await a1.req('POST', '/api/notes', { category: 'email', title: 'Proposal', subject: 'Your website proposal', content: 'Dear client,\n\nPlease find…' })).body.data;
  const wa2 = (await admin.req('POST', '/api/notes', { category: 'whatsapp', title: 'Follow-up', content: 'Just checking in.' })).body.data;
  // copying wa2 twice and the email subject (does not count) / content once
  await admin.req('POST', `/api/notes/${wa2.id}/copy`, {}); await admin.req('POST', `/api/notes/${wa2.id}/copy`, { part: 'content' });
  assert.equal((await admin.req('POST', `/api/notes/${em.id}/copy`, { part: 'subject' })).body.data.copy_count, 0);
  assert.equal((await admin.req('POST', `/api/notes/${em.id}/copy`, { part: 'content' })).body.data.copy_count, 1);
  const list = await admin.req('GET', '/api/notes?category=whatsapp');
  assert.equal(list.body.data[0].id, wa2.id, 'copied note first');
  assert.equal(list.body.meta.stats.whatsapp.notes, 2); assert.equal(list.body.meta.stats.whatsapp.copies, 2);
  assert.equal(list.body.meta.stats.email.notes, 1); assert.equal(list.body.meta.stats.all.notes, 3);
  assert.equal((await admin.req('GET', '/api/notes?q=checking')).body.data.length, 1);
  // edit (anyone), switch category rules, delete (author/admin only)
  assert.equal((await admin.req('PATCH', `/api/notes/${em.id}`, { content: 'Edited' })).body.data.content, 'Edited'); // not the author
  assert.equal((await admin.req('PATCH', `/api/notes/${em.id}`, { category: 'whatsapp' })).body.data.subject, null);
  assert.equal((await new Client(srv.base).req('GET', '/api/notes')).status, 401);
  assert.equal((await a1.req('DELETE', `/api/notes/${wa2.id}`)).status, 403);
  assert.equal((await admin.req('DELETE', `/api/notes/${wa2.id}`)).status, 200);
  assert.equal((await admin.req('DELETE', `/api/notes/${wa2.id}`)).status, 404);
});

test('remove: remark required, lead moves to Removed only, vanishes everywhere else, is logged, locked, and restorable', async () => {
  const lead = (await admin.req('POST', '/api/leads', { phone: '9833300001', nickname: 'RemoveMe' })).body.data;
  await admin.req('POST', `/api/leads/${lead.id}/followup`, { next_followup_at: '2020-01-01T10:00' }); // overdue
  const before = (await admin.req('GET', '/api/leads/summary')).body.data;
  assert.equal((await admin.req('POST', `/api/leads/${lead.id}/remove`, {})).status, 400);
  assert.equal((await admin.req('POST', `/api/leads/${lead.id}/remove`, { reason: '   ' })).status, 400);
  assert.equal((await admin.req('GET', `/api/leads/${lead.id}`)).body.data.removed, null);

  const r = await admin.req('POST', `/api/leads/${lead.id}/remove`, { reason: 'Duplicate enquiry' });
  assert.equal(r.status, 200); assert.equal(r.body.data.removed.reason, 'Duplicate enquiry'); assert.equal(r.body.data.removed.by, 'Admin');
  assert.equal((await admin.req('POST', `/api/leads/${lead.id}/remove`, { reason: 'again' })).status, 409);

  for (const tab of ['leads', 'scheduled', 'not_interested', 'converted']) {
    const rows = (await admin.req('GET', `/api/leads?tab=${tab}&pageSize=100`)).body.data;
    assert.ok(!rows.some((l) => l.id === lead.id), `not in ${tab}`);
  }
  assert.equal((await admin.req('GET', '/api/leads?tab=leads&q=RemoveMe')).body.data.length, 0, 'search in other tabs cannot find it');
  assert.equal((await admin.req('GET', '/api/leads?tab=leads&dateFilter=overdue&pageSize=100')).body.data.some((l) => l.id === lead.id), false);
  const removed = (await admin.req('GET', '/api/leads?tab=removed')).body.data;
  assert.ok(removed.some((l) => l.id === lead.id)); assert.equal(removed[0].id, lead.id, 'newest removal first');
  const after = (await admin.req('GET', '/api/leads/summary')).body.data;
  assert.equal(after.overdue_followups, before.overdue_followups - 1); assert.equal(after.removed, before.removed + 1);
  const counts = (await admin.req('GET', '/api/leads/counts?tab=leads')).body.data;
  const listTotal = (await admin.req('GET', '/api/leads?tab=leads&pageSize=1')).body.meta.total;
  assert.equal(counts.all, listTotal);

  const remarks = (await admin.req('GET', `/api/leads/${lead.id}/remarks`)).body.data;
  assert.equal(remarks[0].text, 'Removed: Duplicate enquiry');
  assert.ok((await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data.some((a) => a.action_type === 'lead_removed'));
  assert.equal((await admin.req('PATCH', `/api/leads/${lead.id}`, { nickname: 'x' })).status, 409);
  assert.equal((await admin.req('POST', `/api/leads/${lead.id}/remarks`, { text: 'x' })).status, 409);

  assert.equal((await admin.req('POST', `/api/leads/${lead.id}/restore`, {})).body.data.removed, null);
  assert.equal((await admin.req('POST', `/api/leads/${lead.id}/restore`, {})).status, 409);
  assert.ok((await admin.req('GET', '/api/leads?tab=leads&pageSize=100')).body.data.some((l) => l.id === lead.id), 'back in Leads with its follow-up');
  assert.ok((await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data.some((a) => a.action_type === 'lead_restored'));
});

test('remove respects access: an agent cannot remove or see another agent\'s lead', async () => {
  const lead = (await admin.req('POST', '/api/leads', { phone: '9833300002', assigned_to: U.a1.id })).body.data;
  const other = new Client(srv.base); // a2 is deactivated by an earlier test; use a fresh unauthenticated client
  assert.equal((await other.req('POST', `/api/leads/${lead.id}/remove`, { reason: 'x' })).status, 401);
  assert.equal((await a1.req('POST', `/api/leads/${lead.id}/remove`, { reason: 'Not a fit' })).status, 200);
  assert.ok((await a1.req('GET', '/api/leads?tab=removed')).body.data.some((l) => l.id === lead.id));
});

test('allocation: temporary priority hand-off, separate from assignment', async () => {
  const mkAgent = await admin.req('POST', '/api/users', { name: 'Vikram', email: 'vikram@t.test', password: 'vikram-pass-123', role: 'agent' });
  assert.equal(mkAgent.status, 201);
  const vik = new Client(srv.base); await vik.login('vikram@t.test', 'vikram-pass-123');
  const vikId = mkAgent.body.data.id;

  // lead owned by agent one, with a FUTURE follow-up (would normally live in Follow-up Scheduled)
  const lead = (await admin.req('POST', '/api/leads', { phone: '9844400001', nickname: 'AllocMe', assigned_to: U.a1.id, status_id: S.prog })).body.data;
  await admin.req('POST', `/api/leads/${lead.id}/followup`, { next_followup_at: '2030-05-01T10:00' });
  const other = (await admin.req('POST', '/api/leads', { phone: '9844400002', assigned_to: U.a1.id })).body.data;
  assert.equal((await vik.req('GET', `/api/leads/${lead.id}`)).status, 404, 'no access before allocation');

  // validation
  assert.equal((await admin.req('POST', '/api/leads/allocate', { lead_ids: [], user_id: vikId })).status, 400);
  assert.equal((await admin.req('POST', '/api/leads/allocate', { lead_ids: [lead.id], user_id: 999999 })).status, 400);
  assert.equal((await new Client(srv.base).req('POST', '/api/leads/allocate', { lead_ids: [lead.id], user_id: vikId })).status, 401);

  const r = await admin.req('POST', '/api/leads/allocate', { lead_ids: [lead.id, 999999], user_id: vikId });
  assert.equal(r.status, 200); assert.equal(r.body.data.allocated, 1); assert.deepEqual(r.body.data.skipped, [{ id: 999999, reason: 'not found' }]);
  const dto = (await admin.req('GET', `/api/leads/${lead.id}`)).body.data;
  assert.equal(dto.allocated.to.name, 'Vikram'); assert.equal(dto.allocated.by.name, 'Admin');
  assert.equal(dto.assigned_to.id, U.a1.id, 'assignment untouched');

  // the allocated user can now see and act, and the lead is at the very top of Leads (above new leads / priority)
  assert.equal((await vik.req('GET', `/api/leads/${lead.id}`)).status, 200);
  const list = (await vik.req('GET', '/api/leads?tab=leads&pageSize=100')).body.data;
  assert.equal(list[0].id, lead.id, 'allocated lead first');
  assert.ok(!(await vik.req('GET', '/api/leads?tab=scheduled&pageSize=100')).body.data.some((l) => l.id === lead.id), 'not duplicated in Scheduled');
  assert.equal((await vik.req('POST', `/api/leads/${lead.id}/remarks`, { text: 'Vikram working on it' })).status, 201);
  assert.equal((await vik.req('PATCH', `/api/leads/${lead.id}`, { nickname: 'AllocMe v2' })).status, 200);
  assert.equal((await vik.req('GET', `/api/leads/${other.id}`)).status, 404, 'other leads stay private');
  const acts = (await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data;
  assert.ok(acts.some((a) => a.action_type === 'lead_allocated' && /Vikram/.test(a.summary)));

  // clearing: random agent is not permitted, allocatee is
  assert.equal((await a1.req('POST', '/api/leads/allocate', { lead_ids: [lead.id], user_id: null })).body.data.allocated, 0);
  const rel = await vik.req('POST', '/api/leads/allocate', { lead_ids: [lead.id], user_id: null });
  assert.equal(rel.body.data.allocated, 1);
  assert.equal((await vik.req('GET', `/api/leads/${lead.id}`)).status, 404, 'access ends with the allocation');
  assert.equal((await admin.req('GET', `/api/leads/${lead.id}`)).body.data.allocated, null);
  assert.ok((await admin.req('GET', `/api/leads/${lead.id}/activities`)).body.data.some((a) => a.action_type === 'allocation_cleared'));
  // re-allocating the same lead twice is a no-op skip; removed leads cannot be allocated
  await admin.req('POST', '/api/leads/allocate', { lead_ids: [lead.id], user_id: vikId });
  assert.equal((await admin.req('POST', '/api/leads/allocate', { lead_ids: [lead.id], user_id: vikId })).body.data.skipped[0].reason, 'already allocated to them');
  await admin.req('POST', `/api/leads/${other.id}/remove`, { reason: 'test' });
  assert.equal((await admin.req('POST', '/api/leads/allocate', { lead_ids: [other.id], user_id: vikId })).body.data.skipped[0].reason, 'removed');
});

test('select-all ids across pages, and back-dated creation time for CRM-created leads only', async () => {
  const all = (await admin.req('GET', '/api/leads/ids?tab=leads')).body.data;
  const total = (await admin.req('GET', '/api/leads?tab=leads&pageSize=1')).body.meta.total;
  assert.equal(all.ids.length, total); assert.equal(all.capped, false);
  const prog = (await admin.req('GET', `/api/leads/ids?tab=leads&status=${S.prog}`)).body.data;
  assert.ok(prog.ids.length < total && prog.ids.length > 0, 'filters apply to select-all');
  assert.equal((await new Client(srv.base).req('GET', '/api/leads/ids?tab=leads')).status, 401);

  const r = await admin.req('POST', '/api/leads', { phone: '9855500001', created_at: '2026-10-10T09:15' });
  assert.equal(r.status, 201);
  const [[row]] = await pool.query('SELECT created_at FROM leads WHERE id=?', [r.body.data.id]);
  assert.equal(new Date(row.created_at).toISOString(), '2026-10-10T03:45:00.000Z', '09:15 IST stored as UTC');
  const acts = (await admin.req('GET', `/api/leads/${r.body.data.id}/activities`)).body.data;
  assert.match(acts.find((a) => a.action_type === 'lead_created').summary, /set manually/);
  assert.equal((await admin.req('POST', '/api/leads', { phone: '9855500002', created_at: '2999-01-01T00:00' })).status, 400);
  assert.equal((await admin.req('POST', '/api/leads', { phone: '9855500003', created_at: 'not a date' })).status, 400);
  // the public form cannot back-date
  const pub = await fetch(srv.base + '/api/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '9855500004', created_at: '2020-01-01T00:00' }) });
  const pb = await pub.json();
  const [[prow]] = await pool.query('SELECT created_at FROM leads WHERE id=?', [pb.data.id]);
  assert.ok(new Date(prow.created_at).getFullYear() >= 2026 && Date.now() - new Date(prow.created_at).getTime() < 60000);
});

test('notes: the most recently copied note moves to the top of its category', async () => {
  const mk = async (title) => (await admin.req('POST', '/api/notes', { category: 'whatsapp', title, content: `body ${title}` })).body.data;
  const [a, b, c] = [await mk('RecA'), await mk('RecB'), await mk('RecC')];
  const order = async () => (await admin.req('GET', '/api/notes?category=whatsapp&q=Rec')).body.data.map((n) => n.title);
  await admin.req('POST', `/api/notes/${a.id}/copy`, {}); await new Promise((r) => setTimeout(r, 15));
  await admin.req('POST', `/api/notes/${b.id}/copy`, {}); await new Promise((r) => setTimeout(r, 15));
  await admin.req('POST', `/api/notes/${b.id}/copy`, {}); await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual((await order()).slice(0, 2), ['RecB', 'RecA']);
  await admin.req('POST', `/api/notes/${a.id}/copy`, {}); // A has 2 copies, B has 2: A is newest -> top
  assert.deepEqual(await order(), ['RecA', 'RecB', 'RecC'], 'copied last => first; never-copied last');
  await admin.req('POST', `/api/notes/${c.id}/copy`, { part: 'subject' }); // subject copies do not move a note
  assert.deepEqual(await order(), ['RecA', 'RecB', 'RecC']);
});

test('bulk assign: any user can assign leads to another user (or unassign); logged; owner changes, allocation untouched', async () => {
  const vik = new Client(srv.base); await vik.login('vikram@t.test', 'vikram-pass-123');
  const vikId = (await admin.req('GET', '/api/users')).body.data.find((u) => u.email === 'vikram@t.test').id;
  const l1 = (await admin.req('POST', '/api/leads', { phone: '9866600001' })).body.data;
  const l2 = (await admin.req('POST', '/api/leads', { phone: '9866600002' })).body.data;
  assert.equal((await new Client(srv.base).req('POST', '/api/leads/assign', { lead_ids: [l1.id], user_id: vikId })).status, 401);
  assert.equal((await a1.req('POST', '/api/leads/assign', { lead_ids: [], user_id: vikId })).status, 400);
  assert.equal((await a1.req('POST', '/api/leads/assign', { lead_ids: [l1.id], user_id: 999999 })).status, 400);
  // an AGENT assigns two leads to another agent
  const r = await a1.req('POST', '/api/leads/assign', { lead_ids: [l1.id, l2.id, 999999], user_id: vikId });
  assert.equal(r.body.data.assigned, 2); assert.deepEqual(r.body.data.skipped, [{ id: 999999, reason: 'not found' }]);
  assert.equal((await vik.req('GET', `/api/leads/${l1.id}`)).body.data.assigned_to.name, 'Vikram');
  assert.equal((await a1.req('GET', `/api/leads/${l1.id}`)).status, 404, 'previous (shared-pool) access ends');
  const acts = (await admin.req('GET', `/api/leads/${l1.id}/activities`)).body.data;
  assert.ok(acts.some((a) => a.action_type === 'assignment_changed' && /Unassigned → Vikram/.test(a.summary) && a.actor === 'Agent One'));
  assert.equal((await vik.req('POST', '/api/leads/assign', { lead_ids: [l1.id], user_id: vikId })).body.data.skipped[0].reason, 'already assigned to them');
  // allocation is a separate thing and survives re-assignment
  await admin.req('POST', '/api/leads/allocate', { lead_ids: [l2.id], user_id: U.a1.id });
  await vik.req('POST', '/api/leads/assign', { lead_ids: [l2.id], user_id: U.admin.id });
  const d2 = (await admin.req('GET', `/api/leads/${l2.id}`)).body.data;
  assert.equal(d2.assigned_to.name, 'Admin'); assert.equal(d2.allocated.to.name, 'Agent One');
  // unassign
  assert.equal((await vik.req('POST', '/api/leads/assign', { lead_ids: [l1.id], user_id: null })).body.data.assigned, 1);
  assert.equal((await admin.req('GET', `/api/leads/${l1.id}`)).body.data.assigned_to, null);
  // removed leads are skipped
  await admin.req('POST', `/api/leads/${l1.id}/remove`, { reason: 't' });
  assert.equal((await admin.req('POST', '/api/leads/assign', { lead_ids: [l1.id], user_id: vikId })).body.data.skipped[0].reason, 'removed');
});
