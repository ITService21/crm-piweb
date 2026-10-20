import { STATUS_META } from '../../lib/billing';

/** Overdue / expired are derived states and take precedence over the stored status for display. */
export function StatusBadge({ status, overdue, expired, size = 'md' }: { status: string; overdue?: boolean; expired?: boolean; size?: 'sm' | 'md' }) {
  const key = overdue ? 'overdue' : expired ? 'expired' : status;
  const m = STATUS_META[key] ?? { label: key, cls: 'bg-slate-100 text-slate-700 border-slate-300' };
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full border font-semibold ${size === 'sm' ? 'px-2 py-px text-[10px]' : 'px-2.5 py-0.5 text-xs'} ${m.cls}`}>{m.label}</span>;
}
