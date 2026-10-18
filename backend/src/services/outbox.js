import { pool, parseJson } from '../db.js';
import { emitToUsers, toClientEvent } from '../realtime/socket.js';

let timer = null;
let busy = false;

/** Publish committed-but-unpublished events. Safe to call repeatedly; marks rows only after emit. */
export async function publishPending(limit = 50) {
  if (busy) return 0;
  busy = true;
  try {
    const [rows] = await pool.query('SELECT id, payload FROM event_outbox WHERE published_at IS NULL ORDER BY id LIMIT ?', [limit]);
    for (const r of rows) {
      const p = parseJson(r.payload);
      emitToUsers(p.recipients || [], 'lead:new', toClientEvent(r.id, p));
      await pool.query('UPDATE event_outbox SET published_at = ? WHERE id = ? AND published_at IS NULL', [new Date(), r.id]);
    }
    return rows.length;
  } finally {
    busy = false;
  }
}

export function startPublisher(intervalMs = 1000) {
  stopPublisher();
  timer = setInterval(() => publishPending().catch((e) => console.error('outbox publish failed:', e.message)), intervalMs);
  timer.unref?.();
}
export function stopPublisher() { if (timer) clearInterval(timer); timer = null; }

/** Housekeeping: drop published events older than 30 days (notifications cascade-less, kept for read state). */
export async function pruneOutbox() {
  await pool.query('DELETE FROM event_outbox WHERE published_at IS NOT NULL AND created_at < (UTC_TIMESTAMP() - INTERVAL 30 DAY)');
}
