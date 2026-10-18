import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { attachSocket } from './realtime/socket.js';
import { startPublisher, stopPublisher, pruneOutbox } from './services/outbox.js';
import { migrate, pendingMigrations } from './migrate.js';

// Never run new code against an old schema: development applies pending migrations; production refuses to start.
const pending = await pendingMigrations();
if (pending.length) {
  if (config.isProd) {
    console.error(`Database is missing migrations: ${pending.join(', ')}. Run "npm run migrate" in backend/, then restart.`);
    process.exit(1);
  }
  console.log(`Applying pending migrations: ${pending.join(', ')}`);
  await migrate();
}

const server = http.createServer(createApp());
attachSocket(server);
startPublisher(1000);
setInterval(() => pruneOutbox().catch(() => {}), 6 * 3600 * 1000).unref();

server.listen(config.port, '127.0.0.1', () => console.log(`Piweb CRM API listening on 127.0.0.1:${config.port} (${config.isProd ? 'production' : 'development'})`));

async function shutdown() {
  stopPublisher();
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
