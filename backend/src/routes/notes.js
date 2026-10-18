import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { badRequest, forbidden, notFound, wrap } from '../lib/errors.js';

export const NOTE_CATEGORIES = ['whatsapp', 'email'];
const SHOW = 'n.id, n.category, n.title, n.subject, n.content, n.copy_count, n.last_copied_at, n.created_by, n.created_at, n.updated_at, u.name AS created_by_name';
const FROM = 'FROM notes n LEFT JOIN users u ON u.id = n.created_by';

const noteSchema = z.object({
  category: z.enum(NOTE_CATEGORIES),
  title: z.string().trim().min(1, 'Header is required').max(150),
  subject: z.string().trim().max(255).nullable().optional(),
  content: z.string().trim().min(1, 'Content is required').max(10000),
});

/** Only email notes carry a subject; WhatsApp notes never do. */
function normalise(d) {
  if (d.category === 'email') {
    if (!d.subject) throw badRequest('An email note needs a subject');
    return { ...d, subject: d.subject };
  }
  return { ...d, subject: null };
}

const idOf = (req) => parse(z.coerce.number().int().positive(), req.params.id);
const shape = (r) => ({ ...r, copy_count: Number(r.copy_count) });

async function getOne(id) {
  const [[row]] = await pool.query(`SELECT ${SHOW} ${FROM} WHERE n.id = ?`, [id]);
  if (!row) throw notFound('Note not found');
  return shape(row);
}

const r = Router();

// Within each category: most recently copied first (a note you just copied jumps to the top), never-copied notes after,
// ties broken by how often a note has been copied, then by last edit.
r.get('/', wrap(async (req, res) => {
  const { category, q } = parse(z.object({ category: z.enum(NOTE_CATEGORIES).optional(), q: z.string().trim().max(100).optional() }), req.query);
  const where = []; const params = [];
  if (category) { where.push('n.category = ?'); params.push(category); }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push('(n.title LIKE ? OR n.subject LIKE ? OR n.content LIKE ?)'); params.push(like, like, like);
  }
  const [rows] = await pool.query(
    `SELECT ${SHOW} ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY n.category, (n.last_copied_at IS NULL), n.last_copied_at DESC, n.copy_count DESC, n.updated_at DESC, n.id DESC LIMIT 500`, params);
  const [st] = await pool.query('SELECT category, COUNT(*) AS notes, COALESCE(SUM(copy_count),0) AS copies FROM notes GROUP BY category');
  const stats = { all: { notes: 0, copies: 0 } };
  for (const c of NOTE_CATEGORIES) stats[c] = { notes: 0, copies: 0 };
  for (const s of st) { stats[s.category] = { notes: Number(s.notes), copies: Number(s.copies) }; stats.all.notes += Number(s.notes); stats.all.copies += Number(s.copies); }
  ok(res, rows.map(shape), { stats });
}));

r.post('/', wrap(async (req, res) => {
  const d = normalise(parse(noteSchema, req.body));
  const now = new Date();
  const [ins] = await pool.query(
    'INSERT INTO notes (category,title,subject,content,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [d.category, d.title, d.subject, d.content, req.user.id, req.user.id, now, now]);
  ok(res, await getOne(ins.insertId), undefined, 201);
}));

r.patch('/:id', wrap(async (req, res) => {
  const id = idOf(req);
  const cur = await getOne(id);
  const d = normalise(parse(noteSchema, { category: cur.category, title: cur.title, subject: cur.subject, content: cur.content, ...req.body }));
  await pool.query('UPDATE notes SET category=?, title=?, subject=?, content=?, updated_by=?, updated_at=? WHERE id=?',
    [d.category, d.title, d.subject, d.content, req.user.id, new Date(), id]);
  ok(res, await getOne(id));
}));

// The team shares notes, so anyone can edit; only the author or an admin can delete.
r.delete('/:id', wrap(async (req, res) => {
  const cur = await getOne(idOf(req));
  if (req.user.role !== 'admin' && cur.created_by !== req.user.id) throw forbidden('Only the author or an admin can delete this note');
  await pool.query('DELETE FROM notes WHERE id = ?', [cur.id]);
  ok(res, { deleted: true });
}));

// Called when the user copies a note. Only copying the *content* counts toward ranking; copying an email subject does not.
r.post('/:id/copy', wrap(async (req, res) => {
  const { part } = parse(z.object({ part: z.enum(['content', 'subject']).default('content') }), req.body ?? {});
  const id = idOf(req);
  await getOne(id);
  if (part === 'content') await pool.query('UPDATE notes SET copy_count = copy_count + 1, last_copied_at = ? WHERE id = ?', [new Date(), id]);
  ok(res, await getOne(id));
}));

export default r;
