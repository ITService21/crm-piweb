import { useCallback, useEffect, useState } from 'react';
import { get, patch, post } from '../lib/api';
import type { Activity, Lead, Remark } from '../lib/types';
import { fmtDateTime, toInputValue } from '../lib/time';
import { useAuth, useData } from '../store';
import { useRealtime } from '../realtime';
import { ErrorState, Spinner, errMsg } from './ui';
import { PhoneCell } from './PhoneCell';
import { RemoveLeadModal } from './RemoveLeadModal';

const ACTION_ICON: Record<string, string> = {
  lead_created: '＋', status_changed: '⇄', followup_scheduled: '⏰', followup_rescheduled: '⏰', followup_cleared: '✓',
  remark_added: '💬', assignment_changed: '👤', markup_changed: '★', field_updated: '✎',
};

export function LeadDrawer({ leadId, onClose, onChanged }: { leadId: number; onClose(): void; onChanged(): void }) {
  const { me } = useAuth();
  const { byCategory, users } = useData();
  const { toast, version, markLeadRead } = useRealtime();
  const tz = me!.timezone;
  const [lead, setLead] = useState<Lead | null>(null);
  const [acts, setActs] = useState<Activity[] | null>(null);
  const [remarks, setRemarks] = useState<Remark[] | null>(null);
  const [newRemark, setNewRemark] = useState('');
  const [remarkBusy, setRemarkBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'details' | 'activity'>('details');
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      const l = (await get<Lead>(`/leads/${leadId}`)).data;
      setLead(l);
      setForm({
        nickname: l.nickname ?? '', business_name: l.business_name ?? '', requirement: l.requirement ?? '', budget: l.budget ?? '', phone: l.phone ?? '', email: l.email ?? '', message: l.message ?? '',
        status_id: String(l.status.id), enquiry_type_id: String(l.enquiry_type?.id ?? ''), source_id: String(l.source?.id ?? ''),
        special_markup_id: String(l.special_markup?.id ?? ''), assigned_to: String(l.assigned_to?.id ?? ''),
        next_followup_at: toInputValue(l.next_followup_at, tz),
      });
      setActs((await get<Activity[]>(`/leads/${leadId}/activities`)).data);
      setRemarks((await get<Remark[]>(`/leads/${leadId}/remarks`)).data);
    } catch (e) { setErr(errMsg(e)); }
  }, [leadId, tz]);
  useEffect(() => { void load(); markLeadRead(leadId); }, [load, leadId, markLeadRead]);
  useEffect(() => {
    if (!version) return;
    get<Activity[]>(`/leads/${leadId}/activities`).then((r) => setActs(r.data)).catch(() => {});
    get<Remark[]>(`/leads/${leadId}/remarks`).then((r) => setRemarks(r.data)).catch(() => {});
  }, [version, leadId]);

  const addRemark = async () => {
    if (!newRemark.trim() || remarkBusy) return;
    setRemarkBusy(true);
    try { await post(`/leads/${leadId}/remarks`, { text: newRemark }); setNewRemark(''); toast('info', 'Remark added'); onChanged(); await load(); }
    catch (e) { toast('error', 'Could not add remark', errMsg(e)); }
    finally { setRemarkBusy(false); }
  };

  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const num = (v: string) => (v ? Number(v) : null);

  const save = async () => {
    if (!lead) return;
    const body: Record<string, unknown> = {};
    const txt = (k: 'nickname' | 'phone' | 'email' | 'message' | 'business_name' | 'requirement' | 'budget') => { if ((form[k] || null) !== (lead[k] || null)) body[k] = form[k] || null; };
    (['nickname', 'phone', 'email', 'message', 'business_name', 'requirement', 'budget'] as const).forEach(txt);
    if (Number(form.status_id) !== lead.status.id) body.status_id = Number(form.status_id);
    const ids: [string, number | undefined][] = [['enquiry_type_id', lead.enquiry_type?.id], ['source_id', lead.source?.id], ['special_markup_id', lead.special_markup?.id], ['assigned_to', lead.assigned_to?.id]];
    for (const [k, cur] of ids) if (num(form[k]) !== (cur ?? null)) body[k] = num(form[k]);
    if (form.next_followup_at !== toInputValue(lead.next_followup_at, tz)) body.next_followup_at = form.next_followup_at || null;
    if (!Object.keys(body).length) { toast('info', 'No changes to save'); return; }
    setBusy(true);
    try { await patch(`/leads/${lead.id}`, body); toast('info', 'Lead updated'); onChanged(); await load(); }
    catch (e) { toast('error', 'Could not update lead', errMsg(e)); }
    finally { setBusy(false); }
  };

  const restore = async () => {
    if (!lead) return;
    setBusy(true);
    try { await post(`/leads/${lead.id}/restore`); toast('info', `${lead.lead_code} restored`); onChanged(); await load(); }
    catch (e) { toast('error', 'Could not restore lead', errMsg(e)); }
    finally { setBusy(false); }
  };
  const sel = (k: string, label: string, cat: string, none?: string) => {
    const opts = byCategory(cat);
    return (
      <div key={k}><label className="label">{label}</label>
        <select className="input" value={form[k] ?? ''} onChange={set(k)}>
          {none !== undefined && <option value="">{none}</option>}
          {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          {form[k] && !opts.some((o) => String(o.id) === form[k]) && <option value={form[k]}>(inactive value)</option>}
        </select></div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="flex h-full w-full max-w-lg flex-col bg-white shadow-xl" role="dialog" aria-label="Lead details">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="font-mono text-sm font-semibold">{lead?.lead_code ?? '…'}</h2>
            {lead && <p className="text-xs text-slate-500">Created {fmtDateTime(lead.created_at, tz)} · {lead.created_by?.name ?? lead.source?.label ?? 'System'}</p>}
          </div>
          <button className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="flex border-b text-sm">
          {(['details', 'activity'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 font-medium capitalize ${tab === t ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-500'}`}>
              {t}{t === 'activity' && acts ? ` (${acts.length})` : ''}
            </button>
          ))}
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto p-4">
          {err ? <ErrorState message={err} onRetry={load} /> : !lead ? <Spinner /> : tab === 'details' ? (
            <>
            <fieldset disabled={!!lead.removed} className="grid grid-cols-1 gap-3 border-0 p-0 sm:grid-cols-2">
              {lead.allocated && (
                <div className="sm:col-span-2 flex items-center justify-between gap-2 rounded-lg border border-violet-200 bg-violet-50 p-2.5 text-xs text-violet-900">
                  <span><b>Allocated to {lead.allocated.to.id === me!.id ? 'you' : lead.allocated.to.name}</b>{lead.allocated.by && ` by ${lead.allocated.by.name}`} · {fmtDateTime(lead.allocated.at, tz)}<span className="block text-violet-700/80">Temporary priority hand-off — the assigned agent is unchanged.</span></span>
                  {(me!.role === 'admin' || lead.allocated.to.id === me!.id || lead.allocated.by?.id === me!.id) && (
                    <button type="button" className="btn btn-ghost !py-1 text-xs" onClick={async () => { try { await post('/leads/allocate', { lead_ids: [lead.id], user_id: null }); toast('info', 'Allocation cleared'); onChanged(); await load(); } catch (e) { toast('error', 'Could not clear allocation', errMsg(e)); } }}>{lead.allocated.to.id === me!.id ? 'Done' : 'Release'}</button>
                  )}
                </div>
              )}
              {lead.removed && (
                <div className="sm:col-span-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800">
                  <p className="font-semibold">Removed by {lead.removed.by ?? 'Unknown'} · {fmtDateTime(lead.removed.at, tz)}</p>
                  <p className="mt-0.5 whitespace-pre-wrap break-words">{lead.removed.reason}</p>
                </div>
              )}
              <div className="sm:col-span-2 flex items-center justify-between rounded-md bg-slate-50 p-2 text-sm"><PhoneCell phone={lead.phone} /></div>
              <div><label className="label">Name / nickname</label><input className="input" value={form.nickname} onChange={set('nickname')} maxLength={120} /></div>
              <div><label className="label">Business name</label><input className="input" value={form.business_name} onChange={set('business_name')} maxLength={190} /></div>
              <div><label className="label">Budget</label><input className="input" value={form.budget} onChange={set('budget')} maxLength={100} /></div>
              <div className="sm:col-span-2"><label className="label">Requirement (as submitted)</label><input className="input" value={form.requirement} onChange={set('requirement')} maxLength={255} /></div>
              <div className="sm:col-span-2"><label className="label">Enquiry message</label><textarea className="input min-h-[80px]" value={form.message} onChange={set('message')} maxLength={5000} /></div>
              <div><label className="label">Next follow-up ({tz})</label><input className="input" type="datetime-local" value={form.next_followup_at} onChange={set('next_followup_at')} /></div>



              <div><label className="label">Phone</label><input className="input" value={form.phone} onChange={set('phone')} inputMode="tel" /></div>
              <div className="sm:col-span-2"><label className="label">Email</label><input className="input" type="email" value={form.email} onChange={set('email')} /></div>
              {sel('status_id', 'Status', 'lead_status')}
              {sel('enquiry_type_id', 'Enquiry form type', 'enquiry_type', '— none —')}
              {sel('special_markup_id', 'Special markup', 'special_markup', '— none —')}
              {sel('source_id', 'Lead source', 'lead_source', '— none —')}
              <div><label className="label">Assigned agent</label>
                <select className="input" value={form.assigned_to} onChange={set('assigned_to')}>
                  <option value="">Unassigned</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select></div>
              <p className="sm:col-span-2 text-[11px] text-slate-500">Last action by {lead.last_action_by?.name ?? 'System'} · {fmtDateTime(lead.last_action_at, tz)}</p>
            </fieldset>

            {/* All remarks, newest first, at the end of the details */}
            <section className="mt-5 border-t border-slate-200 pt-4" aria-label="Remarks">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">Remarks{remarks && <span className="rounded-full bg-slate-100 px-1.5 text-[11px] font-medium tabular-nums text-slate-600">{remarks.length}</span>}</h3>
              {!lead.removed && (
                <div className="mb-3">
                  <textarea className="input min-h-[64px]" maxLength={5000} value={newRemark} onChange={(e) => setNewRemark(e.target.value)} placeholder="Add a remark…"
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void addRemark(); }} aria-label="New remark" />
                  <div className="mt-1.5 flex justify-end"><button className="btn btn-primary !py-1.5 text-xs" disabled={remarkBusy || !newRemark.trim()} onClick={addRemark}>{remarkBusy ? 'Saving…' : 'Add remark'}</button></div>
                </div>
              )}
              {!remarks ? <Spinner label="Loading remarks…" /> : remarks.length === 0 ? <p className="py-3 text-center text-xs text-slate-400">No remarks yet.</p> : (
                <ol className="space-y-2">
                  {remarks.map((r) => (
                    <li key={r.id} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                      <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{r.text}</p>
                      <p className="mt-1 text-[11px] text-slate-500"><b>{r.author ?? 'Unknown'}</b> · {fmtDateTime(r.created_at, tz)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            </>
          ) : !acts ? <Spinner /> : (
            <ol className="relative space-y-3 border-l border-slate-200 pl-5">
              {acts.map((a) => (
                <li key={a.id} className="relative">
                  <span className="absolute -left-[1.85rem] flex h-6 w-6 items-center justify-center rounded-full border bg-white text-xs" aria-hidden>{ACTION_ICON[a.action_type] ?? '•'}</span>
                  <p className="text-sm text-slate-800">{a.summary}</p>
                  <p className="text-[11px] text-slate-500">{a.actor ?? 'System'} · {fmtDateTime(a.created_at, tz)}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
        {tab === 'details' && lead && (
          <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
            {lead.removed
              ? <button className="btn btn-ghost mr-auto text-emerald-700" onClick={restore} disabled={busy}>↺ Restore lead</button>
              : <button className="btn btn-ghost mr-auto text-red-600 hover:bg-red-50" onClick={() => setRemoving(true)}>🗑 Remove</button>}
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
            {!lead.removed && <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>}
          </div>
        )}
        {removing && lead && <RemoveLeadModal lead={lead} onClose={() => setRemoving(false)} onRemoved={() => { onChanged(); onClose(); }} />}
      </aside>
    </div>
  );
}
