import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { get, patch, post } from '../lib/api';
import type { Lead, TabKey } from '../lib/types';
import { businessDate } from '../lib/time';
import { useAuth, useData } from '../store';
import { useRealtime } from '../realtime';
import { useNow } from '../hooks/useNow';
import { StatusBar } from '../components/StatusBar';
import { DateFilters, defaultDateFilter, hasDateFilters } from '../components/DateFilters';
import { LeadTable, RemovedList } from '../components/LeadTable';
import { Pager, PAGE_SIZES } from '../components/Pager';
import { useHeaderSlot } from '../Layout';
import { RemarksModal } from '../components/RemarksModal';
import { FollowupModal } from '../components/FollowupModal';
import { LeadDrawer } from '../components/LeadDrawer';
import { QuickAddLead } from '../components/QuickAddLead';
import { AllocateModal } from '../components/AllocateModal';
import { EmptyState, ErrorState, Spinner, errMsg } from '../components/ui';

const TITLES: Record<TabKey, { title: string; category: 'active' | 'not_interested' | 'converted' | 'removed'; empty: string }> = {
  leads: { title: 'Leads', category: 'active', empty: 'No leads match these filters.' },
  not_interested: { title: 'Not Interested', category: 'not_interested', empty: 'No leads here.' },
  converted: { title: 'Converted', category: 'converted', empty: 'No converted leads yet.' },
  scheduled: { title: 'Follow-up Scheduled', category: 'active', empty: 'No upcoming follow-ups match these filters.' },
  removed: { title: 'Removed', category: 'removed', empty: 'No removed leads. Leads you remove appear here and can be restored.' },
};
const DEFAULT_PAGE_SIZE = 20;

/** One container for all four lead views; state lives in the URL so filters survive reloads and can be shared. */
export function LeadListPage({ tab }: { tab: TabKey }) {
  const { me } = useAuth();
  const { statuses, values, users, byCategory } = useData();
  const headerSlot = useHeaderSlot();
  const { version, toast, refreshSummary } = useRealtime();
  const now = useNow();
  const tz = me!.timezone;
  const [sp, setSp] = useSearchParams();
  const cfg = TITLES[tab];

  const statusId = sp.get('status') ? Number(sp.get('status')) : null;
  const df = sp.get('df') || defaultDateFilter();
  const from = sp.get('from') || ''; const to = sp.get('to') || ''; const field = sp.get('field') || 'created';
  const assigned = sp.get('assigned') || 'all';
  const page = Number(sp.get('page')) || 1;
  const sizeParam = Number(sp.get('size'));
  const pageSize = PAGE_SIZES.includes(sizeParam) ? sizeParam : DEFAULT_PAGE_SIZE;
  const markupId = sp.get('markup') ? Number(sp.get('markup')) : null;
  const sort = sp.get('sort') || ''; const dir = sp.get('dir') || 'desc';
  const leadParam = sp.get('lead') ? Number(sp.get('lead')) : null;
  const q = sp.get('q') || '';

  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  const update = useCallback((patch: Record<string, string | null>, resetPage = true) => {
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') n.delete(k); else n.set(k, v); }
      if (resetPage) n.delete('page');
      return n;
    }, { replace: true });
  }, [setSp]);

  useEffect(() => { const t = setTimeout(() => { if (search !== q) update({ q: search }); }, 300); return () => clearTimeout(t); }, [search, q, update]);

  const [items, setItems] = useState<Lead[] | null>(null);
  const [meta, setMeta] = useState({ page: 1, totalPages: 1, total: 0, pageSize: DEFAULT_PAGE_SIZE });
  const [counts, setCounts] = useState<{ all: number; byStatus: Record<number, number>; byMarkup: Record<number, number>; markupAll: number } | null>(null);
  const [dateCounts, setDateCounts] = useState<Record<string, number | null> | null>(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [remarksFor, setRemarksFor] = useState<Lead | null>(null);
  const [followupFor, setFollowupFor] = useState<Lead | null>(null);
  const [adding, setAdding] = useState(false);
  const reqId = useRef(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allocating, setAllocating] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const dateKey = businessDate(now, tz); // changes at business-timezone midnight => lists re-sort and re-bucket
  const minuteKey = Math.floor(now.getTime() / 60000);

  const baseQuery = useMemo(() => {
    const p = new URLSearchParams({ tab });
    if (q) p.set('q', q);
    if (assigned !== 'all') p.set('assigned', assigned);
    if (markupId) p.set('markup', String(markupId));
    if (hasDateFilters(tab) && df !== 'all') {
      p.set('dateFilter', df);
      if (df === 'custom' || (tab === 'leads' && df === 'new')) { if (from) p.set('from', from); if (to) p.set('to', to); }
      if (df === 'custom' && tab === 'leads') p.set('dateField', field);
    }
    return p;
  }, [tab, q, assigned, df, from, to, field, markupId]);

  // A selection belongs to the filtered list it was made in; it survives paging so a multi-page selection works
  useEffect(() => { setSelected(new Set()); }, [tab, baseQuery, statusId]);

  const customIncomplete = df === 'custom' && !from && !to;
  const load = useCallback(async (silent: boolean) => {
    if (customIncomplete) { setItems([]); setCounts({ all: 0, byStatus: {}, byMarkup: {}, markupAll: 0 }); return; }
    const id = ++reqId.current;
    if (!silent) { setItems(null); setErr(''); } else setRefreshing(true);
    try {
      const listQ = new URLSearchParams(baseQuery); listQ.set('page', String(page)); listQ.set('pageSize', String(pageSize));
      if (statusId) listQ.set('status', String(statusId));
      if (sort) { listQ.set('sort', sort); listQ.set('dir', dir); }
      // Date-filter counts ignore the date filter itself but honour search, agent and the selected status.
      const dq = new URLSearchParams({ tab });
      if (q) dq.set('q', q);
      if (assigned !== 'all') dq.set('assigned', assigned);
      if (statusId) dq.set('status', String(statusId));
      if (markupId) dq.set('markup', String(markupId));
      if (df !== 'all') dq.set('dateFilter', df);
      if (from) dq.set('from', from); if (to) dq.set('to', to); if (df === 'custom' && tab === 'leads') dq.set('dateField', field);
      const [list, cnt, dcnt] = await Promise.all([
        get<Lead[]>(`/leads?${listQ}`), get(`/leads/counts?${baseQuery}`),
        hasDateFilters(tab) ? get(`/leads/date-counts?${dq}`) : Promise.resolve(null),
      ]);
      if (id !== reqId.current) return; // a newer request superseded this one
      setItems(list.data); setMeta(list.meta as any); setCounts(cnt.data); setDateCounts(dcnt ? dcnt.data : null); setErr('');
    } catch (e) {
      if (id !== reqId.current) return;
      if (!silent) setErr(errMsg(e));
    } finally { if (id === reqId.current) setRefreshing(false); }
  }, [baseQuery, page, pageSize, statusId, markupId, sort, dir, customIncomplete, tab, q, assigned, df, from, to, field]);

  useEffect(() => { void load(false); }, [load]);
  useEffect(() => { if (items) void load(true); }, [version, dateKey, minuteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = () => { void load(true); refreshSummary(); };

  const onStatus = async (lead: Lead, id: number) => {
    try {
      await post(`/leads/${lead.id}/status`, { status_id: id });
      const label = values.find((v) => v.id === id)?.label;
      const who = [lead.nickname, lead.business_name && `(${lead.business_name})`].filter(Boolean).join(' ');
      toast('info', `${lead.lead_code} → ${label}`, [who || 'No name', lead.enquiry_type?.label ?? lead.requirement].filter(Boolean).join(' · ')); changed();
    } catch (e) { toast('error', 'Could not change status', errMsg(e)); void load(true); }
  };
  const onMarkup = async (lead: Lead, id: number | null) => {
    try {
      await patch(`/leads/${lead.id}`, { special_markup_id: id });
      toast('info', `${lead.lead_code} priority → ${values.find((v) => v.id === id)?.label ?? 'none'}`); changed();
    } catch (e) { toast('error', 'Could not change priority', errMsg(e)); void load(true); }
  };
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = (ids: number[], on: boolean) => setSelected((s) => { const n = new Set(s); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n; });
  // "Select all" = every lead matching the current filters, across all pages (capped server-side at 1000)
  const selectAllMatching = async () => {
    try {
      const q2 = new URLSearchParams(baseQuery); if (statusId) q2.set('status', String(statusId));
      const r = await get<{ ids: number[]; capped: boolean }>(`/leads/ids?${q2}`);
      setSelected(new Set(r.data.ids));
      if (r.data.capped) toast('warn', `Selected the first ${r.data.ids.length} leads`, 'Narrow the filters to select the rest.');
    } catch (e) { toast('error', 'Could not select all', errMsg(e)); }
  };
  const release = async (ids: number[]) => {
    try {
      const r = await post<{ allocated: number; skipped: { reason: string }[] }>('/leads/allocate', { lead_ids: ids, user_id: null });
      toast(r.data.allocated ? (r.data.skipped.length ? 'warn' : 'info') : 'error', r.data.allocated ? `${r.data.allocated} allocation${r.data.allocated === 1 ? '' : 's'} cleared` : 'Nothing to clear',
        r.data.skipped.length ? `${r.data.skipped.length} skipped (${[...new Set(r.data.skipped.map((x) => x.reason))].join(', ')})` : undefined);
      setSelected(new Set()); changed();
    } catch (e) { toast('error', 'Could not clear allocation', errMsg(e)); }
  };
  const onRestore = async (lead: Lead) => {
    try { await post(`/leads/${lead.id}/restore`); toast('info', `${lead.lead_code} restored`); changed(); }
    catch (e) { toast('error', 'Could not restore lead', errMsg(e)); }
  };
  const onSort = (col: string) => {
    if (sort === col) update({ dir: dir === 'asc' ? 'desc' : 'asc' }, false);
    else update({ sort: col, dir: col === 'nickname' || col === 'next_followup_at' ? 'asc' : 'desc' });
  };

  // Removed leads keep the status they had, so that bar lists every status
  const tabStatuses = cfg.category === 'removed' ? values.filter((v) => v.category === 'lead_status') : statuses(cfg.category);
  const allAssignable = values.filter((v) => v.category === 'lead_status');
  const hasFilters = !!(q || statusId || markupId || assigned !== 'all' || df !== 'all' || sort);
  const liveFresh = () => setSp(new URLSearchParams(), { replace: true });

  const markups = byCategory('special_markup');
  const sel = 'h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="flex h-full flex-col">
      {headerSlot && tab === 'leads' && createPortal(
        <button className="btn btn-primary h-9 shrink-0 whitespace-nowrap !px-3 text-[13px]" onClick={() => setAdding(true)}><span aria-hidden>＋</span><span>Add<span className="max-[399px]:hidden"> lead</span></span></button>, headerSlot)}

      {/* Fixed toolbar: search, filters, status + date bars */}
      <div className="shrink-0 space-y-2 border-b border-slate-200 bg-white px-3 pb-2.5 pt-2.5 sm:px-5">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden>⌕</span>
            <input type="search" className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-7 pr-2 text-sm outline-none focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100" placeholder="Search name, phone, email, ID…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search leads" />
          </div>
          <select className={`${sel} w-[6.75rem] sm:w-auto`} value={assigned} onChange={(e) => update({ assigned: e.target.value })} aria-label="Filter by agent">
            <option value="all">All agents</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option>
            {users.filter((u) => u.id !== me!.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select className={`${sel} w-[6.75rem] sm:w-auto`} value={markupId ?? ''} onChange={(e) => update({ markup: e.target.value || null })} aria-label="Filter by priority">
            <option value="">★ All priority{counts ? ` (${counts.markupAll})` : ''}</option>
            {markups.map((m) => <option key={m.id} value={m.id}>★ {m.label}{counts ? ` (${counts.byMarkup[m.id] ?? 0})` : ''}</option>)}
          </select>
        </div>
        <StatusBar statuses={tabStatuses} counts={counts} selected={statusId} onSelect={(id) => update({ status: id ? String(id) : null })} />
        {hasDateFilters(tab) && (
          <DateFilters tab={tab} value={df} from={from} to={to} field={field} counts={dateCounts} onChange={(p) => update({
            ...(p.df !== undefined ? { df: p.df === 'all' ? null : p.df, ...(p.df !== 'custom' && p.df !== 'new' ? { from: null, to: null, field: null } : {}) } : {}),
            ...(p.from !== undefined ? { from: p.from } : {}), ...(p.to !== undefined ? { to: p.to } : {}), ...(p.field !== undefined ? { field: p.field } : {}),
          })} />
        )}
      </div>

      {/* Only this area scrolls */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5 md:overflow-hidden">
        {customIncomplete ? <EmptyState title="Pick a start or end date" hint="The custom range filters by calendar date in the business timezone." />
          : err ? <ErrorState message={err} onRetry={() => load(false)} />
          : !items ? <Spinner />
          : items.length === 0 ? (
            <div><EmptyState title={cfg.empty} hint={tab === 'leads' ? 'New enquiries appear here instantly.' : undefined} />
              {hasFilters && <div className="text-center"><button className="btn btn-ghost" onClick={liveFresh}>Clear all filters</button></div>}</div>
          ) : tab === 'removed' ? (
            <RemovedList items={items} tz={tz} onRestore={onRestore} onOpen={(l) => update({ lead: String(l.id) }, false)} />
          ) : (
            <LeadTable items={items} now={now} tz={tz} allStatuses={allAssignable} markups={markups} me={me!} selected={selected} onToggle={toggle} onToggleAll={toggleAll} onRelease={(l) => release([l.id])} sort={sort} dir={dir} onSort={onSort}
              onStatus={onStatus} onMarkup={onMarkup} onRemarks={setRemarksFor} onFollowup={setFollowupFor} onOpen={(l) => update({ lead: String(l.id) }, false)} />
          )}
      </div>

      {selected.size > 0 && tab !== 'removed' && (
        <div className="shrink-0 space-y-1.5 border-t border-brand-100 bg-brand-50 px-3 py-2 sm:flex sm:items-center sm:gap-3 sm:space-y-0 sm:px-5" role="region" aria-label="Bulk actions">
          <div className="flex items-center gap-2 sm:flex-1">
            <button className="rounded-lg p-1 text-slate-500 hover:bg-white" onClick={() => setSelected(new Set())} aria-label="Clear selection">✕</button>
            <span className="whitespace-nowrap text-sm font-semibold text-brand-700">{selected.size >= meta.total && meta.total > 0 ? `All ${selected.size}` : selected.size} selected</span>
            {selected.size < meta.total && <button className="ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-brand-700 underline-offset-2 hover:bg-white hover:underline sm:ml-2" onClick={selectAllMatching}>Select all {meta.total}</button>}
          </div>
          <div className="flex gap-2">
            {items?.some((l) => selected.has(l.id) && l.allocated) && <button className="btn btn-ghost flex-1 !py-1.5 text-xs sm:flex-none" onClick={() => release([...selected])}>Clear allocation</button>}
            <button className="btn btn-ghost flex-1 !py-1.5 text-xs sm:flex-none" onClick={() => setAssigning(true)}>Assign to…</button>
            <button className="btn btn-primary flex-1 !py-1.5 text-xs sm:flex-none" onClick={() => setAllocating(true)}>Allocate to…</button>
          </div>
        </div>
      )}
      <Pager page={page} totalPages={meta.totalPages} total={meta.total} size={pageSize}
        onPage={(n) => update({ page: String(n) }, false)} onSize={(n) => update({ size: n === DEFAULT_PAGE_SIZE ? null : String(n) })} />

      {assigning && <AllocateModal mode="assign" ids={[...selected]} onClose={() => setAssigning(false)} onDone={() => { setSelected(new Set()); changed(); }} />}
      {allocating && <AllocateModal ids={[...selected]} onClose={() => setAllocating(false)} onDone={() => { setSelected(new Set()); changed(); }} />}
      {remarksFor && <RemarksModal lead={remarksFor} tz={tz} onClose={() => setRemarksFor(null)} onChanged={changed} />}
      {followupFor && <FollowupModal lead={followupFor} tz={tz} now={now} onClose={() => setFollowupFor(null)} onChanged={changed} />}
      {adding && <QuickAddLead onClose={() => setAdding(false)} onCreated={changed} />}
      {leadParam && <LeadDrawer leadId={leadParam} onClose={() => update({ lead: null }, false)} onChanged={changed} />}
    </div>
  );
}
