import { useCallback, useEffect, useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import type { SelectableValue, StatusCategory, UserLite } from '../lib/types';
import { useAuth, useData } from '../store';
import { useRealtime } from '../realtime';
import { Badge, ErrorState, Modal, Spinner, errMsg } from '../components/ui';

const CAT_LABEL: Record<string, string> = { lead_status: 'Lead Status', enquiry_type: 'Enquiry Form Type', special_markup: 'Special Markup', lead_source: 'Lead Source' };
const SECTION_LABEL: Record<StatusCategory, string> = { active: 'Leads (Active)', not_interested: 'Not Interested', converted: 'Converted' };
const catLabel = (c: string) => CAT_LABEL[c] ?? c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? 'bg-brand-600' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-[1.1rem]' : 'left-0.5'}`} />
    </button>
  );
}

function Preferences() {
  const { me } = useAuth();
  const { setSoundEnabled, setBrowserNotifications, soundState, enableSound, toast } = useRealtime();
  const p = me!.preferences;
  const run = (fn: () => Promise<void>) => fn().catch((e) => toast('error', 'Could not save', errMsg(e)));
  return (
    <section className="max-w-xl space-y-4 rounded-lg border bg-white p-4">
      <h2 className="font-semibold">My notification preferences</h2>
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-sm font-medium">New-lead sound</p><p className="text-xs text-slate-500">Plays a short chime when a new lead arrives while this tab is open.</p></div>
        <Toggle on={p.sound_enabled} label="New-lead sound" onChange={(v) => run(() => setSoundEnabled(v))} />
      </div>
      {p.sound_enabled && soundState !== 'ready' && (
        <div className="flex items-center justify-between rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          <span>{soundState === 'unsupported' ? 'This browser does not support audio.' : 'Your browser blocks sound until you interact with the page.'}</span>
          {soundState === 'blocked' && <button className="btn btn-ghost !py-1 text-xs" onClick={() => enableSound()}>Enable sound</button>}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-sm font-medium">Browser notifications</p><p className="text-xs text-slate-500">Desktop alerts when the CRM tab is in the background. Sound can't play once the browser is closed.</p></div>
        <Toggle on={p.browser_notifications} label="Browser notifications" onChange={(v) => run(() => setBrowserNotifications(v))} />
      </div>
    </section>
  );
}

function ValueForm({ category, value, onClose, onSaved }: { category: string; value: SelectableValue | null; onClose(): void; onSaved(): void }) {
  const [f, setF] = useState({
    label: value?.label ?? '', value_key: value?.value_key ?? '', description: value?.description ?? '', colour: value?.colour ?? '#2563eb',
    status_category: (value?.status_category ?? 'active') as StatusCategory, is_new_state: value?.is_new_state ?? false,
  });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState('');
  const submit = async (e: React.FormEvent, confirmSection = false) => {
    e.preventDefault(); setBusy(true); setErr(''); setConfirm('');
    const body: Record<string, unknown> = { label: f.label, description: f.description || null, colour: f.colour };
    if (category === 'lead_status') { body.status_category = f.status_category; body.is_new_state = f.status_category === 'active' && f.is_new_state; }
    try {
      if (value) await patch(`/settings/values/${value.id}`, { ...body, ...(confirmSection ? { confirm_section_change: true } : {}) });
      else await post('/settings/values', { ...body, category, ...(f.value_key ? { value_key: f.value_key } : {}) });
      onSaved(); onClose();
    } catch (ex: any) {
      if (ex?.status === 409 && ex?.details?.leads) setConfirm(errMsg(ex)); else setErr(errMsg(ex));
      setBusy(false);
    }
  };
  return (
    <Modal title={`${value ? 'Edit' : 'Add'} ${catLabel(category)} value`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div><label className="label">Display name</label><input className="input" required maxLength={100} value={f.label} autoFocus onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
        {!value && <div><label className="label">Internal key <span className="text-slate-400">(optional, auto-generated)</span></label><input className="input" pattern="[a-z][a-z0-9_]{1,63}" value={f.value_key} onChange={(e) => setF({ ...f, value_key: e.target.value })} placeholder="e.g. proposal_sent" /></div>}
        <div><label className="label">Description</label><input className="input" maxLength={255} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div><label className="label">Colour</label><input type="color" className="h-9 w-16 rounded border" value={f.colour} onChange={(e) => setF({ ...f, colour: e.target.value })} /></div>
        {category === 'lead_status' && (
          <>
            <div><label className="label">Sidebar section this status belongs to</label>
              <select className="input" value={f.status_category} onChange={(e) => setF({ ...f, status_category: e.target.value as StatusCategory })}>
                {(Object.keys(SECTION_LABEL) as StatusCategory[]).map((k) => <option key={k} value={k}>{SECTION_LABEL[k]}</option>)}
              </select></div>
            {f.status_category === 'active' && (
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={f.is_new_state} onChange={(e) => setF({ ...f, is_new_state: e.target.checked })} />
                <span>Treat as the <b>"new lead"</b> state — leads in this status get top priority and new leads start here. Only one status can be the new state.</span></label>
            )}
          </>
        )}
        {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
        {confirm && <div className="rounded bg-amber-50 p-2 text-sm text-amber-900">{confirm}<div className="mt-2"><button type="button" className="btn btn-primary" onClick={(e) => submit(e as any, true)}>Move leads and save</button></div></div>}
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Modal>
  );
}

function MigrateModal({ value, options, onClose, onDone }: { value: SelectableValue; options: SelectableValue[]; onClose(): void; onDone(): void }) {
  const [to, setTo] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const { toast } = useRealtime();
  const go = async () => {
    setBusy(true);
    try { const r = await post(`/settings/values/${value.id}/migrate`, { to_id: Number(to) }); toast('info', `${r.data.moved} lead(s) moved`); onDone(); onClose(); }
    catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal title={`Migrate leads from "${value.label}"`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!to || busy} onClick={go}>Migrate {value.usage_count} lead(s)</button></>}>
      <p className="mb-2 text-sm text-slate-600">Every lead using this value is reassigned (each gets an activity entry). Afterwards the value can be deleted.</p>
      <select className="input" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose target…</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </Modal>
  );
}

function Values() {
  const { reload } = useData();
  const { toast } = useRealtime();
  const [cats, setCats] = useState<string[]>([]);
  const [cat, setCat] = useState('lead_status');
  const [rows, setRows] = useState<SelectableValue[] | null>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<SelectableValue | 'new' | null>(null);
  const [migrating, setMigrating] = useState<SelectableValue | null>(null);
  const [newCat, setNewCat] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const [c, v] = await Promise.all([get<string[]>('/settings/categories'), get<SelectableValue[]>(`/settings/values?category=${cat}&include_inactive=1`)]);
      setCats(c.data); setRows(v.data);
    } catch (e) { setErr(errMsg(e)); }
  }, [cat]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const saved = () => { void load(); void reload(); };
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast('info', ok); saved(); } catch (e) { toast('error', 'Action failed', errMsg(e)); } };

  const move = (i: number, d: -1 | 1) => {
    if (!rows || !rows[i + d]) return;
    const a = rows[i]; const b = rows[i + d];
    // swap positions; if two rows share an order value, nudge instead so they separate
    let [na, nb] = [b.sort_order, a.sort_order];
    if (na === nb) na = a.sort_order + d;
    void run(async () => { await patch(`/settings/values/${a.id}`, { sort_order: Math.max(0, na) }); await patch(`/settings/values/${b.id}`, { sort_order: nb }); });
  };
  const remove = async (v: SelectableValue) => {
    if (!window.confirm(`Delete "${v.label}" permanently?`)) return;
    await run(() => del(`/settings/values/${v.id}`), 'Deleted');
  };

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="scroll-thin flex gap-1.5 overflow-x-auto">
          {cats.map((c) => <button key={c} onClick={() => setCat(c)} className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${cat === c ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-600'}`}>{catLabel(c)}</button>)}
        </div>
        <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); const k = newCat.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'); if (k.length > 1) { setCat(k); setCats((c) => (c.includes(k) ? c : [...c, k])); setNewCat(''); } }}>
          <input className="input !w-36 !py-1 text-xs" placeholder="New category…" value={newCat} onChange={(e) => setNewCat(e.target.value)} /><button className="btn btn-ghost !py-1 text-xs">Create</button>
        </form>
        <button className="btn btn-primary ml-auto" onClick={() => setEditing('new')}>+ Add value</button>
      </div>
      {cat === 'lead_status' && <p className="mb-3 rounded bg-slate-100 p-2 text-xs text-slate-600">Each status's <b>section</b> decides which sidebar tab holds its leads. Status names are never hardcoded — rename, add, reorder or move them freely.</p>}
      {err ? <ErrorState message={err} onRetry={load} /> : !rows ? <Spinner /> : (
        <div className="scroll-thin overflow-x-auto rounded-lg border bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr>
              <th className="px-3 py-2 text-left">Order</th><th className="px-3 py-2 text-left">Name</th>{cat === 'lead_status' && <th className="px-3 py-2 text-left">Section</th>}
              <th className="px-3 py-2 text-left">Used by</th><th className="px-3 py-2 text-left">Active</th><th className="px-3 py-2" /></tr></thead>
            <tbody className="divide-y">
              {rows.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-slate-500">No values yet in this category.</td></tr>}
              {rows.map((v, i) => (
                <tr key={v.id} className={v.is_active ? '' : 'bg-slate-50 text-slate-400'}>
                  <td className="px-3 py-2"><button className="px-1 text-slate-500 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">▲</button><button className="px-1 text-slate-500 disabled:opacity-30" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down">▼</button></td>
                  <td className="px-3 py-2"><Badge colour={v.colour}>{v.label}</Badge>{v.is_new_state && <span className="ml-1.5 rounded bg-blue-100 px-1.5 text-[10px] font-semibold text-blue-700">NEW STATE</span>}<div className="font-mono text-[10px] text-slate-400">{v.value_key}</div></td>
                  {cat === 'lead_status' && <td className="px-3 py-2 text-xs">{v.status_category && SECTION_LABEL[v.status_category]}</td>}
                  <td className="px-3 py-2 text-xs tabular-nums">{v.usage_count ?? 0} lead(s)</td>
                  <td className="px-3 py-2"><Toggle on={v.is_active} label={`Active: ${v.label}`} onChange={(on) => run(() => patch(`/settings/values/${v.id}`, { is_active: on }), on ? 'Activated' : 'Deactivated')} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs">
                    <button className="px-1.5 text-brand-700 hover:underline" onClick={() => setEditing(v)}>Edit</button>
                    {(v.usage_count ?? 0) > 0 ? <button className="px-1.5 text-slate-600 hover:underline" onClick={() => setMigrating(v)}>Migrate…</button>
                      : <button className="px-1.5 text-red-600 hover:underline" onClick={() => remove(v)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">Values used by existing leads can't be deleted — deactivate them (history is preserved and they can't be newly assigned) or migrate their leads to another value.</p>
      {editing && <ValueForm category={cat} value={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={saved} />}
      {migrating && <MigrateModal value={migrating} options={(rows ?? []).filter((r) => r.is_active && r.id !== migrating.id)} onClose={() => setMigrating(null)} onDone={saved} />}
    </section>
  );
}

function Users() {
  const { me } = useAuth();
  const { toast } = useRealtime();
  const { reload } = useData();
  const [rows, setRows] = useState<UserLite[] | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'agent' });
  const load = useCallback(() => { get<UserLite[]>('/users').then((r) => setRows(r.data)).catch((e) => setErr(errMsg(e))); }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast('info', ok); load(); void reload(); } catch (e) { toast('error', 'Action failed', errMsg(e)); } };
  if (err) return <ErrorState message={err} onRetry={load} />;
  if (!rows) return <Spinner />;
  return (
    <section>
      <div className="mb-3 flex justify-end"><button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add user</button></div>
      <div className="scroll-thin overflow-x-auto rounded-lg border bg-white">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2 text-left">Name</th><th className="px-3 py-2 text-left">Email</th><th className="px-3 py-2 text-left">Role</th><th className="px-3 py-2 text-left">Active</th><th className="px-3 py-2" /></tr></thead>
          <tbody className="divide-y">{rows.map((u) => (
            <tr key={u.id} className={u.is_active ? '' : 'text-slate-400'}>
              <td className="px-3 py-2 font-medium">{u.name}{u.id === me!.id && <span className="ml-1 text-xs text-slate-400">(you)</span>}</td><td className="px-3 py-2">{u.email}</td>
              <td className="px-3 py-2"><select className="input !w-auto !py-1 text-xs" value={u.role} onChange={(e) => act(() => patch(`/users/${u.id}`, { role: e.target.value }), 'Role updated')}><option value="agent">Agent</option><option value="admin">Admin</option></select></td>
              <td className="px-3 py-2"><Toggle on={!!u.is_active} label={`Active: ${u.name}`} onChange={(on) => act(() => patch(`/users/${u.id}`, { is_active: on }), on ? 'User enabled' : 'User disabled')} /></td>
              <td className="px-3 py-2 text-right text-xs"><button className="text-brand-700 hover:underline" onClick={() => { const p = window.prompt(`New password for ${u.name} (min 10 characters):`); if (p) void act(() => patch(`/users/${u.id}`, { password: p }), 'Password reset'); }}>Reset password</button></td>
            </tr>))}</tbody>
        </table>
      </div>
      {adding && (
        <Modal title="Add user" onClose={() => setAdding(false)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void act(async () => { await post('/users', f); setAdding(false); setF({ name: '', email: '', password: '', role: 'agent' }); }, 'User created'); }}>
            <div><label className="label">Name</label><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            <div><label className="label">Email</label><input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
            <div><label className="label">Temporary password (min 10 chars)</label><input className="input" type="password" minLength={10} required autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
            <div><label className="label">Role</label><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="agent">Agent</option><option value="admin">Admin</option></select></div>
            <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary">Create</button></div>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function SettingsPage() {
  const { me } = useAuth();
  const isAdmin = me!.role === 'admin';
  const [tab, setTab] = useState<'prefs' | 'values' | 'users'>('prefs');
  const tabs: [typeof tab, string, boolean][] = [['prefs', 'My preferences', true], ['values', 'Configurable values', isAdmin], ['users', 'Users', isAdmin]];
  return (
    <div className="h-full overflow-y-auto"><div className="mx-auto max-w-5xl p-3 sm:p-5">
      <div className="mb-4 flex gap-1 border-b">
        {tabs.filter((t) => t[2]).map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`-mb-px px-3 py-2 text-sm font-medium ${tab === k ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-500'}`}>{l}</button>)}
      </div>
      {tab === 'prefs' && <Preferences />}
      {tab === 'values' && isAdmin && <Values />}
      {tab === 'users' && isAdmin && <Users />}
    </div></div>
  );
}
