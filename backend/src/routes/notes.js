import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';

export const NOTE_KINDS = ['message', 'email'];
const SHOW = `n.id, n.category_id, c.name AS category_name, c.colour AS category_colour, n.kind, n.title, n.subject, n.content,
  n.copy_count, n.last_copied_at, n.created_by, n.created_at, n.updated_at, u.name AS created_by_name`;
const FROM = 'FROM notes n LEFT JOIN note_categories c ON c.id = n.category_id LEFT JOIN users u ON u.id = n.created_by';
const PALETTE = ['#16a34a', '#f59e0b', '#6366f1', '#0ea5e9', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#64748b'];

const noteSchema = z.object({
  category_id: z.number().int().positive(),
  kind: z.enum(NOTE_KINDS),
  title: z.string().trim().min(1, 'Header is required').max(150),
  subject: z.string().trim().max(255).nullable().optional(),
  content: z.string().trim().min(1, 'Content is required').max(10000),
});
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB colour');
const catSchema = z.object({ name: z.string().trim().min(1, 'Category name is required').max(60), colour: colour.optional() });

const idOf = (req) => parse(z.coerce.number().int().positive(), req.params.id);
const shape = (r) => ({ ...r, copy_count: Number(r.copy_count) });

/** Only email notes carry a subject; plain messages never do. */
function normalise(d) {
  if (d.kind === 'email') {
    if (!d.subject) throw badRequest('An email note needs a subject');
    return d;
  }
  return { ...d, subject: null };
}

async function requireCategory(id) {
  const [[c]] = await pool.query('SELECT id FROM note_categories WHERE id = ?', [id]);
  if (!c) throw badRequest('That category does not exist');
}
async function getOne(id) {
  const [[row]] = await pool.query(`SELECT ${SHOW} ${FROM} WHERE n.id = ?`, [id]);
  if (!row) throw notFound('Note not found');
  return shape(row);
}
async function listCategories() {
  const [rows] = await pool.query(
    `SELECT c.id, c.name, c.colour, c.sort_order, COUNT(n.id) AS notes, COALESCE(SUM(n.copy_count),0) AS copies
     FROM note_categories c LEFT JOIN notes n ON n.category_id = c.id GROUP BY c.id ORDER BY c.sort_order, c.name`);
  return rows.map((r) => ({ ...r, notes: Number(r.notes), copies: Number(r.copies) }));
}

const r = Router();

// ---------- categories (declared before /:id routes) ----------
r.get('/categories', wrap(async (_req, res) => ok(res, await listCategories())));

r.post('/categories', wrap(async (req, res) => {
  const d = parse(catSchema, req.body);
  const [[n]] = await pool.query('SELECT COUNT(*) AS n, COALESCE(MAX(sort_order),0) AS m FROM note_categories');
  const now = new Date();
  try {
    const [ins] = await pool.query('INSERT INTO note_categories (name,colour,sort_order,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [d.name, d.colour ?? PALETTE[n.n % PALETTE.length], n.m + 10, req.user.id, now, now]);
    ok(res, (await listCategories()).find((c) => c.id === ins.insertId), undefined, 201);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict(`A category named "${d.name}" already exists`);
    throw e;
  }
}));

r.patch('/categories/:id', wrap(async (req, res) => {
  const id = idOf(req);
  const d = parse(catSchema.partial().extend({ sort_order: z.number().int().min(0).max(100000).optional() }), req.body);
  const [[cur]] = await pool.query('SELECT * FROM note_categories WHERE id = ?', [id]);
  if (!cur) throw notFound('Category not found');
  try {
    await pool.query('UPDATE note_categories SET name=?, colour=?, sort_order=?, updated_at=? WHERE id=?',
      [d.name ?? cur.name, d.colour ?? cur.colour, d.sort_order ?? cur.sort_order, new Date(), id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict(`A category named "${d.name}" already exists`);
    throw e;
  }
  ok(res, (await listCategories()).find((c) => c.id === id));
}));

// A category can only be deleted when empty, so notes are never lost by accident.
r.delete('/categories/:id', wrap(async (req, res) => {
  const id = idOf(req);
  const cats = await listCategories();
  const cur = cats.find((c) => c.id === id);
  if (!cur) throw notFound('Category not found');
  if (cur.notes > 0) throw conflict(`"${cur.name}" still has ${cur.notes} note${cur.notes === 1 ? '' : 's'}. Move or delete them first.`, { notes: cur.notes });
  await pool.query('DELETE FROM note_categories WHERE id = ?', [id]);
  ok(res, { deleted: true });
}));

// ---------- notes ----------
// Within each category: most recently copied first, never-copied after, ties by copy count then last edit.
r.get('/', wrap(async (req, res) => {
  const { category_id: categoryId, q } = parse(z.object({ category_id: z.coerce.number().int().positive().optional(), q: z.string().trim().max(100).optional() }), req.query);
  const where = []; const params = [];
  if (categoryId) { where.push('n.category_id = ?'); params.push(categoryId); }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push('(n.title LIKE ? OR n.subject LIKE ? OR n.content LIKE ?)'); params.push(like, like, like);
  }
  const [rows] = await pool.query(
    `SELECT ${SHOW} ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.sort_order, c.name, (n.last_copied_at IS NULL), n.last_copied_at DESC, n.copy_count DESC, n.updated_at DESC, n.id DESC LIMIT 500`, params);
  const categories = await listCategories();
  ok(res, rows.map(shape), { categories, total: categories.reduce((a, c) => a + c.notes, 0), copies: categories.reduce((a, c) => a + c.copies, 0) });
}));

r.post('/', wrap(async (req, res) => {
  const d = normalise(parse(noteSchema, req.body));
  await requireCategory(d.category_id);
  const now = new Date();
  const [ins] = await pool.query(
    'INSERT INTO notes (category_id,kind,title,subject,content,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [d.category_id, d.kind, d.title, d.subject, d.content, req.user.id, req.user.id, now, now]);
  ok(res, await getOne(ins.insertId), undefined, 201);
}));

r.patch('/:id', wrap(async (req, res) => {
  const id = idOf(req);
  const cur = await getOne(id);
  const d = normalise(parse(noteSchema, { category_id: cur.category_id, kind: cur.kind, title: cur.title, subject: cur.subject, content: cur.content, ...req.body }));
  await requireCategory(d.category_id);
  await pool.query('UPDATE notes SET category_id=?, kind=?, title=?, subject=?, content=?, updated_by=?, updated_at=? WHERE id=?',
    [d.category_id, d.kind, d.title, d.subject, d.content, req.user.id, new Date(), id]);
  ok(res, await getOne(id));
}));

// The team shares notes, so anyone can edit; only the author or an admin can delete.
r.delete('/:id', wrap(async (req, res) => {
  const cur = await getOne(idOf(req));
  if (req.user.role !== 'admin' && cur.created_by !== req.user.id) throw forbidden('Only the author or an admin can delete this note');
  await pool.query('DELETE FROM notes WHERE id = ?', [cur.id]);
  ok(res, { deleted: true });
}));

// Only copying the *content* moves a note to the top; copying an email subject does not.
r.post('/:id/copy', wrap(async (req, res) => {
  const { part } = parse(z.object({ part: z.enum(['content', 'subject']).default('content') }), req.body ?? {});
  const id = idOf(req);
  await getOne(id);
  if (part === 'content') await pool.query('UPDATE notes SET copy_count = copy_count + 1, last_copied_at = ? WHERE id = ?', [new Date(), id]);
  ok(res, await getOne(id));
}));

export default r;
