import { useEffect, useRef, useState } from 'react';
import { STATUS_META } from '../../lib/billing';
import type { BillingDoc } from '../../lib/types';

export interface StatusOption { key: string; label: string; hint?: string; tone?: 'danger'; disabled?: boolean; onPick(): void }

/** Status badge that doubles as the "change status" control on the detail page. */
export function StatusMenu({ doc, options, busy }: { doc: BillingDoc; options: StatusOption[]; busy: boolean }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, []);
  const m = STATUS_META[doc.is_overdue ? 'overdue' : doc.status] ?? STATUS_META[doc.status];
  return (
    <div className="relative" ref={ref}>
      <button type="button" disabled={busy || options.length === 0} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={options.length ? 'Change status' : undefined}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${m?.cls ?? ''} ${options.length ? 'cursor-pointer hover:brightness-95' : 'cursor-default'}`}>
        {m?.label ?? doc.status}{options.length > 0 && <span aria-hidden className="text-[9px]">▾</span>}
      </button>
      {open && (
        <div role="menu" className="absolute left-0 z-30 mt-1 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Change status to</p>
          {options.map((o) => (
            <button key={o.key} role="menuitem" disabled={o.disabled} onClick={() => { setOpen(false); o.onPick(); }}
              className={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent ${o.tone === 'danger' ? 'text-red-600' : 'text-slate-800'}`}>
              <span className="font-medium">{o.label}</span>{o.hint && <span className="block text-[11px] font-normal text-slate-500">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
