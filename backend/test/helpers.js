process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'piweb_crm_test';
process.env.DB_USER = 'root';
process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD ?? ''; // never inherit the dev .env password
process.env.DB_HOST = '127.0.0.1';
process.env.DB_SOCKET = process.env.DB_SOCKET || '/tmp/pwcrm.sock';
process.env.BUSINESS_TZ = 'Asia/Kolkata';
process.env.UPLOAD_DIR = process.env.TEST_UPLOAD_DIR || '/tmp/pwcrm-test-uploads'; // test proofs never land in the project folder
process.env.PUBLIC_API_KEY = 'test-public-key';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.COOKIE_SECURE = 'false';
// Never let a developer's real SMTP settings (.env) leak into automated tests
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'MAIL_REPLY_TO']) process.env[k] = '';

import http from 'node:http';
import { DateTime } from 'luxon';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { seedDefaults, createUser } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');
const { attachSocket, closeSocket } = await import('../src/realtime/socket.js');
export { pool };

export async function resetDb() {
  const [t] = await pool.query('SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
  await pool.query('SET FOREIGN_KEY_CHECKS=0');
  for (const r of t) await pool.query(`DROP TABLE IF EXISTS \`${r.n}\``);
  await pool.query('SET FOREIGN_KEY_CHECKS=1');
  await migrate(() => {});
  await seedDefaults();
}

export async function makeUsers({ telecaller = false } = {}) {
  const admin = await createUser({ name: 'Admin', email: 'admin@t.test', password: 'password-admin-1', role: 'admin' });
  const a1 = await createUser({ name: 'Agent One', email: 'a1@t.test', password: 'password-agent-1', role: 'agent' });
  const a2 = await createUser({ name: 'Agent Two', email: 'a2@t.test', password: 'password-agent-2', role: 'agent' });
  const t1 = telecaller ? await createUser({ name: 'Tele One', email: 't1@t.test', password: 'password-tele-1', role: 'telecaller' }) : null;
  return {
    t1: t1 && { id: t1, role: 'telecaller', name: 'Tele One' },
    admin: { id: admin, role: 'admin', name: 'Admin' },
    a1: { id: a1, role: 'agent', name: 'Agent One' },
    a2: { id: a2, role: 'agent', name: 'Agent Two' },
  };
}

export async function valueId(category, key) {
  const [[r]] = await pool.query('SELECT id FROM selectable_values WHERE category=? AND value_key=?', [category, key]);
  return r.id;
}

/** IST wall-clock -> JS Date */
export const ist = (s) => DateTime.fromISO(s, { zone: 'Asia/Kolkata' }).toJSDate();

export async function startServer() {
  const server = http.createServer(createApp());
  attachSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: async () => { await closeSocket(); await new Promise((r) => server.close(r)); } };
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, path, body, headers = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'piweb-crm', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  login(email, password) { return this.req('POST', '/api/auth/login', { email, password }); }
}
