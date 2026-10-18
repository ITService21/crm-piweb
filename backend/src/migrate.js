import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from './config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Names of migration files that have not been applied to the configured database yet. */
export async function pendingMigrations() {
  const conn = await mysql.createConnection({ ...config.db, timezone: 'Z' });
  try {
    const [t] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'");
    const done = new Set(t[0].n ? (await conn.query('SELECT name FROM schema_migrations'))[0].map((r) => r.name) : []);
    return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().filter((f) => !done.has(f));
  } finally {
    await conn.end();
  }
}

export async function migrate(log = console.log) {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true, timezone: 'Z' });
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(190) PRIMARY KEY, applied_at DATETIME NOT NULL) ENGINE=InnoDB`);
    const [rows] = await conn.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      log(`applying ${file}`);
      await conn.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name, applied_at) VALUES (?, UTC_TIMESTAMP())', [file]);
    }
  } finally {
    await conn.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => { console.log('migrations up to date'); }).catch((e) => { console.error(e); process.exit(1); });
}
