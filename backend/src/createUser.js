import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { createUser } from './seed.js';

// Usage: node src/createUser.js <email> <password> [role=agent] [name]
// Idempotent: an existing email is left unchanged (use Settings -> Users -> Reset password to change it).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const [email, password, role = 'agent', ...rest] = process.argv.slice(2);
    if (!email || !password) throw new Error('Usage: node src/createUser.js <email> <password> [admin|agent|telecaller] [name]');
    if (!['admin', 'agent', 'telecaller'].includes(role)) throw new Error('role must be admin, agent or telecaller');
    const min = config.isProd ? 10 : 8;
    if (password.length < min) throw new Error(`password must be at least ${min} characters`);
    await migrate(() => {});
    const [[u]] = await pool.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (u) console.log(`${email} already exists; left unchanged`);
    else {
      const name = rest.join(' ') || email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      await createUser({ name, email, password, role });
      console.log(`${role} ${email} created (name: ${name})`);
    }
    await pool.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
