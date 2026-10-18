import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { copyText } from '../lib/clipboard';
import type { Note, NoteCategory, NoteStats } from '../lib/types';
import { useAuth } from '../store';
import { useRealtime } from '../realtime';
import { ErrorState, Modal, Spinner, errMsg } from './ui';

type Tab = 'all' | NoteCategory;
const CAT: Record<NoteCategory, { label: string; badge: string; dot: string }> = {
  whatsapp: { label: 'WhatsApp', badge: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
  email: { label: 'Email', badge: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
};
/** Mirrors the server order: recently copied first, never-copied after, then most copied, then latest edit. */
const byRecentCopy = (a: Note, b: Note) => {
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  if (!!a.last_copied_at !== !!b.last_copied_at) return a.last_copied_at ? -1 : 1;
  if (a.last_copied_at && b.last_copied_at && a.last_copied_at !== b.last_copied_at) return a.last_copied_at < b.last_copied_at ? 1 : -1;
  if (a.copy_count !== b.copy_count) return b.copy_count - a.copy_count;
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id;
};
const TAB_KEY = 'piweb_crm_notes_tab';
const readTab = (): Tab => { try { const v = localStorage.getItem(TAB_KEY); return v === 'whatsapp' || v === 'email' ? v : 'all'; } catch { return 'all'; } };
const EMPTY_STATS: NoteStats = { all: { notes: 0, copies: 0 }, whatsapp: { notes: 0, copies: 0 }, email: { notes: 0, copies: 0 } };

const CopyIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
const CheckIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5 9-10" /></svg>;

function NoteCard({ n, canDelete, onCopy, onEdit, onDelete }: { n: Note; canDelete: boolean; onCopy(n: Note, part: 'content' | 'subject'): Promise<boolean>; onEdit(): void; onDelete(): void }) {
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
            <span className={`rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide ${CAT[n.category].badge}`}>{CAT[n.category].label}</span>
            <h3 className="truncate text-sm font-semibold text-slate-900">{n.title}</h3>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">Copied {n.copy_count}× · {n.created_by_name ?? 'Unknown'}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button onClick={onEdit} className="rounded-lg px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100" aria-label={`Edit ${n.title}`}>Edit</button>
          {canDelete && <button onClick={onDelete} className="rounded-lg px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50" aria-label={`Delete ${n.title}`}>Delete</button>}
        </div>
      </div>
      {n.subject && (
        <p className="mt-2 rounded-lg bg-amber-50/70 px-2 py-1 text-xs text-slate-700"><span className="font-semibold text-amber-700">Subject: </span>{n.subject}</p>
      )}
      <button onClick={() => setOpen(!open)} className="mt-2 block w-full text-left" title={open ? 'Collapse' : 'Expand'}>
        <p className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-700 ${open ? '' : 'line-clamp-3'}`}>{n.content}</p>
      </button>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {n.category === 'email' && btn('subject', 'Copy subject', false)}
        {btn('content', n.category === 'email' ? 'Copy content' : 'Copy message', true)}
      </div>
    </li>
  );
}

function NoteForm({ note, defaultCategory, onCancel, onSaved }: { note: Note | null; defaultCategory: NoteCategory; onCancel(): void; onSaved(): void }) {
  const { toast } = useRealtime();
  const [f, setF] = useState({ category: note?.category ?? defaultCategory, title: note?.title ?? '', subject: note?.subject ?? '', content: note?.content ?? '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    const body = { category: f.category, title: f.title, content: f.content, ...(f.category === 'email' ? { subject: f.subject } : {}) };
    try { if (note) await patch(`/notes/${note.id}`, body); else await post('/notes', body); toast('info', note ? 'Note updated' : 'Note created'); onSaved(); }
    catch (ex) { setErr(errMsg(ex)); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="label">Category</label>
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
          {(Object.keys(CAT) as NoteCategory[]).map((c) => (
            <button type="button" key={c} onClick={() => setF({ ...f, category: c })} className={`px-3 py-1.5 text-sm font-medium ${f.category === c ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{CAT[c].label} note</button>
          ))}
        </div>
      </div>
      <div><label className="label" htmlFor="n-title">Header</label><input id="n-title" className="input" required maxLength={150} autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. First reply to a website enquiry" /></div>
      {f.category === 'email' && <div><label className="label" htmlFor="n-sub">Email subject</label><input id="n-sub" className="input" required maxLength={255} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="Subject line of the email" /></div>}
      <div><label className="label" htmlFor="n-body">Content <span className="text-slate-400">(only this is copied by “Copy {f.category === 'email' ? 'content' : 'message'}”)</span></label>
        <textarea id="n-body" className="input min-h-[190px] font-[inherit] leading-relaxed" required maxLength={10000} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} placeholder="Paste or type your script…" />
        <p className="mt-0.5 text-right text-[11px] text-slate-400">{f.content.length} / 10000</p></div>
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : note ? 'Save changes' : 'Create note'}</button></div>
    </form>
  );
}

/** All notes in one place: category stats, search, copy buttons, and create / edit / delete. */
export function NotesModal({ onClose }: { onClose(): void }) {
  const { me } = useAuth();
  const { toast } = useRealtime();
  // Reopening the window lands on the category you last used
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* storage unavailable */ } };
  const [q, setQ] = useState(''); const [qd, setQd] = useState('');
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [stats, setStats] = useState<NoteStats>(EMPTY_STATS);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<Note | 'new' | null>(null);

  useEffect(() => { const t = setTimeout(() => setQd(q), 250); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    setErr('');
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('category', tab);
      if (qd) params.set('q', qd);
      const r = await get<Note[]>(`/notes?${params}`);
      setNotes(r.data); setStats((r.meta as unknown as { stats: NoteStats }).stats);
    } catch (e) { setErr(errMsg(e)); }
  }, [tab, qd]);
  // Re-sorts by most copied whenever the tab/search changes or the list is reopened (not while you are copying).
  useEffect(() => { void load(); }, [load]);

  const onCopy = async (n: Note, part: 'content' | 'subject') => {
    const ok = await copyText(part === 'subject' ? (n.subject ?? '') : n.content);
    if (!ok) { toast('error', 'Could not copy', 'Select the text and copy it manually.'); return false; }
    try {
      const r = await post<Note>(`/notes/${n.id}/copy`, { part });
      setNotes((list) => list && list.map((x) => (x.id === n.id ? { ...x, copy_count: r.data.copy_count, last_copied_at: r.data.last_copied_at } : x)));
      // Let the "Copied" confirmation play, then float the note to the top of its category (same order the server uses)
      if (part === 'content') window.setTimeout(() => setNotes((list) => list && [...list].sort(byRecentCopy)), 2000);
      if (part === 'content') setStats((s) => ({ ...s, all: { ...s.all, copies: s.all.copies + 1 }, [n.category]: { ...s[n.category], copies: s[n.category].copies + 1 } }));
    } catch { /* copying succeeded; the counter is best-effort */ }
    return true;
  };
  const remove = async (n: Note) => {
    if (!window.confirm(`Delete the note "${n.title}"?`)) return;
    try { await del(`/notes/${n.id}`); toast('info', 'Note deleted'); void load(); } catch (e) { toast('error', 'Could not delete', errMsg(e)); }
  };

  const tabs: [Tab, string][] = [['all', 'All'], ['whatsapp', 'WhatsApp'], ['email', 'Email']];
  const showGroups = tab === 'all';
  const groups: NoteCategory[] = ['whatsapp', 'email'];

  return (
    <Modal tall title={editing ? (editing === 'new' ? 'New note' : 'Edit note') : 'Notes'} onClose={onClose}
      headerExtra={!editing && <button className="btn btn-primary !py-1.5 text-[13px]" onClick={() => setEditing('new')}>＋ New note</button>}>
      {editing ? (
        <NoteForm note={editing === 'new' ? null : editing} defaultCategory={tab === 'email' ? 'email' : 'whatsapp'} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      ) : (
        <div>
          <div className="sticky -top-4 z-10 -mx-4 -mt-4 mb-3 space-y-2 border-b border-slate-100 bg-white px-4 pb-3 pt-4">
            <div className="no-scrollbar flex gap-2 overflow-x-auto">
              {tabs.map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)} aria-pressed={tab === k}
                  className={`shrink-0 rounded-xl border px-3 py-1.5 text-left transition ${tab === k ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">{k !== 'all' && <span className={`h-2 w-2 rounded-full ${CAT[k].dot}`} />}{label}</span>
                  <span className="text-[11px] font-medium text-slate-500">{stats[k].notes} {stats[k].notes === 1 ? 'note' : 'notes'}</span>
                </button>
              ))}
            </div>
            <input type="search" className="input" placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
          </div>

          {err ? <ErrorState message={err} onRetry={load} /> : !notes ? <Spinner /> : notes.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium text-slate-700">{qd ? 'No notes match your search.' : 'No notes yet.'}</p>
              {!qd && <p className="mt-1 text-xs text-slate-500">Save the messages you send often, then copy them in one click.</p>}
              {!qd && <button className="btn btn-primary mt-3" onClick={() => setEditing('new')}>＋ Create your first note</button>}
            </div>
          ) : (
            <div className="space-y-4">
              {(showGroups ? groups : [tab as NoteCategory]).map((c) => {
                const items = notes.filter((n) => n.category === c);
                if (!items.length) return null;
                return (
                  <section key={c}>
                    {showGroups && <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500"><span className={`h-2 w-2 rounded-full ${CAT[c].dot}`} />{CAT[c].label} notes ({items.length}) · recently copied first</h4>}
                    <ul className="space-y-2.5">
                      {items.map((n) => <NoteCard key={n.id} n={n} canDelete={me!.role === 'admin' || n.created_by === me!.id} onCopy={onCopy} onEdit={() => setEditing(n)} onDelete={() => remove(n)} />)}
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
