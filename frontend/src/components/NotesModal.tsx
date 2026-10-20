import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { copyText } from '../lib/clipboard';
import type { Note, NoteCategory, NoteKind } from '../lib/types';
import { useAuth } from '../store';
import { useRealtime } from '../realtime';
import { ErrorState, Modal, Spinner, errMsg } from './ui';

type Tab = 'all' | number; // 'all' or a category id
interface Meta { categories: NoteCategory[]; total: number; copies: number }

const TAB_KEY = 'piweb_crm_notes_tab';
const readTab = (): Tab => { try { const v = localStorage.getItem(TAB_KEY); return v && v !== 'all' && Number(v) > 0 ? Number(v) : 'all'; } catch { return 'all'; } };

/** Mirrors the server order: recently copied first, never-copied after, then most copied, then latest edit. */
const byRecentCopy = (a: Note, b: Note) => {
  if (a.category_id !== b.category_id) return (a.category_id ?? 0) - (b.category_id ?? 0); // groups stay together; display groups by category
  if (!!a.last_copied_at !== !!b.last_copied_at) return a.last_copied_at ? -1 : 1;
  if (a.last_copied_at && b.last_copied_at && a.last_copied_at !== b.last_copied_at) return a.last_copied_at < b.last_copied_at ? 1 : -1;
  if (a.copy_count !== b.copy_count) return b.copy_count - a.copy_count;
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id;
};

const CopyIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
const CheckIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5 9-10" /></svg>;

function CategoryBadge({ name, colour }: { name: string | null; colour: string | null }) {
  const c = colour || '#64748b';
  return <span className="rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide" style={{ backgroundColor: `${c}1f`, color: c }}>{name ?? 'No category'}</span>;
}

function NoteCard({ n, canDelete, showCategory, onCopy, onEdit, onDelete }: { n: Note; canDelete: boolean; showCategory: boolean; onCopy(n: Note, part: 'content' | 'subject'): Promise<boolean>; onEdit(): void; onDelete(): void }) {
  const [done, setDone] = useState<'' | 'content' | 'subject'>('');
  const [open, setOpen] = useState(false);
  const timer = useRef<number>();
  const copy = async (part: 'content' | 'subject') => {
    if (await onCopy(n, part)) { setDone(part); clearTimeout(timer.current); timer.current = window.setTimeout(() => setDone(''), 1600); }
  };
  const btn = (part: 'content' | 'subject', label: string, primary: boolean) => (
    <button onClick={() => copy(part)} className={`btn !py-1.5 text-xs ${done === part ? 'bg-emerald-600 text-white' : primary ? 'btn-primary' : 'btn-ghost'}`}>
      {done === part ? <CheckIcon /> : <CopyIcon />}{done === part ? 'Copied' : label}
    </button>
  );
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {showCategory && <CategoryBadge name={n.category_name} colour={n.category_colour} />}
            {n.kind === 'email' && <span className="rounded bg-amber-100 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-amber-700">Email</span>}
            <h3 className="truncate text-sm font-semibold text-slate-900">{n.title}</h3>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">Copied {n.copy_count}× · {n.created_by_name ?? 'Unknown'}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button onClick={onEdit} className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100" aria-label={`Edit ${n.title}`}>Edit</button>
          {canDelete && <button onClick={onDelete} className="rounded-lg px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50" aria-label={`Delete ${n.title}`}>Delete</button>}
        </div>
      </div>
      {n.subject && <p className="mt-2 rounded-lg bg-amber-50/70 px-2 py-1 text-xs text-slate-700"><span className="font-semibold text-amber-700">Subject: </span>{n.subject}</p>}
      <button onClick={() => setOpen(!open)} className="mt-2 block w-full text-left" title={open ? 'Collapse' : 'Expand'}>
        <p className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-700 ${open ? '' : 'line-clamp-3'}`}>{n.content}</p>
      </button>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {n.kind === 'email' && btn('subject', 'Copy subject', false)}
        {btn('content', n.kind === 'email' ? 'Copy content' : 'Copy message', true)}
      </div>
    </li>
  );
}

function NoteForm({ note, categories, defaultCategory, onCancel, onSaved }: { note: Note | null; categories: NoteCategory[]; defaultCategory: number | null; onCancel(): void; onSaved(): void }) {
  const { toast } = useRealtime();
  const [f, setF] = useState({ category_id: note?.category_id ?? defaultCategory ?? categories[0]?.id ?? 0, kind: (note?.kind ?? 'message') as NoteKind, title: note?.title ?? '', subject: note?.subject ?? '', content: note?.content ?? '' });
  const [cats, setCats] = useState(categories);
  const [newCat, setNewCat] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');

  const createCategory = async () => {
    if (!newCat?.trim()) return;
    try { const r = await post<NoteCategory>('/notes/categories', { name: newCat }); setCats((c) => [...c, r.data]); setF((x) => ({ ...x, category_id: r.data.id })); setNewCat(null); }
    catch (e) { setErr(errMsg(e)); }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.category_id) { setErr('Choose or create a category first.'); return; }
    setBusy(true); setErr('');
    const body = { category_id: f.category_id, kind: f.kind, title: f.title, content: f.content, ...(f.kind === 'email' ? { subject: f.subject } : {}) };
    try { if (note) await patch(`/notes/${note.id}`, body); else await post('/notes', body); toast('info', note ? 'Note updated' : 'Note created'); onSaved(); }
    catch (ex) { setErr(errMsg(ex)); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="label" htmlFor="n-cat">Category</label>
        {newCat === null ? (
          <select id="n-cat" className="input" value={f.category_id || ''} onChange={(e) => (e.target.value === 'new' ? setNewCat('') : setF({ ...f, category_id: Number(e.target.value) }))}>
            {cats.length === 0 && <option value="">No categories yet</option>}
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="new">＋ New category…</option>
          </select>
        ) : (
          <div className="flex gap-2">
            <input autoFocus className="input" maxLength={60} placeholder="e.g. Website Template" value={newCat} onChange={(e) => setNewCat(e.target.value)} aria-label="New category name"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createCategory(); } }} />
            <button type="button" className="btn btn-primary" disabled={!newCat.trim()} onClick={createCategory}>Add</button>
            <button type="button" className="btn btn-ghost" onClick={() => setNewCat(null)}>Cancel</button>
          </div>
        )}
      </div>
      <div>
        <label className="label">Format</label>
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
          {([['message', 'Message (one copy button)'], ['email', 'Email (subject + content)']] as const).map(([k, label]) => (
            <button type="button" key={k} onClick={() => setF({ ...f, kind: k })} className={`px-3 py-1.5 text-sm font-medium ${f.kind === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{label}</button>
          ))}
        </div>
      </div>
      <div><label className="label" htmlFor="n-title">Header</label><input id="n-title" className="input" required maxLength={150} autoFocus={!!note || cats.length > 0} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. First reply to a website enquiry" /></div>
      {f.kind === 'email' && <div><label className="label" htmlFor="n-sub">Email subject</label><input id="n-sub" className="input" required maxLength={255} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="Subject line of the email" /></div>}
      <div><label className="label" htmlFor="n-body">Content <span className="text-slate-400">(only this is copied by “Copy {f.kind === 'email' ? 'content' : 'message'}”)</span></label>
        <textarea id="n-body" className="input min-h-[190px] font-[inherit] leading-relaxed" required maxLength={10000} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} placeholder="Paste or type your script…" />
        <p className="mt-0.5 text-right text-[11px] text-slate-400">{f.content.length} / 10000</p></div>
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : note ? 'Save changes' : 'Create note'}</button></div>
    </form>
  );
}

/** Rename / recolour / delete the selected category. */
function CategoryEditor({ cat, onClose, onChanged }: { cat: NoteCategory; onClose(): void; onChanged(deleted: boolean): void }) {
  const { toast } = useRealtime();
  const [name, setName] = useState(cat.name); const [colour, setColour] = useState(cat.colour || '#6366f1');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try { await patch(`/notes/categories/${cat.id}`, { name, colour }); toast('info', 'Category updated'); onChanged(false); onClose(); }
    catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the category "${cat.name}"?`)) return;
    try { await del(`/notes/categories/${cat.id}`); toast('info', 'Category deleted'); onChanged(true); onClose(); }
    catch (e) { setErr(errMsg(e)); }
  };
  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[10rem] flex-1"><label className="label" htmlFor="cat-name">Category name</label><input id="cat-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="label" htmlFor="cat-col">Colour</label><input id="cat-col" type="color" className="h-9 w-12 rounded border border-slate-200" value={colour} onChange={(e) => setColour(e.target.value)} /></div>
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>Save</button>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-ghost ml-auto text-red-600" onClick={remove} disabled={cat.notes > 0} title={cat.notes > 0 ? 'Move or delete its notes first' : 'Delete this category'}>Delete category</button>
      </div>
      {cat.notes > 0 && <p className="mt-1.5 text-[11px] text-slate-500">A category can be deleted once it has no notes ({cat.notes} now).</p>}
      {err && <p className="mt-1.5 text-sm text-red-600" role="alert">{err}</p>}
    </div>
  );
}

/** All notes in one place: your own categories, search, copy buttons, and create / edit / delete. */
export function NotesModal({ onClose }: { onClose(): void }) {
  const { me } = useAuth();
  const { toast } = useRealtime();
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab) => { setTabState(t); setEditCat(false); try { localStorage.setItem(TAB_KEY, String(t)); } catch { /* storage unavailable */ } };
  const [q, setQ] = useState(''); const [qd, setQd] = useState('');
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [meta, setMeta] = useState<Meta>({ categories: [], total: 0, copies: 0 });
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  const [editCat, setEditCat] = useState(false);
  const [addingCat, setAddingCat] = useState(false); const [catName, setCatName] = useState('');

  useEffect(() => { const t = setTimeout(() => setQd(q), 250); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    setErr('');
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('category_id', String(tab));
      if (qd) params.set('q', qd);
      const r = await get<Note[]>(`/notes?${params}`);
      const m = r.meta as unknown as Meta;
      setNotes(r.data); setMeta(m);
      if (tab !== 'all' && !m.categories.some((c) => c.id === tab)) setTab('all'); // remembered category was deleted
    } catch (e) { setErr(errMsg(e)); }
  }, [tab, qd]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const onCopy = async (n: Note, part: 'content' | 'subject') => {
    const ok = await copyText(part === 'subject' ? (n.subject ?? '') : n.content);
    if (!ok) { toast('error', 'Could not copy', 'Select the text and copy it manually.'); return false; }
    try {
      const r = await post<Note>(`/notes/${n.id}/copy`, { part });
      setNotes((list) => list && list.map((x) => (x.id === n.id ? { ...x, copy_count: r.data.copy_count, last_copied_at: r.data.last_copied_at } : x)));
      // Let the "Copied" confirmation play, then float the note to the top of its category
      if (part === 'content') window.setTimeout(() => setNotes((list) => list && [...list].sort(byRecentCopy)), 2000);
    } catch { /* copying succeeded; the counter is best-effort */ }
    return true;
  };
  const remove = async (n: Note) => {
    if (!window.confirm(`Delete the note "${n.title}"?`)) return;
    try { await del(`/notes/${n.id}`); toast('info', 'Note deleted'); void load(); } catch (e) { toast('error', 'Could not delete', errMsg(e)); }
  };
  const addCategory = async () => {
    if (!catName.trim()) return;
    try { const r = await post<NoteCategory>('/notes/categories', { name: catName }); setCatName(''); setAddingCat(false); setTab(r.data.id); toast('info', `Category "${r.data.name}" created`); }
    catch (e) { toast('error', 'Could not create category', errMsg(e)); }
  };

  const selected = tab === 'all' ? null : meta.categories.find((c) => c.id === tab) ?? null;
  const groups = tab === 'all' ? meta.categories : selected ? [selected] : [];
  const chip = (active: boolean) => `shrink-0 rounded-xl border px-3 py-1.5 text-left transition ${active ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-slate-200 bg-white hover:bg-slate-50'}`;

  return (
    <Modal tall title={editing ? (editing === 'new' ? 'New note' : 'Edit note') : 'Notes'} onClose={onClose}
      headerExtra={!editing && <button className="btn btn-primary !py-1.5 text-[13px]" onClick={() => setEditing('new')}>＋ New note</button>}>
      {editing ? (
        <NoteForm note={editing === 'new' ? null : editing} categories={meta.categories} defaultCategory={typeof tab === 'number' ? tab : null} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      ) : (
        <div>
          <div className="sticky -top-4 z-10 -mx-4 -mt-4 mb-3 space-y-2 border-b border-slate-100 bg-white px-4 pb-3 pt-4">
            <div className="no-scrollbar flex items-stretch gap-2 overflow-x-auto">
              <button onClick={() => setTab('all')} aria-pressed={tab === 'all'} className={chip(tab === 'all')}>
                <span className="block text-xs font-semibold text-slate-800">All</span>
                <span className="text-[11px] font-medium text-slate-500">{meta.total} {meta.total === 1 ? 'note' : 'notes'}</span>
              </button>
              {meta.categories.map((c) => (
                <button key={c.id} onClick={() => setTab(c.id)} aria-pressed={tab === c.id} className={chip(tab === c.id)}>
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-slate-800"><span className="h-2 w-2 rounded-full" style={{ background: c.colour || '#64748b' }} />{c.name}</span>
                  <span className="text-[11px] font-medium text-slate-500">{c.notes} {c.notes === 1 ? 'note' : 'notes'}</span>
                </button>
              ))}
              {addingCat ? (
                <span className="flex shrink-0 items-center gap-1 rounded-xl border border-dashed border-slate-300 px-2">
                  <input autoFocus className="input !h-8 !w-36 text-xs" maxLength={60} placeholder="Category name" value={catName} onChange={(e) => setCatName(e.target.value)} aria-label="New category name"
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addCategory(); } if (e.key === 'Escape') setAddingCat(false); }} />
                  <button className="btn btn-primary !px-2 !py-1 text-xs" disabled={!catName.trim()} onClick={addCategory}>Add</button>
                  <button className="px-1 text-slate-400 hover:text-slate-700" onClick={() => { setAddingCat(false); setCatName(''); }} aria-label="Cancel">✕</button>
                </span>
              ) : (
                <button onClick={() => setAddingCat(true)} className="shrink-0 whitespace-nowrap rounded-xl border border-dashed border-slate-300 px-3 text-xs font-medium text-slate-500 hover:border-brand-500 hover:text-brand-600">＋ Category</button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input type="search" className="input" placeholder={selected ? `Search in ${selected.name}…` : 'Search notes…'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
              {selected && <button className="btn btn-ghost shrink-0 !py-1.5 text-xs" onClick={() => setEditCat(!editCat)}>Edit category</button>}
            </div>
          </div>

          {selected && editCat && <CategoryEditor cat={selected} onClose={() => setEditCat(false)} onChanged={(deleted) => { if (deleted) setTab('all'); else void load(); }} />}

          {err ? <ErrorState message={err} onRetry={load} /> : !notes ? <Spinner /> : meta.categories.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium text-slate-700">No categories yet.</p>
              <p className="mt-1 text-xs text-slate-500">Create a category such as “Website Template” or “WhatsApp”, then add notes inside it.</p>
              <button className="btn btn-primary mt-3" onClick={() => setAddingCat(true)}>＋ Create a category</button>
            </div>
          ) : notes.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium text-slate-700">{qd ? 'No notes match your search.' : selected ? `No notes in ${selected.name} yet.` : 'No notes yet.'}</p>
              {!qd && <button className="btn btn-primary mt-3" onClick={() => setEditing('new')}>＋ Create a note</button>}
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((c) => {
                const items = notes.filter((n) => n.category_id === c.id);
                if (!items.length) return null;
                return (
                  <section key={c.id}>
                    {tab === 'all' && <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"><span className="h-2 w-2 rounded-full" style={{ background: c.colour || '#64748b' }} />{c.name} ({items.length}) · recently copied first</h4>}
                    <ul className="space-y-2.5">
                      {items.map((n) => <NoteCard key={n.id} n={n} showCategory={false} canDelete={me!.role === 'admin' || n.created_by === me!.id} onCopy={onCopy} onEdit={() => setEditing(n)} onDelete={() => remove(n)} />)}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
