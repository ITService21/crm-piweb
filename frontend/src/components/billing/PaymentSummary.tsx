import { useEffect, useRef, useState } from 'react';
import { del, patch, upload } from '../../lib/api';
import { checkProofs, fmtDay, fmtSize, money, proofUrl, todayISO } from '../../lib/billing';
import type { BillingDoc, Payment } from '../../lib/types';
import { errMsg } from '../ui';

const PAYABLE = ['issued', 'partially_paid'];

function Lightbox({ src, name, onClose }: { src: string; name: string; onClose(): void }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-slate-900/80 p-4" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <img src={src} alt={name} className="max-h-[85vh] max-w-full rounded-lg bg-white object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
      <div className="mt-3 flex items-center gap-3 text-sm text-white"><span className="max-w-[60vw] truncate">{name}</span><a className="underline" href={src} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Open in new tab</a><button className="rounded-lg border border-white/40 px-2.5 py-1" onClick={onClose}>Close</button></div>
    </div>
  );
}

function PaymentRow({ doc, p, canEdit, onChanged }: { doc: BillingDoc; p: Payment; canEdit: boolean; onChanged(): void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [view, setView] = useState<{ src: string; name: string } | null>(null);
  const files = p.attachments ?? [];
  const add = async (list: FileList | null) => {
    const picked = Array.from(list ?? []); if (fileRef.current) fileRef.current.value = '';
    if (!picked.length) return;
    const bad = checkProofs(picked); if (bad) { setErr(bad); return; }
    setBusy(true); setErr('');
    try { const fd = new FormData(); picked.forEach((f) => fd.append('files', f)); await upload(`/invoices/${doc.id}/payments/${p.id}/attachments`, fd); onChanged(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async (id: number, name: string) => {
    if (!window.confirm(`Remove “${name}” from this payment?`)) return;
    setBusy(true); setErr('');
    try { await del(`/invoices/${doc.id}/payments/${p.id}/attachments/${id}`); onChanged(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-base font-extrabold tabular-nums text-emerald-700">{money(p.amount, doc.currency)}</span>
        <span className="text-xs font-medium text-slate-600">{fmtDay(p.paid_on)}</span>
      </div>
      <p className="text-xs text-slate-500">{[p.method, p.reference && `Ref ${p.reference}`, p.created_by_name && `by ${p.created_by_name}`].filter(Boolean).join(' · ')}</p>
      {p.notes && <p className="text-xs italic text-slate-500">{p.notes}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {files.map((f) => {
          const src = proofUrl(doc.id, p.id, f.id); const img = f.mime.startsWith('image/');
          return (
            <div key={f.id} className="group relative">
              {img ? (
                <button type="button" onClick={() => setView({ src, name: f.name })} title={`${f.name} (${fmtSize(f.size)})`} className="block h-14 w-14 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 transition hover:ring-2 hover:ring-brand-300">
                  <img src={src} alt={f.name} loading="lazy" className="h-full w-full object-cover" />
                </button>
              ) : (
                <a href={src} target="_blank" rel="noopener noreferrer" title={`${f.name} (${fmtSize(f.size)})`} className="flex h-14 w-14 flex-col items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-[10px] font-bold text-red-600 hover:ring-2 hover:ring-brand-300"><span className="text-lg" aria-hidden>📄</span>PDF</a>
              )}
              {canEdit && <button type="button" disabled={busy} onClick={() => remove(f.id, f.name)} aria-label={`Remove ${f.name}`} className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-[10px] text-white group-hover:flex group-focus-within:flex">✕</button>}
            </div>
          );
        })}
        {canEdit && (
          <>
            <input ref={fileRef} type="file" className="sr-only" id={`proof-${p.id}`} multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" onChange={(e) => void add(e.target.files)} />
            <label htmlFor={`proof-${p.id}`} className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border border-dashed border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 ${busy ? 'pointer-events-none opacity-50' : ''}`}>{busy ? 'Uploading…' : files.length ? '＋ Add proof' : '📎 Attach proof (screenshot)'}</label>
          </>
        )}
        {!canEdit && files.length === 0 && <span className="text-[11px] text-slate-400">No proof attached</span>}
      </div>
      {err && <p className="mt-1 text-xs text-red-600" role="alert">{err}</p>}
      {view && <Lightbox src={view.src} name={view.name} onClose={() => setView(null)} />}
    </li>
  );
}

/** Totals, every payment with its proof files, and the date the next payment is expected (drives the follow-up reminder). */
export function PaymentSummary({ doc, canEdit, tz, onRecord, onChanged }: { doc: BillingDoc; canEdit: boolean; tz: string; onRecord(): void; onChanged(): void }) {
  const payable = PAYABLE.includes(doc.status); const payments = doc.payments ?? [];
  const today = todayISO(tz); const pct = Math.min(100, Number(doc.total) ? (Number(doc.amount_paid) / Number(doc.total)) * 100 : 0);
  const [date, setDate] = useState(doc.next_payment_due ?? ''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [saved, setSaved] = useState(false);
  useEffect(() => setDate(doc.next_payment_due ?? ''), [doc.next_payment_due]);
  const saveDue = async (value: string | null) => {
    setBusy(true); setErr(''); setSaved(false);
    try { await patch(`/invoices/${doc.id}/next-due`, { date: value }); setSaved(true); onChanged(); setTimeout(() => setSaved(false), 2000); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const overdueDays = doc.next_payment_due && doc.next_payment_due < today ? Math.round((Date.parse(today) - Date.parse(doc.next_payment_due)) / 864e5) : 0;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5" aria-label="Payment summary">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="text-sm font-bold text-slate-900">Payment summary</h3><p className="mt-0.5 text-xs text-slate-500">Clients can pay in parts — add each payment with its screenshot as it arrives.</p></div>
        {canEdit && payable && <button className="btn btn-primary !py-1.5 text-xs" onClick={onRecord}>＋ Add payment</button>}
      </div>

      {!canEdit && payable && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="note">
          <b>Telecallers can view payments but cannot add or change them.</b> The “Add payment” button, the next-payment date and the status menu are available to admins and agents.
        </div>
      )}

      {doc.payment_followup_due && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          <p><b>{overdueDays ? `Payment follow-up overdue by ${overdueDays} day${overdueDays === 1 ? '' : 's'}` : 'Payment follow-up due today'}</b> — {money(doc.outstanding, doc.currency)} is still pending. Contact the client{doc.client.phone ? ` on ${doc.client.phone}` : ''}.</p>
          {doc.client.phone && <a className="btn btn-ghost !py-1 text-xs" href={`tel:${doc.client.phone}`}>📞 Call</a>}
        </div>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Invoice total</dt><dd className="text-base font-extrabold tabular-nums text-slate-900">{money(doc.total, doc.currency)}</dd></div>
        <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Received</dt><dd className="text-base font-extrabold tabular-nums text-emerald-700">{money(doc.amount_paid, doc.currency)}</dd></div>
        <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Pending</dt><dd className={`text-base font-extrabold tabular-nums ${Number(doc.outstanding) > 0 ? 'text-red-600' : 'text-slate-900'}`}>{money(doc.outstanding, doc.currency)}</dd></div>
      </dl>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Share of the invoice paid"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} /></div>

      <div className="mt-4 border-t border-slate-100">
        {payments.length === 0 ? <p className="py-4 text-sm text-slate-500">No payments recorded yet.</p> : <ul className="divide-y divide-slate-100">{payments.map((p) => <PaymentRow key={p.id} doc={doc} p={p} canEdit={canEdit} onChanged={onChanged} />)}</ul>}
      </div>

      {payable && (
        <div className="mt-2 rounded-xl bg-slate-50 p-3">
          <label className="label" htmlFor="next-due">Next payment expected on</label>
          <div className="flex flex-wrap items-center gap-2">
            <input id="next-due" type="date" className="input !w-auto" min={today} value={date} disabled={!canEdit} onChange={(e) => setDate(e.target.value)} />
            {canEdit && <button className="btn btn-primary !py-1.5 text-xs" disabled={busy || !date || date === (doc.next_payment_due ?? '')} onClick={() => void saveDue(date)}>{doc.next_payment_due ? 'Change date' : 'Set date'}</button>}
            {canEdit && doc.next_payment_due && <button className="btn btn-ghost !py-1.5 text-xs" disabled={busy} onClick={() => void saveDue(null)}>Clear</button>}
            {saved && <span className="text-xs font-medium text-emerald-700">Saved ✓</span>}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">{doc.next_payment_due ? `You'll be reminded on ${fmtDay(doc.next_payment_due)} (the Invoices menu shows a badge) to follow up with the client.` : 'Pick the date the client promised to pay. When it arrives, this invoice is flagged so you can follow up.'}</p>
          {err && <p className="mt-1 text-xs text-red-600" role="alert">{err}</p>}
        </div>
      )}
    </section>
  );
}
