import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db.js';
import { fail } from './lib/http.js';
import { HttpError } from './lib/errors.js';
import { csrfGuard, requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import leadRoutes from './routes/leads.js';
import settingsRoutes from './routes/settings.js';
import userRoutes from './routes/users.js';
import prefRoutes from './routes/preferences.js';
import notifRoutes from './routes/notifications.js';
import noteRoutes from './routes/notes.js';
import { billingRouter, billingMiscRouter } from './routes/billing.js';
import publicRoutes, { publicLeadHandler, publicLeadLimiter } from './routes/public.js';
import jwt from 'jsonwebtoken';
import { COOKIE_NAME } from './middleware/auth.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'wss:', 'ws:'], mediaSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"], frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', db: 'up', time: new Date().toISOString() }); }
    catch { res.status(503).json({ status: 'degraded', db: 'down' }); }
  });

  // Public lead intake: anyone may POST a lead (landing pages on other domains included). CORS is opened for
  // this one endpoint only; nothing else on the API is cross-origin accessible.
  const openCors = cors({ origin: '*', methods: ['POST', 'OPTIONS'], allowedHeaders: ['Content-Type'], maxAge: 86400 });
  app.options(['/api/leads', '/api/public/leads'], openCors);
  app.use('/api/public', openCors, publicRoutes);
  // POST /api/leads: with a valid CRM session it is the normal authenticated create (falls through below);
  // without one it is an anonymous public submission.
  app.post('/api/leads', openCors, (req, res, next) => {
    try { jwt.verify(req.cookies?.[COOKIE_NAME] || '', config.jwtSecret); return next(); } catch { /* anonymous */ }
    return publicLeadLimiter(req, res, (err) => (err ? next(err) : publicLeadHandler(req, res, next)));
  });

  app.use('/api', csrfGuard);
  app.use('/api/auth', authRoutes);
  app.use('/api/leads', requireAuth, leadRoutes);
  app.use('/api/settings', requireAuth, settingsRoutes);
  app.use('/api/users', requireAuth, userRoutes);
  app.use('/api/preferences', requireAuth, prefRoutes);
  app.use('/api/notifications', requireAuth, notifRoutes);
  app.use('/api/notes', requireAuth, noteRoutes);
  app.use('/api/invoices', requireAuth, billingRouter('invoice'));
  app.use('/api/quotations', requireAuth, billingRouter('quotation'));
  app.use('/api/billing', requireAuth, billingMiscRouter);
  app.use('/api', (_req, res) => fail(res, 404, 'Not found', 'NOT_FOUND'));

  // Optionally serve the built SPA (when not fronted by Nginx static serving).
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'dist');
  if (process.env.SERVE_FRONTEND === 'true' && fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return fail(res, err.status, err.message, err.code, err.details);
    if (err.name === 'MulterError') return fail(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (maximum 8 MB).' : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files (maximum 6 at a time).' : 'Upload failed.', 'UPLOAD_ERROR');
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'Malformed JSON', 'BAD_REQUEST');
    console.error('Unhandled error:', err.message);
    return fail(res, 500, 'Internal server error', 'INTERNAL');
  });
  return app;
}
