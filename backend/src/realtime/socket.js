import { Server } from 'socket.io';
import cookie from 'cookie';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool, parseJson } from '../db.js';
import { COOKIE_NAME } from '../middleware/auth.js';

let io = null;

export function attachSocket(httpServer) {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: config.appOrigin, credentials: true },
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  // Authenticate with the same httpOnly session cookie as the REST API.
  io.use(async (socket, next) => {
    try {
      const token = cookie.parse(socket.handshake.headers.cookie || '')[COOKIE_NAME];
      if (!token) return next(new Error('unauthenticated'));
      const { sub } = jwt.verify(token, config.jwtSecret);
      const [[u]] = await pool.query('SELECT id, role FROM users WHERE id = ? AND is_active = 1', [sub]);
      if (!u) return next(new Error('unauthenticated'));
      socket.data.user = u;
      next();
    } catch {
      next(new Error('unauthenticated'));
    }
  });

  io.on('connection', async (socket) => {
    const { id } = socket.data.user;
    socket.join(`user:${id}`);
    const last = Number(socket.handshake.auth?.lastSeq);
    if (Number.isFinite(last) && last > 0) {
      try { await replayMissed(socket, id, last); } catch (e) { console.error('replay failed', e.message); }
    }
  });
  return io;
}

/** Events committed while this user was offline (last 24h), only those they were a recipient of. */
async function replayMissed(socket, userId, lastSeq) {
  const [rows] = await pool.query(
    `SELECT o.id, o.payload FROM notifications n JOIN event_outbox o ON o.id = n.event_id
     WHERE n.user_id = ? AND o.id > ? AND o.published_at IS NOT NULL AND o.created_at > (UTC_TIMESTAMP() - INTERVAL 1 DAY)
     ORDER BY o.id LIMIT 50`, [userId, lastSeq]);
  for (const r of rows) socket.emit('lead:new', toClientEvent(r.id, parseJson(r.payload), true));
}

export function toClientEvent(seq, p, replayed = false) {
  const { recipients, channel, ...rest } = p; // never leak the audience list
  return { ...rest, seq, replayed };
}

export function emitToUsers(userIds, event, data) {
  if (!io) return;
  for (const uid of userIds) io.to(`user:${uid}`).emit(event, data);
}

/** Id-only ping so other sessions refetch through the authorised REST API. */
export function emitLeadChanged(leadId) {
  if (io) io.emit('lead:changed', { leadId });
}

export async function closeSocket() { if (io) await io.close(); io = null; }
