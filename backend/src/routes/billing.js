import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { wrap } from '../lib/errors.js';
import * as b from '../services/billing.js';
import { uploader, MAX_FILES } from '../services/proofs.js';
import { HttpError, forbidden } from '../lib/errors.js';

const idParam = (req) => parse(z.coerce.number().int().positive(), req.params.id);

/** One router factory for both document types: /api/invoices and /api/quotations behave the same way. */
export function billingRouter(type) {
  const r = Router();

  // Telecallers are view-only: every write is refused up front (sending by email / WhatsApp and the live calculator are not edits).
  r.use((req, _res, next) => {
    if (req.method === 'GET' || /\/(email|whatsapp-prepare|whatsapp-opened|calculate)$/.test(req.path)) return next();
    return ['admin', 'agent'].includes(req.user.role) ? next() : next(forbidden('Your role can view quotations and invoices but cannot change them.'));
  });

  r.get('/', wrap(async (req, res) => {
    const { items, meta } = await b.listDocuments(type, req.user, req.query);
    ok(res, items, meta);
  }));
  r.post('/calculate', wrap(async (req, res) => ok(res, b.calculatePreview(req.body)))); // live totals for the editor (nothing is saved)
  r.get('/prefill/:leadId', wrap(async (req, res) => ok(res, await b.getPrefill(type, parse(z.coerce.number().int().positive(), req.params.leadId), req.user))));

  r.post('/', wrap(async (req, res) => {
    const doc = await b.createDraft(type, req.body, req.user, { idempotencyKey: req.get('idempotency-key') || null });
    ok(res, doc, undefined, 201);
  }));
  r.get('/:id', wrap(async (req, res) => ok(res, await b.getDocument(type, idParam(req), req.user))));
  r.put('/:id', wrap(async (req, res) => ok(res, await b.updateDraft(type, idParam(req), req.body, req.user))));
  r.patch('/:id/internal-notes', wrap(async (req, res) => ok(res, await b.updateInternalNotes(type, idParam(req), req.body, req.user))));
  r.post('/:id/duplicate', wrap(async (req, res) => ok(res, await b.duplicateDocument(type, idParam(req), req.user), undefined, 201)));
  r.post('/:id/issue', wrap(async (req, res) => ok(res, await b.issueDocument(type, idParam(req), req.body, req.user))));
  r.post('/:id/cancel', wrap(async (req, res) => ok(res, await b.cancelDocument(type, idParam(req), req.body, req.user))));

  // Always rendered from the saved record on the server — never from values the browser supplies.
  r.get('/:id/pdf', wrap(async (req, res) => {
    const { buffer, filename } = await b.documentPdf(type, idParam(req), req.user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  }));
  r.get('/:id/email-defaults', wrap(async (req, res) => ok(res, await b.emailDefaults(type, idParam(req), req.user))));
  r.post('/:id/email', wrap(async (req, res) => ok(res, await b.emailDocument(type, idParam(req), req.body, req.user))));
  r.post('/:id/whatsapp-prepare', wrap(async (req, res) => ok(res, await b.whatsappPrepare(type, idParam(req), req.user))));
  r.post('/:id/whatsapp-opened', wrap(async (req, res) => ok(res, await b.whatsappOpened(type, idParam(req), req.body, req.user))));

  if (type === 'invoice') {
    r.patch('/:id/next-due', wrap(async (req, res) => ok(res, await b.setNextPaymentDue(idParam(req), req.body, req.user))));
    // payment proof files (images / PDF), shown with the payment they belong to
    r.post('/:id/payments/:pid/attachments', uploader.array('files', MAX_FILES), wrap(async (req, res) => {
      ok(res, await b.addPaymentProofs(idParam(req), parse(z.coerce.number().int().positive(), req.params.pid), req.files, req.user), undefined, 201);
    }));
    r.get('/:id/payments/:pid/attachments/:aid', wrap(async (req, res) => {
      const n = (v) => parse(z.coerce.number().int().positive(), v);
      const { file, mime, name } = await b.proofFile(idParam(req), n(req.params.pid), n(req.params.aid), req.user);
      res.setHeader('Content-Type', mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`);
      res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'File not found' } }); });
    }));
    r.delete('/:id/payments/:pid/attachments/:aid', wrap(async (req, res) => {
      const n = (v) => parse(z.coerce.number().int().positive(), v);
      ok(res, await b.deleteProof(idParam(req), n(req.params.pid), n(req.params.aid), req.user));
    }));
    r.post('/:id/payments', wrap(async (req, res) => {
      const out = await b.recordPayment(idParam(req), { ...req.body, idempotency_key: req.body?.idempotency_key ?? req.get('idempotency-key') ?? undefined }, req.user);
      ok(res, out, undefined, out.duplicate ? 200 : 201);
    }));
  } else {
    r.post('/:id/status', wrap(async (req, res) => ok(res, await b.setQuotationStatus(idParam(req), req.body, req.user))));
    r.post('/:id/accept', wrap(async (req, res) => ok(res, await b.respondQuotation(idParam(req), 'accept', req.user))));
    r.post('/:id/reject', wrap(async (req, res) => ok(res, await b.respondQuotation(idParam(req), 'reject', req.user))));
    r.post('/:id/convert', wrap(async (req, res) => ok(res, await b.convertQuotation(idParam(req), req.user), undefined, 201)));
  }
  return r;
}

/** Cross-type helpers. */
export const billingMiscRouter = Router();
billingMiscRouter.get('/by-lead/:leadId', wrap(async (req, res) => ok(res, await b.documentsForLead(parse(z.coerce.number().int().positive(), req.params.leadId), req.user))));

// Service presets (starter line items). Anyone can read the active ones; only admins manage them.
billingMiscRouter.get('/presets', wrap(async (req, res) => ok(res, await b.listPresets(req.user, req.query.include_inactive === '1'))));
billingMiscRouter.post('/presets', wrap(async (req, res) => ok(res, await b.createPreset(req.body, req.user), undefined, 201)));
billingMiscRouter.patch('/presets/:id', wrap(async (req, res) => ok(res, await b.updatePreset(idParam(req), req.body, req.user))));
billingMiscRouter.delete('/presets/:id', wrap(async (req, res) => { await b.deletePreset(idParam(req), req.user); ok(res, { deleted: true }); }));
