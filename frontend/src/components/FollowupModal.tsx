import { useState } from 'react';
import { post } from '../lib/api';
import type { Lead } from '../lib/types';
import { fmtDateTime, presetFollowup, toInputValue } from '../lib/time';
import { useRealtime } from '../realtime';
import { Modal, errMsg } from './ui';

export function FollowupModal({ lead, tz, now, onClose, onChanged }: { lead: Lead; tz: string; now: Date; onClose(): void; onChanged(): void }) {
  const [value, setValue] = useState(toInputValue(lead.next_followup_at, tz));
  const [busy, setBusy] = useState(false);
  const { toast } = useRealtime();

  const save = async (v: string | null) => {
    setBusy(true);
    try {
      await post(`/leads/${lead.id}/followup`, { next_followup_at: v });
      toast('info', v ? 'Follow-up saved' : 'Follow-up cleared');
      onChanged(); onClose();
    } catch (e) { toast('error', 'Could not save follow-up', errMsg(e)); setBusy(false); }
  };
  const presets: [string, '1h' | 'tomorrow' | '3d' | '1w'][] = [['In 1 hour', '1h'], ['Tomorrow 10:00', 'tomorrow'], ['In 3 days', '3d'], ['In 1 week', '1w']];
  const inactive = lead.status.category !== 'active';

  return (
    <Modal title={`Follow-up — ${lead.nickname || lead.lead_code}`} onClose={onClose}
      footer={<>
        {lead.next_followup_at && <button className="btn btn-ghost mr-auto text-red-600" disabled={busy} onClick={() => save(null)}>Clear / mark done</button>}
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !value || inactive} onClick={() => save(value)}>Save</button>
      </>}>
      {inactive && <p className="mb-3 rounded bg-amber-50 p-2 text-xs text-amber-800">This lead is not in an active status. Change its status to schedule a follow-up.</p>}
      <p className="mb-2 text-xs text-slate-500">Current: {fmtDateTime(lead.next_followup_at, tz)} <span className="text-slate-400">({tz})</span></p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {presets.map(([label, k]) => <button key={k} className="btn btn-ghost !py-1 text-xs" disabled={busy || inactive} onClick={() => save(presetFollowup(k, now, tz))}>{label}</button>)}
      </div>
      <label className="label" htmlFor="fu">Custom date &amp; time</label>
      <input id="fu" type="datetime-local" className="input" value={value} onChange={(e) => setValue(e.target.value)} />
    </Modal>
  );
}
