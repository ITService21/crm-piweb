import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get } from '../lib/api';
import { INVOICE_STATUSES, QUOTATION_STATUSES, STATUS_META, apiBase, docLabel, docLabelPlural, fmtDay, money, routeBase } from '../lib/billing';
import type { DocRow, DocType } from '../lib/types';
import { useAuth } from '../store';
import { useRealtime } from '../realtime';
import { CancelModal, EmailModal, IssueModal, PaymentModal, WhatsAppModal, type DocRef } from '../components/billing/DocModals';
import { StatusBadge } from '../components/billing/StatusBadge';
import { Pager, PAGE_SIZES } from '../components/Pager';
import { EmptyState, ErrorState, Spinner, errMsg } from '../components/ui';

type Kind = 'issue' | 'email' | 'whatsapp' | 'payment' | 'cancel';
type Modal = { kind: Kind; doc: DocRef } | null;
type Meta = { total: number; totalPages: number; status_counts: Record<string, number>; period_counts: Record<string, number>; followup_due: number; summary: { count: number; value: string; paid: string; due: string } | null };
const PERIODS: [string, string][] = [['all', 'All'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'], ['last_month', 'Last month'], ['custom', 'Custom']];
const PAYABLE = ['issued', 'partially_paid'];

function RowMenu({ row, onAction, canEdit }: { row: DocRow; onAction(kind: Kind): void; canEdit: boolean }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close);
  }, []);
  const draft = row.status === 'draft'; const live = !['draft', 'cancelled'].includes(row.status);
  const item = 'block w-full px-3 py-2 text-left text-sm hover:bg-slate-50';
  const pick = (k: Kind) => () => { setOpen(false); onAction(k); };
  return (
    <div className="relative" ref={ref}>
      <button className="rounded-lg px-2 py-1 text-lg leading-none text-slate-500 hover:bg-slate-100" onClick={() => setOpen(!open)} aria-label={`Actions for ${row.doc_number}`} aria-expanded={open}>⋯</button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg" role="menu">
          <Link className={item} to={`${routeBase(row.type)}/${row.id}`}>{draft && canEdit ? 'Edit draft' : 'Open details'}</Link>
          <a className={item} href={`/api${apiBase(row.type)}/${row.id}/pdf?download=1`}>Download PDF</a>
          {draft && canEdit && <button className={item} onClick={pick('issue')}>Issue {docLabel(row.type).toLowerCase()}…</button>}
          {live && <button className={item} onClick={pick('email')}>Email to client…</button>}
          {live && <button className={item} onClick={pick('whatsapp')}>Send on WhatsApp…</button>}
          {row.type === 'invoice' && canEdit && PAYABLE.includes(row.status) && <button className={item} onClick={pick('payment')}>Record payment…</button>}
          {canEdit && (draft || row.status !== 'cancelled') && <button className={`${item} text-red-600`} onClick={pick('cancel')}>Cancel…</button>}
        </div>
      )}
    </div>
  );
}

/** Invoices and quotations share this list; only the columns and statuses differ. */
export function DocumentListPage({ type }: { type: DocType }) {
  const { me } = useAuth(); const { refreshSummary } = useRealtime();
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') || ''; const status = sp.get('status') || 'all'; const from = sp.get('from') || ''; const to = sp.get('to') || '';
  const period = sp.get('period') || 'all'; const followup = sp.get('followup') === 'due';
  const page = Number(sp.get('page')) || 1; const sizeParam = Number(sp.get('size')); const pageSize = PAGE_SIZES.includes(sizeParam) ? sizeParam : 20;
  const [search, setSearch] = useState(q); useEffect(() => setSearch(q), [q]);
  const [rows, setRows] = useState<DocRow[] | null>(null);
  const [meta, setMeta] = useState<Meta>({ total: 0, totalPages: 1, status_counts: {}, period_counts: {}, followup_due: 0, summary: null });
  const [err, setErr] = useState(''); const [modal, setModal] = useState<Modal>(null);
  const reqId = useRef(0); const inv = type === 'invoice'; const canEdit = me!.role !== 'telecaller';

  const update = useCallback((patch: Record<string, string | null>, resetPage = true) => {
    setSp((prev) => { const n = new URLSearchParams(prev); for (const [k, v] of Object.entries(patch)) { if (!v || v === 'all') n.delete(k); else n.set(k, v); } if (resetPage) n.delete('page'); return n; }, { replace: true });
  }, [setSp]);
  useEffect(() => { const t = setTimeout(() => { if (search !== q) update({ q: search }); }, 300); return () => clearTimeout(t); }, [search, q, update]);

  const load = useCallback(async () => {
    const id = ++reqId.current; setErr('');
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (q) p.set('q', q); if (status !== 'all') p.set('status', status); if (period !== 'all') p.set('period', period);
      if (period === 'custom') { if (from) p.set('from', from); if (to) p.set('to', to); }
      if (followup) p.set('followup', 'due');
      const r = await get<DocRow[]>(`${apiBase(type)}?${p}`);
      if (id !== reqId.current) return;
      setRows(r.data); setMeta(r.meta as never); refreshSummary();
    } catch (e) { if (id === reqId.current) setErr(errMsg(e)); }
  }, [type, q, status, period, from, to, followup, page, pageSize, refreshSummary]);
  useEffect(() => { setRows(null); void load(); }, [load]);

  const statuses = inv ? INVOICE_STATUSES : QUOTATION_STATUSES;
  const ref = (r: DocRow): DocRef => ({ id: r.id, type: r.type, doc_number: r.doc_number, total: r.total, outstanding: r.outstanding, currency: r.currency });
  const hasFilters = !!(q || status !== 'all' || period !== 'all' || followup);
  const sel = 'h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 border-b border-slate-200 bg-white px-3 pb-2.5 pt-2.5 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[10rem] flex-1">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden>⌕</span>
            <input type="search" className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-7 pr-2 text-sm outline-none focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100" placeholder={`Search ${docLabel(type).toLowerCase()} no., client, lead…`} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          </div>
          <select className={sel} value={status} onChange={(e) => update({ status: e.target.value })} aria-label="Filter by status">
            <option value="all">All statuses{Object.keys(meta.status_counts).length ? ` (${Object.values(meta.status_counts).reduce((a, b) => a + b, 0)})` : ''}</option>
            {statuses.map((s) => <option key={s} value={s}>{STATUS_META[s]?.label ?? s}{meta.status_counts[s] ? ` (${meta.status_counts[s]})` : ''}</option>)}
          </select>
          {hasFilters && <button className="btn btn-ghost !py-1.5 text-xs" onClick={() => setSp(new URLSearchParams(), { replace: true })}>Clear</button>}
        </div>
        {/* by generated date */}
        <div className="no-scrollbar -mx-1 flex items-center gap-1.5 overflow-x-auto px-1" role="group" aria-label="Generated date">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Generated</span>
          {PERIODS.map(([k, label]) => {
            const n = k === 'custom' ? null : meta.period_counts[k]; const on = period === k;
            return (
              <button key={k} onClick={() => update({ period: k, ...(k !== 'custom' ? { from: null, to: null } : {}) })} aria-pressed={on}
                className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition ${on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
                {label}{n != null && <span className={`ml-1.5 tabular-nums ${on ? 'text-white/80' : 'text-slate-400'}`}>{n}</span>}
              </button>
            );
          })}
          {inv && (
            <button onClick={() => update({ followup: followup ? null : 'due' })} aria-pressed={followup}
              className={`ml-1 shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition ${followup ? 'border-red-600 bg-red-600 text-white' : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'}`}>
              Payment follow-up due<span className="ml-1.5 tabular-nums">{meta.followup_due}</span>
            </button>
          )}
        </div>
        {period === 'custom' && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <input type="date" className={sel} value={from} max={to || undefined} onChange={(e) => update({ from: e.target.value })} aria-label="Generated from" />to
            <input type="date" className={sel} value={to} min={from || undefined} onChange={(e) => update({ to: e.target.value })} aria-label="Generated to" />
          </div>
        )}
        {meta.summary && (
          <dl className="grid grid-cols-2 gap-2 sm:flex sm:gap-6" aria-label="Summary of the current selection">
            <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{docLabelPlural(type)}</dt><dd className="text-sm font-bold tabular-nums text-slate-900">{meta.summary.count}</dd></div>
            <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{inv ? 'Billed' : 'Quoted'}</dt><dd className="text-sm font-bold tabular-nums text-slate-900">{money(meta.summary.value)}</dd></div>
            {inv && <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Received</dt><dd className="text-sm font-bold tabular-nums text-emerald-700">{money(meta.summary.paid)}</dd></div>}
            {inv && <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Pending</dt><dd className="text-sm font-bold tabular-nums text-red-600">{money(meta.summary.due)}</dd></div>}
          </dl>
        )}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5 md:overflow-hidden">
        {err ? <ErrorState message={err} onRetry={load} /> : !rows ? <Spinner /> : rows.length === 0 ? (
          <EmptyState title={hasFilters ? `No ${docLabelPlural(type).toLowerCase()} match these filters.` : `No ${docLabelPlural(type).toLowerCase()} yet.`}
            hint={hasFilters ? undefined : `Open a lead and choose “Generate ${docLabel(type)}” to create your first one.`} />
        ) : (
          <>
            <div className="scroll-thin hidden overflow-auto rounded-xl border border-slate-200 bg-white shadow-card md:block md:h-full">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="text-[11px] text-slate-500">
                  <tr>{[`${docLabel(type)} no.`, 'Client', 'Lead', 'Date', inv ? 'Due' : 'Valid until', 'Total', ...(inv ? ['Paid', 'Balance'] : []), 'Status', 'Created', ''].map((h, i) => (
                    <th key={i} className={`sticky top-0 z-10 bg-slate-50 px-3 py-2.5 font-semibold uppercase tracking-wide ${['Total', 'Paid', 'Balance'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id} className="transition hover:bg-slate-50/80">
                      <td className="px-3 py-2.5"><Link className="font-mono text-xs font-semibold text-brand-700 hover:underline" to={`${routeBase(type)}/${r.id}`}>{r.doc_number}</Link></td>
                      <td className="max-w-[14rem] truncate px-3 py-2.5 font-medium text-slate-800" title={r.client_name ?? ''}>{r.client_name || <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{r.lead.lead_code}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-600">{fmtDay(r.issue_date)}</td>
                      <td className={`whitespace-nowrap px-3 py-2.5 text-xs ${r.is_overdue ? 'font-semibold text-red-600' : 'text-slate-600'}`}>{fmtDay(r.due_date)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{money(r.total, r.currency)}</td>
                      {inv && <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-emerald-700">{money(r.amount_paid, r.currency)}</td>}
                      {inv && <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-700">{money(r.outstanding, r.currency)}</td>}
                      <td className="px-3 py-2.5"><StatusBadge status={r.status} overdue={r.is_overdue} expired={r.is_expired} />{inv && r.next_payment_due && <p className={`mt-0.5 text-[10px] ${r.payment_followup_due ? 'font-semibold text-red-600' : 'text-slate-500'}`}>Next payment {fmtDay(r.next_payment_due)}</p>}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-500">{fmtDay(r.created_at.slice(0, 10))}</td>
                      <td className="px-2 py-2.5 text-right"><RowMenu row={r} canEdit={canEdit} onAction={(kind) => setModal({ kind, doc: ref(r) })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-2.5 md:hidden">
              {rows.map((r) => (
                <li key={r.id} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-card">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><Link className="font-mono text-xs font-semibold text-brand-700" to={`${routeBase(type)}/${r.id}`}>{r.doc_number}</Link><p className="truncate font-semibold text-slate-900">{r.client_name || '—'}</p></div>
                    <div className="flex items-center gap-1"><StatusBadge status={r.status} overdue={r.is_overdue} expired={r.is_expired} size="sm" /><RowMenu row={r} canEdit={canEdit} onAction={(kind) => setModal({ kind, doc: ref(r) })} /></div>
                  </div>
                  <div className="mt-2 flex items-end justify-between">
                    <div className="text-[11px] text-slate-500">{fmtDay(r.issue_date)}{r.due_date && <> · {inv ? 'due' : 'valid until'} <span className={r.is_overdue ? 'font-semibold text-red-600' : ''}>{fmtDay(r.due_date)}</span></>}<br />{r.lead.lead_code}</div>
                    <div className="text-right"><p className="text-base font-bold tabular-nums text-slate-900">{money(r.total, r.currency)}</p>{inv && Number(r.outstanding) > 0 && Number(r.amount_paid) > 0 && <p className="text-[11px] text-slate-500">Balance {money(r.outstanding, r.currency)}</p>}</div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <Pager page={page} totalPages={meta.totalPages} total={meta.total} size={pageSize} onPage={(n) => update({ page: String(n) }, false)} onSize={(n) => update({ size: n === 20 ? null : String(n) })} />

      {modal?.kind === 'issue' && <IssueModal doc={modal.doc} onClose={() => setModal(null)} onDone={load} />}
      {modal?.kind === 'cancel' && <CancelModal doc={modal.doc} onClose={() => setModal(null)} onDone={load} />}
      {modal?.kind === 'payment' && <PaymentModal doc={modal.doc} onClose={() => setModal(null)} onDone={load} />}
      {modal?.kind === 'whatsapp' && <WhatsAppModal doc={modal.doc} onClose={() => setModal(null)} onDone={load} />}
      {modal?.kind === 'email' && <EmailModal doc={modal.doc} onClose={() => setModal(null)} onDone={load} />}
    </div>
  );
}
