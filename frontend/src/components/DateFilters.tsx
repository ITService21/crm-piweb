import type { TabKey } from '../lib/types';

const OPTIONS: Partial<Record<TabKey, { key: string; label: string }[]>> = {
  leads: [
    { key: 'all', label: 'All Leads' }, { key: 'today_leads', label: "Today's Leads" }, { key: 'yesterday_leads', label: "Yesterday's Leads" },
    { key: 'last7_leads', label: 'Last 7 Days' },  { key: 'today', label: "Today's Follow-ups" },
    { key: 'overdue', label: 'Overdue Follow-ups' }, { key: 'custom', label: 'Custom Range' },
  ],
  scheduled: [
    { key: 'tomorrow', label: 'Tomorrow' }, { key: 'next7', label: 'Next 7 Days' }, { key: 'next30', label: 'Next 30 Days' },
    { key: 'custom', label: 'Custom Range' }, { key: 'all', label: 'All Upcoming' },
  ],
};
export const hasDateFilters = (tab: TabKey) => !!OPTIONS[tab];
export const defaultDateFilter = () => 'all';

interface Props {
  tab: TabKey; value: string; from: string; to: string; field: string; counts: Record<string, number | null> | null;
  onChange(p: { df?: string; from?: string; to?: string; field?: string }): void;
}

export function DateFilters({ tab, value, from, to, field, counts, onChange }: Props) {
  const opts = OPTIONS[tab];
  if (!opts) return null;
  return (
    <div className="no-scrollbar -mx-3 flex items-center gap-2 overflow-x-auto px-3 sm:mx-0 sm:px-0">
      <div className="inline-flex shrink-0 flex-nowrap overflow-hidden rounded-lg border border-slate-200 bg-white text-xs shadow-sm">
        {opts.map((o) => (
          <button key={o.key} onClick={() => onChange({ df: o.key })}
            className={`shrink-0 whitespace-nowrap px-2.5 py-1.5 font-semibold transition ${value === o.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{o.label}
            {counts && counts[o.key] != null && <span className={`ml-1.5 rounded-full px-1.5 text-[10px] tabular-nums ${value === o.key ? 'bg-white/25' : 'bg-slate-100 text-slate-600'}`}>{counts[o.key]}</span>}
          </button>
        ))}
      </div>
      {(value === 'custom' || (tab === 'leads' && value === 'new')) && (
        <div className="flex shrink-0 items-center gap-1.5 text-xs">
          {tab === 'leads' && value === 'custom' && (
            <select className="input !w-auto !py-1 text-xs" value={field || 'created'} onChange={(e) => onChange({ field: e.target.value })} aria-label="Date field">
              <option value="created">Created date</option><option value="followup">Follow-up date</option>
            </select>
          )}
          <input type="date" className="input !w-auto !py-1 text-xs" value={from} onChange={(e) => onChange({ from: e.target.value })} aria-label="From date" />
          <span className="text-slate-400">to</span>
          <input type="date" className="input !w-auto !py-1 text-xs" value={to} min={from || undefined} onChange={(e) => onChange({ to: e.target.value })} aria-label="To date" />
          {tab === 'leads' && value === 'new' && !from && !to && <span className="text-slate-500">(today)</span>}
        </div>
      )}
    </div>
  );
}
