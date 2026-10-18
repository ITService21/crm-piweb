import { useState } from 'react';
import { post } from '../lib/api';
import type { Lead } from '../lib/types';
import { useRealtime } from '../realtime';
import { Modal, errMsg } from './ui';

/** Removing needs a remark. The lead is not deleted: it moves to the Removed tab and can be restored. */
export function RemoveLeadModal({ lead, onClose, onRemoved }: { lead: Lead; onClose(): void; onRemoved(): void }) {
  const { toast } = useRealtime();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) { setErr('A remark is required to remove a lead.'); return; }
    setBusy(true); setErr('');
    try { await post(`/leads/${lead.id}/remove`, { reason }); toast('info', `${lead.lead_code} moved to Removed`, lead.nickname ?? undefined); onRemoved(); onClose(); }
    catch (ex) { setErr(errMsg(ex)); setBusy(false); }
  };
  return (
    <Modal title={`Remove ${lead.lead_code}?`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-600">This lead will leave every list and appear only in the <b>Removed</b> tab. Nothing is deleted — you can restore it later.</p>
        <div>
          <label className="label" htmlFor="rm-reason">Remark (required)</label>
          <textarea id="rm-reason" autoFocus className="input min-h-[96px]" maxLength={5000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this lead being removed? e.g. Duplicate, spam, wrong number" />
        </div>
        {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={busy || !reason.trim()}>{busy ? 'Removing…' : 'Remove lead'}</button>
        </div>
      </form>
    </Modal>
  );
}
