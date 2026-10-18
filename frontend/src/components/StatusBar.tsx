import type { SelectableValue } from '../lib/types';

interface Props {
  statuses: SelectableValue[]; counts: { all: number; byStatus: Record<number, number> } | null;
  selected: number | null; onSelect(id: number | null): void;
}

/** Horizontal, scrollable pill bar. Statuses come from Settings; nothing is hardcoded. */
export function StatusBar({ statuses, counts, selected, onSelect }: Props) {
  const pill = (active: boolean) => `shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold transition ${active ? 'border-brand-600 bg-brand-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`;
  const count = (n?: number) => <span className="ml-1.5 tabular-nums opacity-70">{counts ? n ?? 0 : '·'}</span>;
  return (
    <div className="no-scrollbar -mx-3 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:px-0" role="tablist" aria-label="Filter by status">
      <button role="tab" aria-selected={selected === null} className={pill(selected === null)} onClick={() => onSelect(null)}>All{count(counts?.all)}</button>
      {statuses.map((s) => (
        <button key={s.id} role="tab" aria-selected={selected === s.id} className={pill(selected === s.id)} onClick={() => onSelect(s.id)}>
          {s.colour && selected !== s.id && <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: s.colour }} />}
          {s.label}{count(counts?.byStatus[s.id])}
        </button>
      ))}
    </div>
  );
}
