import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { resetDb, makeUsers, startServer, Client, pool } from './helpers.js';
const { publishPending } = await import('../src/services/outbox.js');

let srv; let U; let admin; let a1; let a2;
const cookieOf = (c) => c.cookie;
const sock = (client, auth = {}) => connect(srv.base, { extraHeaders: { cookie: cookieOf(client) }, auth, transports: ['websocket'], reconnection: false });
const once = (s, ev, ms = 1500) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout ${ev}`)), ms); s.once(ev, (d) => { clearTimeout(t); res(d); }); });
const collect = (s, ev) => { const a = []; s.on(ev, (d) => a.push(d)); return a; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await resetDb(); U = await makeUsers(); srv = await startServer();
  admin = new Client(srv.base); a1 = new Client(srv.base); a2 = new Client(srv.base);
  await admin.login('admin@t.test', 'password-admin-1'); await a1.login('a1@t.test', 'password-agent-1'); await a2.login('a2@t.test', 'password-agent-2');
});
after(async () => { await srv.close(); await pool.end(); });

test('unauthenticated sockets are rejected', async () => {
  const s = connect(srv.base, { transports: ['websocket'], reconnection: false });
  const err = await once(s, 'connect_error');
  assert.match(err.message, /unauthenticated/); s.close();
});

test('new lead is pushed (after commit) only to authorised recipients, with no audience leak', async () => {
  const sAdmin = sock(admin); const sA1 = sock(a1); const sA2 = sock(a2);
  await Promise.all([once(sAdmin, 'connect'), once(sA1, 'connect'), once(sA2, 'connect')]);
  const gotA2 = collect(sA2, 'lead:new');
  const pAdmin = once(sAdmin, 'lead:new'); const pA1 = once(sA1, 'lead:new');

  const r = await admin.req('POST', '/api/leads', { phone: '9811223344', assigned_to: U.a1.id, nickname: 'Secret' });
  assert.equal(r.status, 201);
  assert.equal(await publishPending(), 1);
  const [e1, e2] = await Promise.all([pAdmin, pA1]);
  assert.equal(e1.eventId, e2.eventId);
  assert.equal(e1.leadId, r.body.data.id); assert.equal(e1.enquiry, 'General Enquiry'); assert.equal(e1.phone, '+919811223344');
  assert.equal(e1.recipients, undefined);
  await wait(200);
  assert.equal(gotA2.length, 0, 'unrelated agent must not receive the lead');
  assert.equal(await publishPending(), 0, 'already-published events are not re-sent');
  [sAdmin, sA1, sA2].forEach((s) => s.close());
});

test('edits do not emit new-lead events; multiple leads keep distinct events in order', async () => {
  const s = sock(admin); await once(s, 'connect');
  const got = collect(s, 'lead:new');
  const ids = [];
  for (const p of ['9800000001', '9800000002', '9800000003']) ids.push((await admin.req('POST', '/api/leads', { phone: p })).body.data.id);
  await admin.req('PATCH', `/api/leads/${ids[0]}`, { nickname: 'edited' });
  await publishPending(); await wait(300);
  assert.equal(got.length, 3);
  assert.equal(new Set(got.map((g) => g.eventId)).size, 3);
  assert.deepEqual(got.map((g) => g.leadId), ids);
  assert.ok(got[0].seq < got[1].seq && got[1].seq < got[2].seq);
  s.close();
});

test('reconnect replays only missed events for that user (client dedupes by eventId/seq)', async () => {
  const s = sock(a1); await once(s, 'connect');
  const seen = collect(s, 'lead:new');
  await a1.req('POST', '/api/leads', { phone: '9800000010' });
  await publishPending(); await wait(200);
  const lastSeq = seen.at(-1).seq; s.close();
  // two leads arrive while a1 is offline
  await admin.req('POST', '/api/leads', { phone: '9800000011' });
  await admin.req('POST', '/api/leads', { phone: '9800000012', assigned_to: U.a2.id }); // not for a1
  await publishPending();
  const s2 = sock(a1, { lastSeq }); const replay = collect(s2, 'lead:new'); await once(s2, 'connect'); await wait(400);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].replayed, true); assert.equal(replay[0].phone, '+919800000011');
  s2.close();
});

test('outbox row survives realtime outage: unpublished events are delivered once the publisher runs', async () => {
  const r = await admin.req('POST', '/api/leads', { phone: '9800000020' }); // publisher not running => stays pending
  const [[ob]] = await pool.query('SELECT published_at FROM event_outbox WHERE lead_id=?', [r.body.data.id]);
  assert.equal(ob.published_at, null);
  const s = sock(admin); await once(s, 'connect');
  const p = once(s, 'lead:new');
  await publishPending();
  assert.equal((await p).leadId, r.body.data.id);
  s.close();
});
