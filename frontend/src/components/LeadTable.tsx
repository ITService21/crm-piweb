import type { Lead, SelectableValue } from '../lib/types';
import { followupInfo, fmtDateTime, fmtShort, fmtTime } from '../lib/time';
import { ContactButtons, PhoneCell } from './PhoneCell';
import { TagChip } from './TagPicker';

const ClockIcon = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
const ChatIcon = ({ size = 18 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /></svg>;

export interface LeadTableProps {
  items: Lead[]; now: Date; tz: string; allStatuses: SelectableValue[]; markups: SelectableValue[];
  me: { id: number; role: string }; selected: Set<number>; onToggle(id: number): void; onToggleAll(ids: number[], on: boolean): void; onRelease(lead: Lead): void;
  sort: string; dir: string; onSort(col: string): void;
  onStatus(lead: Lead, statusId: number): void; onMarkup(lead: Lead, markupId: number | null): void;
  onRemarks(lead: Lead): void; onFollowup(lead: Lead): void; onOpen(lead: Lead): void;
}

/** Reason chip is derived from the live clock so it flips to "Overdue" without a refetch. */
function reasonOf(l: Lead, now: Date, tz: string): 'new' | 'overdue' | 'today' | null {
  if (l.status.category !== 'active') return null;
  if (l.status.is_new_state) return 'new';
  const f = followupInfo(l.next_followup_at, now, tz);
  if (f.kind === 'overdue') return 'overdue';
  if (f.kind === 'today') return 'today';
  return null;
}
const REASON = {
  new: { label: 'New', cls: 'bg-brand-600 text-white' },
  overdue: { label: 'Overdue', cls: 'bg-red-600 text-white' },
  today: { label: 'Today', cls: 'bg-amber-500 text-white' },
} as const;
const ROW_ACCENT = { new: 'border-l-brand-500', overdue: 'border-l-red-500', today: 'border-l-amber-400' } as const;

const UserArrowIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.5 3.200-5.500 6.500-5.500M15 17h6m-2.500-2.500L21 17l-2.500 2.500" /></svg>;

function Check({ on, onChange, label }: { on: boolean; onChange(): void; label: string }) {
  return <input type="checkbox" checked={on} onChange={onChange} onClick={(e) => e.stopPropagation()} aria-label={label} className="h-[18px] w-[18px] shrink-0 cursor-pointer rounded border-slate-300 accent-[#4f46e5]" />;
}

/** Top-of-card marker for temporarily allocated leads. Release is offered to the allocatee, the allocator and admins. */
function AllocatedRibbon({ l, me, tz, onRelease, compact }: { l: Lead; me: { id: number; role: string }; tz: string; onRelease(): void; compact?: boolean }) {
  const a = l.allocated;
  if (!a) return null;
  const mine = a.to.id === me.id;
  const canRelease = me.role === 'admin' || mine || a.by?.id === me.id;
  return (
    <div className={`flex items-center gap-1.5 bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white ${compact ? '' : 'rounded-md'}`} title={`Allocated ${fmtDateTime(a.at, tz)}`}>
      <UserArrowIcon />
      <span className="min-w-0 flex-1 truncate">{mine ? 'Allocated to you' : `Allocated to ${a.to.name}`}{a.by && ` · by ${a.by.id === me.id ? 'you' : a.by.name}`}<span className="font-normal opacity-80"> · {fmtTime(a.at, tz)}</span></span>
      {canRelease && <button onClick={onRelease} className="shrink-0 rounded bg-white/20 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide hover:bg-white/30" title="Clear the allocation">{mine ? 'Done' : 'Release'}</button>}
    </div>
  );
}

const ReasonChip = ({ r }: { r: 'new' | 'overdue' | 'today' | null }) => (r
  ? <span className={`shrink-0 rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${REASON[r].cls}`}>{REASON[r].label}</span> : null);

/** Coloured select styled as a chip. */
function ChipSelect({ colour, value, onChange, label, children, className = '' }: { colour?: string | null; value: string | number; onChange(v: string): void; label: string; children: React.ReactNode; className?: string }) {
  const c = colour || '#64748b';
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} onClick={(e) => e.stopPropagation()}
      className={`chip-select cursor-pointer truncate rounded-full border py-1 pl-2.5 pr-6 text-xs font-semibold outline-none focus:ring-2 focus:ring-brand-100 ${className}`}
      style={{ backgroundColor: `${c}14`, color: c, borderColor: `${c}40` }}>
      {children}
    </select>
  );
}

function StatusSelect({ l, allStatuses, onStatus, className }: { l: Lead; allStatuses: SelectableValue[]; onStatus(id: number): void; className?: string }) {
  // Inactive values cannot be newly assigned; the lead's current value stays visible.
  const known = allStatuses.some((s) => s.id === l.status.id);
  return (
    <ChipSelect colour={l.status.colour} value={l.status.id} onChange={(v) => onStatus(Number(v))} label={`Status for ${l.lead_code}`} className={className}>
      {!known && <option value={l.status.id}>{l.status.label} (inactive)</option>}
      {allStatuses.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </ChipSelect>
  );
}

function MarkupSelect({ l, markups, onMarkup, className }: { l: Lead; markups: SelectableValue[]; onMarkup(id: number | null): void; className?: string }) {
  const cur = l.special_markup;
  const known = !cur || markups.some((m) => m.id === cur.id);
  return (
    <ChipSelect colour={cur?.colour ?? '#94a3b8'} value={cur?.id ?? ''} onChange={(v) => onMarkup(v ? Number(v) : null)} label={`Priority for ${l.lead_code}`} className={className}>
      <option value="">★ No priority</option>
      {!known && cur && <option value={cur.id}>★ {cur.label} (inactive)</option>}
      {markups.map((m) => <option key={m.id} value={m.id}>★ {m.label}</option>)}
    </ChipSelect>
  );
}

function FollowupChip({ l, now, tz, onClick, compact }: { l: Lead; now: Date; tz: string; onClick(): void; compact?: boolean }) {
  const info = followupInfo(l.next_followup_at, now, tz);
  if (!l.next_followup_at) {
    return <button onClick={onClick} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-500 hover:border-brand-500 hover:text-brand-600"><ClockIcon /> Schedule</button>;
  }
  const tone = info.overdue ? 'bg-red-50 text-red-700 border-red-200' : info.kind === 'today' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-50 text-slate-600 border-slate-200';
  return (
    <button onClick={onClick} title={`${fmtDateTime(l.next_followup_at, tz)} — click to reschedule`} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      <ClockIcon />{compact ? info.text.replace('Follow-up ', '') : `${fmtShort(l.next_followup_at, tz)} · ${info.text}`}
    </button>
  );
}

const SortTh = ({ col, label, p }: { col: string; label: string; p: LeadTableProps }) => (
  <th scope="col" className="sticky top-0 z-10 bg-slate-50 px-3 py-2.5 text-left">
    <button className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide hover:text-slate-900" onClick={() => p.onSort(col)}>
      {label}{p.sort === col && <span aria-hidden>{p.dir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  </th>
);

export function LeadTable(p: LeadTableProps) {
  const { items, now, tz } = p;
  return (
    <>
      {/* Desktop / tablet */}
      <div className="scroll-thin hidden overflow-auto rounded-xl border border-slate-200 bg-white shadow-card md:block md:h-full">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="text-[11px] text-slate-500">
            <tr>
              <th scope="col" className="sticky top-0 z-10 w-9 bg-slate-50 py-2.5 pl-3"><Check on={items.length > 0 && items.every((l) => p.selected.has(l.id))} onChange={() => p.onToggleAll(items.map((l) => l.id), !items.every((l) => p.selected.has(l.id)))} label="Select all on this page" /></th>
              <SortTh col="created_at" label="Lead" p={p} />
              <SortTh col="nickname" label="Name / Enquiry" p={p} />
              <th scope="col" className="sticky top-0 z-10 bg-slate-50 px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Contact</th>
              <SortTh col="status" label="Status / Priority" p={p} />
              <SortTh col="next_followup_at" label="Next follow-up" p={p} />
              <th scope="col" className="sticky top-0 z-10 bg-slate-50 px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Latest remark</th>
              <SortTh col="last_action_at" label="Assigned / Last action" p={p} />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((l) => {
              const r = reasonOf(l, now, tz);
              return (
                <tr key={l.id} className={`border-l-4 align-top transition hover:bg-slate-50/80 ${p.selected.has(l.id) ? 'bg-brand-50/60' : ''} ${l.allocated ? 'border-l-violet-500' : r ? ROW_ACCENT[r] : 'border-l-transparent'}`}>
                  <td className="py-3 pl-3"><Check on={p.selected.has(l.id)} onChange={() => p.onToggle(l.id)} label={`Select ${l.lead_code}`} /></td>
                  <td className="px-3 py-2.5">
                    <button className="font-mono text-xs font-semibold text-brand-700 hover:underline" onClick={() => p.onOpen(l)}>{l.lead_code}</button>
                    {l.allocated && <div className="mt-1 max-w-[9rem]"><AllocatedRibbon l={l} me={p.me} tz={tz} onRelease={() => p.onRelease(l)} /></div>}
                    <div className="whitespace-nowrap text-[11px] text-slate-500">{fmtShort(l.created_at, tz)}</div>
                    <div className="text-[11px] text-slate-400">by {l.created_by?.name ?? l.source?.label ?? 'System'}</div>
                  </td>
                  <td className="min-w-[13rem] px-3 py-2.5">
                    <div className="flex items-center gap-1.5"><span className="font-semibold text-slate-900">{l.nickname || <span className="font-normal text-slate-400">No name</span>}</span><ReasonChip r={r} /></div>
                    {l.business_name && <div className="max-w-[14rem] truncate text-xs text-slate-600" title={l.business_name}>{l.business_name}</div>}
                    <div className="max-w-[14rem] text-xs text-slate-500">{l.enquiry_type?.label ?? l.requirement ?? '—'}</div>
                    {l.budget && <div className="text-[11px] text-slate-400">Budget: {l.budget}</div>}
                  </td>
                  <td className="px-3 py-2.5">
                    <PhoneCell phone={l.phone} email={l.email} />
                    <div className="mt-0.5 max-w-[15rem] truncate text-xs text-slate-500" title={l.email ?? ''}>{l.email ?? ''}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col items-start gap-1.5">
                      <StatusSelect l={l} allStatuses={p.allStatuses} onStatus={(id) => p.onStatus(l, id)} />
                      <MarkupSelect l={l} markups={p.markups} onMarkup={(id) => p.onMarkup(l, id)} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5"><FollowupChip l={l} now={now} tz={tz} onClick={() => p.onFollowup(l)} /></td>
                  <td className="px-3 py-2">
                    <button onClick={() => p.onRemarks(l)} className="block w-full max-w-[16rem] rounded-lg p-1.5 text-left hover:bg-slate-100" title="View all remarks / add a remark">
                      {l.last_remark ? (<>
                        {l.last_remark.tags.length > 0 && <span className="mb-0.5 flex flex-wrap gap-1">{l.last_remark.tags.map((t) => <TagChip key={t.id} tag={t} small />)}</span>}
                        {l.last_remark.text && <span className="line-clamp-2 break-words text-xs text-slate-700">{l.last_remark.text}</span>}
                        <span className="mt-0.5 block text-[10px] text-slate-400">{l.last_remark.by} · {fmtShort(l.last_remark.at, tz)}{l.remarks_count > 1 && ` · ${l.remarks_count} remarks`}</span>
                      </>) : <span className="text-xs text-slate-400">+ Add remark</span>}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">
                    <div>{l.assigned_to?.name ?? <span className="text-slate-400">Unassigned</span>}</div>
                    <div className="text-[11px] text-slate-400" title={fmtDateTime(l.last_action_at, tz)}>{l.last_action_by?.name ?? 'System'} · {fmtShort(l.last_action_at, tz)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards: identity + follow-up on top, contact actions, then status/priority side by side */}
      <ul className="space-y-2.5 md:hidden">
        {items.map((l) => {
          const r = reasonOf(l, now, tz);
          const sub = [l.business_name, l.enquiry_type?.label ?? l.requirement].filter(Boolean).join(' · ');
          return (
            <li key={l.id} className={`overflow-hidden rounded-2xl border border-l-4 bg-white shadow-card ${p.selected.has(l.id) ? 'border-brand-500 ring-2 ring-brand-100' : 'border-slate-200'} ${l.allocated ? 'border-l-violet-500' : r ? ROW_ACCENT[r] : 'border-l-slate-200'}`}>
              <AllocatedRibbon l={l} me={p.me} tz={tz} onRelease={() => p.onRelease(l)} compact />
              <div className="px-3 pb-2.5 pt-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className="pt-1"><Check on={p.selected.has(l.id)} onChange={() => p.onToggle(l.id)} label={`Select ${l.lead_code}`} /></div>
                    <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <button className="truncate text-base font-semibold leading-tight text-slate-900" onClick={() => p.onOpen(l)}>{l.nickname || <span className="font-normal text-slate-400">No name</span>}</button>
                      <ReasonChip r={r} />
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500"><button className="font-mono font-semibold text-brand-600" onClick={() => p.onOpen(l)}>{l.lead_code}</button><span title={`Created ${fmtDateTime(l.created_at, tz)}`}> · {fmtShort(l.created_at, tz)}</span>{sub && ` · ${sub}`}</p>
                    </div>
                  </div>
                  <FollowupChip l={l} now={now} tz={tz} onClick={() => p.onFollowup(l)} compact />
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-semibold tabular-nums text-slate-900">{l.phone ?? l.email ?? '—'}</div>
                    {l.budget
                      ? <span className="mt-0.5 inline-flex max-w-full items-center truncate rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700" title="Budget">₹ {l.budget}</span>
                      : <span className="mt-0.5 block text-[11px] text-slate-400">No budget given</span>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <ContactButtons phone={l.phone} email={l.email} size="lg" />
                    <button onClick={() => p.onRemarks(l)} aria-label={`Remarks (${l.remarks_count})`} title="Remarks"
                      className="relative inline-flex h-9 w-9 items-center justify-center rounded-full bg-violet-100 text-violet-700 transition hover:bg-violet-200 active:scale-95">
                      <ChatIcon />
                      {l.remarks_count > 0 && <span className="absolute -right-1 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-violet-600 px-1 text-[9px] font-bold text-white">{l.remarks_count}</span>}
                    </button>
                  </div>
                </div>

                {l.last_remark && (
                  <button onClick={() => p.onRemarks(l)} className="mt-2 flex w-full items-center gap-1.5 overflow-hidden rounded-lg bg-slate-50 px-2 py-1 text-left text-xs text-slate-600">
                    {l.last_remark.tags.slice(0, 2).map((t) => <TagChip key={t.id} tag={t} small />)}
                    {l.last_remark.tags.length > 2 && <span className="shrink-0 text-[10px] text-slate-400">+{l.last_remark.tags.length - 2}</span>}
                    {l.last_remark.text && <span className="min-w-0 flex-1 truncate italic">“{l.last_remark.text}”</span>}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 border-t border-slate-100 bg-slate-50/70 px-3 py-2">
                <StatusSelect l={l} allStatuses={p.allStatuses} onStatus={(id) => p.onStatus(l, id)} className="w-full" />
                <MarkupSelect l={l} markups={p.markups} onMarkup={(id) => p.onMarkup(l, id)} className="w-full" />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Read-only list for the Removed tab: who removed it, when, why — plus Restore. */
export function RemovedList({ items, tz, onRestore, onOpen }: { items: Lead[]; tz: string; onRestore(l: Lead): void; onOpen(l: Lead): void }) {
  return (
    <ul className="space-y-2.5">
      {items.map((l) => (
        <li key={l.id} className="overflow-hidden rounded-2xl border border-l-4 border-slate-200 border-l-slate-400 bg-white shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <button className="truncate text-base font-semibold text-slate-900" onClick={() => onOpen(l)}>{l.nickname || <span className="font-normal text-slate-400">No name</span>}</button>
                <span className="rounded-full border px-2 py-px text-[11px] font-semibold" style={{ color: l.status.colour ?? '#64748b', borderColor: `${l.status.colour ?? '#64748b'}55` }}>{l.status.label}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-slate-500"><button className="font-mono font-semibold text-brand-600" onClick={() => onOpen(l)}>{l.lead_code}</button> · {[l.business_name, l.enquiry_type?.label ?? l.requirement, l.budget && `₹ ${l.budget}`].filter(Boolean).join(' · ') || '—'}</p>
              <div className="mt-1.5"><PhoneCell phone={l.phone} email={l.email} /></div>
            </div>
            <button className="btn btn-ghost !py-1.5 text-xs text-emerald-700" onClick={() => onRestore(l)}>↺ Restore</button>
          </div>
          <div className="border-t border-red-100 bg-red-50/60 px-3 py-2 text-xs text-red-900">
            <p className="font-semibold">Removed by {l.removed?.by ?? 'Unknown'} · {l.removed ? fmtDateTime(l.removed.at, tz) : ''}</p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-red-800">{l.removed?.reason}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
