import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { wrap } from '../lib/errors.js';
import * as leads from '../services/leads.js';
import { listLeads, listLeadIds, countByStatus, countByDateFilter, sidebarSummary } from '../services/leadQuery.js';
import { emitLeadChanged, emitToUsers } from '../realtime/socket.js';

const idParam = (req) => parse(z.coerce.number().int().positive(), req.params.id);

const querySchema = z.object({
  tab: z.enum(['leads', 'not_interested', 'converted', 'scheduled', 'removed']).default('leads'),
  status: z.coerce.number().int().positive().optional(),
  markup: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(),
  assigned: z.string().max(20).optional(),
  dateFilter: z.string().max(20).optional(),
  dateField: z.enum(['created', 'followup']).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  sort: z.string().max(30).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});
const filters = (req) => { const q = parse(querySchema, req.query); return { ...q, statusId: q.status, markupId: q.markup }; };

const r = Router();

r.get('/', wrap(async (req, res) => {
  const { items, meta } = await listLeads(req.user, filters(req));
  ok(res, items, meta);
}));
r.get('/counts', wrap(async (req, res) => ok(res, await countByStatus(req.user, filters(req)))));
r.get('/date-counts', wrap(async (req, res) => ok(res, await countByDateFilter(req.user, filters(req)))));
r.get('/ids', wrap(async (req, res) => ok(res, await listLeadIds(req.user, filters(req)))));
r.get('/summary', wrap(async (req, res) => ok(res, await sidebarSummary(req.user))));

// Bulk allocate / clear. Must be declared before the /:id routes.
r.post('/allocate', wrap(async (req, res) => {
  const out = await leads.allocateLeads(req.body, req.user);
  if (out.allocated) {
    emitLeadChanged(0);
    if (out.user && out.user.id !== req.user.id) emitToUsers([out.user.id], 'leads:allocated', { count: out.allocated, by: req.user.name });
  }
  ok(res, { allocated: out.allocated, skipped: out.skipped });
}));

r.post('/assign', wrap(async (req, res) => {
  const out = await leads.assignLeads(req.body, req.user);
  if (out.assigned) {
    emitLeadChanged(0);
    if (out.user && out.user.id !== req.user.id) emitToUsers([out.user.id], 'leads:assigned', { count: out.assigned, by: req.user.name });
  }
  ok(res, { assigned: out.assigned, skipped: out.skipped });
}));

r.post('/', wrap(async (req, res) => {
  const lead = await leads.createLead(req.body, req.user, { channel: 'manual' });
  ok(res, lead, undefined, 201);
}));
r.get('/:id', wrap(async (req, res) => ok(res, await leads.getLead(idParam(req), req.user))));

const changed = (res, lead) => { emitLeadChanged(lead.id); return ok(res, lead); };
r.patch('/:id', wrap(async (req, res) => changed(res, await leads.updateLead(idParam(req), req.body, req.user))));
r.post('/:id/status', wrap(async (req, res) => {
  const { status_id } = parse(z.object({ status_id: z.number().int().positive() }), req.body);
  changed(res, await leads.updateLead(idParam(req), { status_id }, req.user));
}));
r.post('/:id/followup', wrap(async (req, res) => {
  const { next_followup_at } = parse(z.object({ next_followup_at: z.string().nullable() }), req.body);
  changed(res, await leads.updateLead(idParam(req), { next_followup_at }, req.user));
}));

r.post('/:id/remove', wrap(async (req, res) => changed(res, await leads.removeLead(idParam(req), req.body, req.user))));
r.post('/:id/restore', wrap(async (req, res) => changed(res, await leads.restoreLead(idParam(req), req.user))));

r.get('/:id/remarks', wrap(async (req, res) => ok(res, await leads.listRemarks(idParam(req), req.user))));
r.post('/:id/remarks', wrap(async (req, res) => {
  const id = idParam(req);
  const remark = await leads.addRemark(id, req.body, req.user);
  emitLeadChanged(id);
  ok(res, remark, undefined, 201);
}));
r.get('/:id/activities', wrap(async (req, res) => ok(res, await leads.listActivities(idParam(req), req.user))));

export default r;
