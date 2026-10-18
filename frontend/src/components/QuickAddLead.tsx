import { useState } from 'react';
import { post } from '../lib/api';
import { useAuth, useData } from '../store';
import { useRealtime } from '../realtime';
import { Modal, errMsg } from './ui';
import { toInputValue } from '../lib/time';

const EMPTY = {
  phone: '', nickname: '', email: '', business_name: '', requirement: '', budget: '',
  enquiry_type_id: '', source_id: '', status_id: '', special_markup_id: '', assigned_to: '', next_followup_at: '', message: '', created_at: '',
};

/** Add-lead form with every lead field. Blank selects fall back to the server defaults (New status, Normal priority, "Added in CRM"). */
export function QuickAddLead({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const { me } = useAuth();
  const { byCategory, users } = useData();
  const { toast } = useRealtime();
  // Creation time defaults to "now" (business timezone) and can be changed; it is only sent when edited, so an untouched form uses the exact server time
  const [f, setF] = useState(() => ({ ...EMPTY, created_at: toInputValue(new Date().toISOString(), me!.timezone) }));
  const [createdTouched, setCreatedTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const statuses = byCategory('lead_status');
  const chosenStatus = statuses.find((s) => String(s.id) === f.status_id);
  // The default status is the "New" state, which is Active; a follow-up needs an Active status.
  const followupAllowed = !chosenStatus || chosenStatus.status_category === 'active';
  const assignable = users;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.phone.trim() && !f.email.trim()) { setErr('Enter a phone number or an email address.'); return; }
    setBusy(true); setErr('');
    const body: Record<string, unknown> = {};
    for (const k of ['nickname', 'phone', 'email', 'business_name', 'requirement', 'budget', 'message'] as const) if (f[k].trim()) body[k] = f[k].trim();
    for (const k of ['enquiry_type_id', 'source_id', 'status_id', 'special_markup_id', 'assigned_to'] as const) if (f[k]) body[k] = Number(f[k]);
    if (createdTouched && f.created_at) body.created_at = f.created_at;
    if (f.next_followup_at && followupAllowed) body.next_followup_at = f.next_followup_at; // naive wall-clock; the API reads it in the business timezone
    try { await post('/leads', body); toast('info', 'Lead added'); onCreated(); onClose(); }
    catch (ex) { setErr(errMsg(ex)); setBusy(false); }
  };

  const select = (k: keyof typeof EMPTY, label: string, opts: { id: number; label: string }[], none: string) => (
    <div><label className="label" htmlFor={`qa-${k}`}>{label}</label>
      <select id={`qa-${k}`} className="input" value={f[k]} onChange={set(k)}>
        <option value="">{none}</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select></div>
  );

  return (
    <Modal title="Add lead" onClose={onClose} wide
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button form="add-lead-form" className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add lead'}</button></>}>
      <form id="add-lead-form" onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><label className="label" htmlFor="qa-created">Lead created on <span className="text-slate-400">({me!.timezone}) — defaults to now, change it for older enquiries</span></label>
          <input id="qa-created" type="datetime-local" className="input" max={toInputValue(new Date().toISOString(), me!.timezone)} value={f.created_at} onChange={(e) => { setCreatedTouched(true); set('created_at')(e); }} /></div>
        <div><label className="label" htmlFor="qa-phone">Phone <span className="text-slate-400">(phone or email required)</span></label><input id="qa-phone" autoFocus className="input" inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="98765 43210 or +91…" /></div>
        <div><label className="label" htmlFor="qa-email">Email</label><input id="qa-email" type="email" className="input" value={f.email} onChange={set('email')} /></div>
        <div><label className="label" htmlFor="qa-nickname">Name / nickname</label><input id="qa-nickname" className="input" maxLength={120} value={f.nickname} onChange={set('nickname')} /></div>
        <div><label className="label" htmlFor="qa-business">Business name</label><input id="qa-business" className="input" maxLength={190} value={f.business_name} onChange={set('business_name')} /></div>
        {select('enquiry_type_id', 'Enquiry form type', byCategory('enquiry_type'), '— none —')}
        <div><label className="label" htmlFor="qa-requirement">Requirement</label><input id="qa-requirement" className="input" maxLength={255} value={f.requirement} onChange={set('requirement')} placeholder="e.g. E-commerce" /></div>
        <div><label className="label" htmlFor="qa-budget">Budget</label><input id="qa-budget" className="input" maxLength={100} value={f.budget} onChange={set('budget')} placeholder="e.g. Less than ₹15,000" /></div>
        {select('source_id', 'Lead source', byCategory('lead_source'), 'Added in CRM (auto)')}
        {select('status_id', 'Status', statuses, 'New (default)')}
        {select('special_markup_id', 'Priority / special markup', byCategory('special_markup'), 'Normal (default)')}
        <div><label className="label" htmlFor="qa-assigned">Assigned agent</label>
          <select id="qa-assigned" className="input" value={f.assigned_to} onChange={set('assigned_to')}>
            <option value="">Unassigned</option>{assignable.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></div>
        <div><label className="label" htmlFor="qa-followup">Next follow-up <span className="text-slate-400">({me!.timezone})</span></label>
          <input id="qa-followup" type="datetime-local" className="input" disabled={!followupAllowed} value={followupAllowed ? f.next_followup_at : ''} onChange={set('next_followup_at')} />
          {!followupAllowed && <p className="mt-0.5 text-[11px] text-amber-700">Follow-ups apply only to active statuses.</p>}</div>
        <div className="sm:col-span-2"><label className="label" htmlFor="qa-message">Message / notes</label><textarea id="qa-message" className="input min-h-[80px]" maxLength={5000} value={f.message} onChange={set('message')} /></div>
        {err && <p className="text-sm text-red-600 sm:col-span-2" role="alert">{err}</p>}
      </form>
    </Modal>
  );
}
