import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import type { Lead, Remark } from '../lib/types';
import { fmtDateTime } from '../lib/time';
import { useRealtime } from '../realtime';
import { ErrorState, Modal, Spinner, errMsg } from './ui';

export function RemarksModal({ lead, tz, onClose, onChanged }: { lead: Lead; tz: string; onClose(): void; onChanged(): void }) {
  const [items, setItems] = useState<Remark[] | null>(null);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useRealtime();

  const load = useCallback(() => {
    setErr('');
    get<Remark[]>(`/leads/${lead.id}/remarks`).then((r) => setItems(r.data)).catch((e) => setErr(errMsg(e)));
  }, [lead.id]);
  useEffect(load, [load]);

  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await post(`/leads/${lead.id}/remarks`, { text }); toast('info', 'Remark added'); onChanged(); onClose(); return; }
    catch (e) { toast('error', 'Could not add remark', errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={`Remarks — ${lead.nickname || lead.lead_code}`} onClose={onClose} wide>
      <div className="mb-3">
        <label className="label" htmlFor="new-remark">Add remark</label>
        <textarea id="new-remark" className="input min-h-[72px]" autoFocus maxLength={5000} value={text} placeholder="What happened on this lead?"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void add(); }} />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[11px] text-slate-400">Ctrl/⌘ + Enter to save</span>
          <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={add}>{busy ? 'Saving…' : 'Add remark'}</button>
        </div>
      </div>
      {err ? <ErrorState message={err} onRetry={load} /> : !items ? <Spinner /> : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">No remarks yet.</p>
      ) : (
        <ol className="space-y-2">
          {items.map((r) => (
            <li key={r.id} className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
              <p className="whitespace-pre-wrap break-words text-sm">{r.text}</p>
              <p className="mt-1 text-[11px] text-slate-500"><b>{r.author ?? 'Unknown'}</b> · {fmtDateTime(r.created_at, tz)}</p>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
