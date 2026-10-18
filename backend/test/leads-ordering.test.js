import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUsers, valueId, ist, pool } from './helpers.js';
const { createLead, updateLead } = await import('../src/services/leads.js');
const { listLeads, countByStatus, countByDateFilter } = await import('../src/services/leadQuery.js');

let U; let S; const L = {};
const NOW = ist('2026-10-18T11:00:00');

before(async () => {
  await resetDb(); U = await makeUsers();
  S = { new: await valueId('lead_status', 'new'), prog: await valueId('lead_status', 'in_progress'), ni: await valueId('lead_status', 'not_interested'), conv: await valueId('lead_status', 'converted') };
  const mk = async (name, { created = '2026-10-10T10:00:00', status, follow, phone } = {}) => {
    const lead = await createLead({ nickname: name, phone: phone || `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }, U.admin, { now: ist(created) });
    const patch = {};
    if (status) patch.status_id = status;
    if (follow) patch.next_followup_at = follow;
    if (Object.keys(patch).length) await updateLead(lead.id, patch, U.admin, ist('2026-10-12T10:00:00'));
    L[name] = lead.id;
  };
  await mk('A', { created: '2026-10-18T10:00:00', status: S.new });
  await mk('B', { created: '2026-10-18T10:30:00', follow: '2026-10-18T14:00' }); // new AND follow-up today
  await mk('C', { status: S.prog, follow: '2026-10-18T09:00' });
  await mk('D', { status: S.prog, follow: '2026-10-18T08:00' });
  await mk('E', { status: S.prog, follow: '2026-10-18T15:00' });
  await mk('F', { status: S.prog, follow: '2026-10-18T12:00' });
  await mk('K', { status: S.prog, follow: '2026-10-18T23:59' });
  await mk('G', { status: S.prog, follow: '2026-10-17T10:00' });
  await mk('L', { status: S.prog, follow: '2026-10-17T23:59' });
  await mk('H', { status: S.prog });
  await mk('I', { status: S.prog, follow: '2026-10-19T09:00' });
  await mk('J', { status: S.prog, follow: '2026-10-19T00:30' }); // IST Oct 19 = Oct 18 19:00Z (UTC date would be Oct 18!)
  // everything except A and B should not be "new": move seeded-new leads
});
after(async () => { await pool.end(); });

const names = (items) => items.map((i) => Object.keys(L).find((k) => L[k] === i.id));

test('default order: new, today (overdue first, oldest first, then nearest upcoming), then rest', async () => {
  // C..K were created as New status; move them out of "new" to In Progress already done via patch (status prog)
  const { items } = await listLeads(U.admin, { tab: 'leads' }, NOW);
  assert.deepEqual(names(items), ['B', 'A', 'D', 'C', 'F', 'E', 'K', 'G', 'L', 'H']);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'no duplicates');
});

test('priority reasons', async () => {
  const { items } = await listLeads(U.admin, { tab: 'leads' }, NOW);
  const r = Object.fromEntries(items.map((i) => [names([i])[0], i.priority_reason]));
  assert.equal(r.B, 'new'); assert.equal(r.D, 'overdue'); assert.equal(r.F, 'followup_today'); assert.equal(r.G, 'overdue'); assert.equal(r.H, null);
});

test('follow-up scheduled tab: future calendar days only, IST day boundary, earliest first', async () => {
  const { items } = await listLeads(U.admin, { tab: 'scheduled' }, NOW);
  assert.deepEqual(names(items), ['J', 'I']);
  const t = await listLeads(U.admin, { tab: 'scheduled', dateFilter: 'tomorrow' }, NOW);
  assert.deepEqual(names(t.items), ['J', 'I']);
});

test("today's follow-ups stay in 'today' after the time passes (11:00 and 23:30)", async () => {
  for (const now of ['2026-10-18T11:00:00', '2026-10-18T23:30:00']) {
    const { items } = await listLeads(U.admin, { tab: 'leads', dateFilter: 'today' }, ist(now));
    assert.deepEqual(names(items).sort(), ['B', 'C', 'D', 'E', 'F', 'K'], now);
  }
});

test('midnight rollover: scheduled lead becomes today and leaves Scheduled tab', async () => {
  const after = ist('2026-10-19T00:05:00');
  const sched = await listLeads(U.admin, { tab: 'scheduled' }, after);
  assert.equal(sched.items.length, 0, 'both Oct 19 follow-ups left the Scheduled tab');
  const today = await listLeads(U.admin, { tab: 'leads', dateFilter: 'today' }, after);
  assert.ok(names(today.items).includes('J') && names(today.items).includes('I'));
  assert.ok(!names(today.items).includes('K'), 'yesterday\'s 23:59 follow-up is now overdue, not today');
  const overdue = await listLeads(U.admin, { tab: 'leads', dateFilter: 'overdue' }, after);
  assert.ok(names(overdue.items).includes('K'));
});

test('overdue filter compares full timestamps', async () => {
  const { items } = await listLeads(U.admin, { tab: 'leads', dateFilter: 'overdue' }, NOW);
  assert.deepEqual(names(items).sort(), ['C', 'D', 'G', 'L']);
});

test('next 7 / custom ranges use calendar dates', async () => {
  const n7 = await listLeads(U.admin, { tab: 'scheduled', dateFilter: 'next7' }, NOW);
  assert.equal(n7.items.length, 2);
  const c = await listLeads(U.admin, { tab: 'scheduled', dateFilter: 'custom', from: '2026-10-19', to: '2026-10-19' }, NOW);
  assert.deepEqual(names(c.items), ['J', 'I']);
  const none = await listLeads(U.admin, { tab: 'scheduled', dateFilter: 'custom', from: '2026-10-20', to: '2026-10-25' }, NOW);
  assert.equal(none.items.length, 0);
});

test('new-leads filter uses creation calendar date', async () => {
  const { items } = await listLeads(U.admin, { tab: 'leads', dateFilter: 'new' }, NOW);
  assert.deepEqual(names(items).sort(), ['A', 'B']);
  const c = await listLeads(U.admin, { tab: 'leads', dateFilter: 'custom', dateField: 'created', from: '2026-10-18', to: '2026-10-18' }, NOW);
  assert.deepEqual(names(c.items).sort(), ['A', 'B']);
});

test('filters combine (status + search + assignment) and counts follow other filters', async () => {
  await updateLead(L.C, { assigned_to: U.a1.id }, U.admin, NOW);
  const r = await listLeads(U.admin, { tab: 'leads', statusId: S.prog, assigned: String(U.a1.id) }, NOW);
  assert.deepEqual(names(r.items), ['C']);
  const q = await listLeads(U.admin, { tab: 'leads', q: 'C' }, NOW); // nickname search
  assert.ok(names(q.items).includes('C'));
  const counts = await countByStatus(U.admin, { tab: 'leads', assigned: String(U.a1.id) }, NOW);
  assert.equal(counts.all, 1);
  assert.equal(counts.byStatus[S.prog], 1);
  const all = await countByStatus(U.admin, { tab: 'leads' }, NOW);
  assert.equal(all.all, 10);
});

test('pagination is stable and duplicate-free across pages', async () => {
  const seen = [];
  for (let page = 1; page <= 4; page++) {
    const { items, meta } = await listLeads(U.admin, { tab: 'leads', page, pageSize: 3 }, NOW);
    seen.push(...names(items));
    assert.equal(meta.total, 10);
  }
  assert.equal(seen.length, 10);
  assert.equal(new Set(seen).size, 10);
  assert.deepEqual(seen.slice(0, 3), ['B', 'A', 'D']);
});

test('moving a lead out of Active clears its follow-up and logs it; Not Interested tab shows it', async () => {
  await updateLead(L.G, { status_id: S.ni }, U.admin, NOW);
  const ni = await listLeads(U.admin, { tab: 'not_interested' }, NOW);
  assert.deepEqual(names(ni.items), ['G']);
  assert.equal(ni.items[0].next_followup_at, null);
  const [acts] = await pool.query('SELECT action_type FROM lead_activities WHERE lead_id=? ORDER BY id', [L.G]);
  assert.ok(acts.some((a) => a.action_type === 'status_changed') && acts.some((a) => a.action_type === 'followup_cleared'));
});

test('date-filter counts match each filter\'s list and follow search/status/assignee filters', async () => {
  const keys = ['all', 'new', 'today', 'overdue'];
  const counts = await countByDateFilter(U.admin, { tab: 'leads' }, NOW);
  for (const k of keys) {
    const { meta } = await listLeads(U.admin, { tab: 'leads', dateFilter: k }, NOW);
    assert.equal(counts[k], meta.total, k);
  }
  assert.equal(counts.custom, null, 'custom has no count until a range is chosen');
  const c2 = await countByDateFilter(U.admin, { tab: 'leads', dateFilter: 'custom', dateField: 'followup', from: '2026-10-18', to: '2026-10-18' }, NOW);
  assert.equal(c2.custom, (await listLeads(U.admin, { tab: 'leads', dateFilter: 'custom', dateField: 'followup', from: '2026-10-18', to: '2026-10-18' }, NOW)).meta.total);
  const s = await countByDateFilter(U.admin, { tab: 'scheduled' }, NOW);
  assert.equal(s.all, 2); assert.equal(s.tomorrow, 2);
  const filtered = await countByDateFilter(U.admin, { tab: 'leads', statusId: S.prog }, NOW);
  assert.equal(filtered.new, 0, 'In Progress leads are never "New Leads"');
});

test('priority-markup filter and counts', async () => {
  const hp = await valueId('special_markup', 'high_priority');
  await updateLead(L.H, { special_markup_id: hp }, U.admin, NOW);
  const r = await listLeads(U.admin, { tab: 'leads', markupId: hp }, NOW);
  assert.deepEqual(names(r.items), ['H']);
  const c = await countByStatus(U.admin, { tab: 'leads' }, NOW);
  assert.equal(c.byMarkup[hp], 1);
  assert.equal(c.markupAll, c.all);
  const c2 = await countByStatus(U.admin, { tab: 'leads', markupId: hp }, NOW);
  assert.equal(c2.all, 1, 'status counts follow the markup filter');
  assert.equal(c2.byMarkup[hp], 1, 'markup counts ignore the markup filter itself');
  assert.ok(c2.markupAll > 1);
});
