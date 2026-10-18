import { useState } from 'react';
import { post } from '../lib/api';
import { useAuth, useData } from '../store';
import { useRealtime } from '../realtime';
import { Modal, errMsg } from './ui';

/**
 * Pick a user for the selected leads.
 *  - allocate: temporary priority hand-off; the lead's owner (assigned agent) does not change.
 *  - assign:   the lead's owner changes (or "Unassigned").
 */
export function AllocateModal({ ids, mode = 'allocate', onClose, onDone }: { ids: number[]; mode?: 'allocate' | 'assign'; onClose(): void; onDone(): void }) {
  const assign = mode === 'assign';
  const { me } = useAuth();
  const { users } = useData();
  const { toast } = useRealtime();
  const [to, setTo] = useState<number | null>(null);
  const [unassign, setUnassign] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const target = users.find((u) => u.id === to);

  const go = async () => {
    if (!to && !unassign) return;
    setBusy(true); setErr('');
    try {
      const r = await post<Record<string, any>>(assign ? '/leads/assign' : '/leads/allocate', { lead_ids: ids, user_id: unassign ? null : to });
      const n: number = assign ? r.data.assigned : r.data.allocated;
      const skipped = r.data.skipped.length;
      const verb = assign ? 'assigned' : 'allocated';
      toast(n ? 'info' : 'error', n ? `${n} lead${n === 1 ? '' : 's'} ${unassign ? 'unassigned' : `${verb} to ${target?.name}`}` : `Nothing was ${verb}`,
        skipped ? `${skipped} skipped (${[...new Set((r.data.skipped as { reason: string }[]).map((x) => x.reason))].join(', ')})` : undefined);
      onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };

  return (
    <Modal title={`${assign ? 'Assign' : 'Allocate'} ${ids.length} lead${ids.length === 1 ? '' : 's'}`} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={(!to && !unassign) || busy} onClick={go}>{busy ? 'Saving…' : unassign ? 'Unassign' : target ? `${assign ? 'Assign' : 'Allocate'} to ${target.name}` : assign ? 'Assign' : 'Allocate'}</button></>}>
      {assign
        ? <p className="mb-3 text-sm text-slate-600">The chosen person becomes the <b>assigned agent</b> (owner) of these leads. Other agents will no longer see them unless they are allocated to them.</p>
        : <p className="mb-3 text-sm text-slate-600">The chosen person sees these leads <b>at the very top</b> of their Leads list and can act on them. The lead's assigned agent does not change.</p>}
      <ul className="space-y-1.5" role="radiogroup" aria-label={assign ? 'Assign to' : 'Allocate to'}>
        {assign && (
          <li>
            <button role="radio" aria-checked={unassign} onClick={() => { setUnassign(true); setTo(null); }}
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition ${unassign ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-sm text-slate-500">—</span>
              <span className="text-sm font-medium text-slate-900">Unassigned <span className="text-xs font-normal text-slate-400">(back to the shared pool)</span></span>
              <span className={`ml-auto h-4 w-4 rounded-full border ${unassign ? 'border-brand-600 bg-brand-600 ring-2 ring-inset ring-white' : 'border-slate-300'}`} />
            </button>
          </li>
        )}
        {users.map((u) => (
          <li key={u.id}>
            <button role="radio" aria-checked={to === u.id} onClick={() => { setTo(u.id); setUnassign(false); }}
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition ${to === u.id ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700">{u.name.slice(0, 1).toUpperCase()}</span>
              <span className="text-sm font-medium text-slate-900">{u.name}{u.id === me!.id && <span className="ml-1 text-xs font-normal text-slate-400">(you)</span>}</span>
              <span className={`ml-auto h-4 w-4 rounded-full border ${to === u.id ? 'border-brand-600 bg-brand-600 ring-2 ring-inset ring-white' : 'border-slate-300'}`} />
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="mt-3 text-sm text-red-600" role="alert">{err}</p>}
    </Modal>
  );
}
