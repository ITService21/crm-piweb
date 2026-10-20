import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db.js';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { wrap } from '../lib/errors.js';
import { createLead } from '../services/leads.js';
import { documentPdfByToken } from '../services/billing.js';

/** Open to the internet by design: per-IP throttle on top of field whitelisting and a honeypot. */
export const publicLeadLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again shortly.' } },
});

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
/** "Business Name", "business_name", "businessName" all become "businessname". */
const normaliseKeys = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).map(([k, v]) => [squash(k), v]));

const str = (max) => z.preprocess((v) => (v == null ? undefined : typeof v === 'string' || typeof v === 'number' ? String(v).trim() : v), z.string().max(max).optional());
// Only these fields are ever read from an anonymous caller; status, assignment, markup etc. are ignored.
const schema = z.object({
  name: str(120), nickname: str(120), phone: str(30), email: str(190), businessname: str(190), requirement: str(255),
  enquirytype: str(64), budget: str(100), message: str(5000),
  website: str(200), // honeypot: real visitors never see/fill this field
});

/** Match the free-text requirement to a configured Enquiry Type by key or label ("E-commerce" -> "E-commerce Enquiry"). */
async function matchEnquiryType(requirement) {
  if (!requirement) return null;
  const want = squash(requirement);
  const [rows] = await pool.query(`SELECT id, value_key, label FROM selectable_values WHERE category='enquiry_type' AND is_active=1`);
  const hit = rows.find((e) => squash(e.value_key) === want || squash(e.label) === want)
    || rows.find((e) => squash(e.label).startsWith(want) || squash(e.value_key).startsWith(want));
  return hit?.id ?? null;
}

/** Anonymous lead submission: Body { name|nickname, phone, email, business_name, requirement, budget, message }. */
export const publicLeadHandler = wrap(async (req, res) => {
  const d = parse(schema, normaliseKeys(req.body));
  if (d.website) return ok(res, { received: true }, undefined, 201); // bot: pretend success, save nothing
  const lead = await createLead({
    nickname: d.name || d.nickname || null, phone: d.phone || null, email: d.email || null,
    business_name: d.businessname || null, requirement: d.requirement || null, budget: d.budget || null,
    message: d.message || null, enquiry_type_id: await matchEnquiryType(d.enquirytype || d.requirement),
  }, null, { channel: 'website', lenientEmail: true });
  ok(res, { id: lead.id, lead_code: lead.lead_code }, undefined, 201);
});

const r = Router();
r.post('/leads', publicLeadLimiter, publicLeadHandler);

// Read-only PDF behind an unguessable link (shared e.g. over WhatsApp). Throttled per visitor; never indexed or cached.
const pdfLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => ipKeyGenerator(req.ip),
  skip: () => process.env.NODE_ENV === 'test', message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});
r.get('/documents/:token/pdf', pdfLimiter, wrap(async (req, res) => {
  const { buffer, filename } = await documentPdfByToken(req.params.token);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}));
export default r;
