import { useEffect, useMemo, useState } from 'react';
import { get, post, upload } from '../../lib/api';
import type { Payment } from '../../lib/types';
import { PAYMENT_METHODS, PROOF_MAX_FILES, checkProofs, apiBase, docLabel, money, todayISO, uuid } from '../../lib/billing';
import type { DocType } from '../../lib/types';
import { useAuth } from '../../store';
import { Modal, Spinner, errMsg } from '../ui';

export interface DocRef { id: number; type: DocType; doc_number: string; total: string; outstanding: string; currency: string }

/** Confirm issuing: after this the document is locked. Nothing is emailed. */
export function IssueModal({ doc, onClose, onDone }: { doc: DocRef; onClose(): void; onDone(): void }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await post(`${apiBase(doc.type)}/${doc.id}/issue`, { confirm: true }); onDone(); onClose(); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal title={`Issue ${docLabel(doc.type).toLowerCase()}?`} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Issuing…' : `Issue ${docLabel(doc.type).toLowerCase()}`}</button></>}>
      <p className="text-sm text-slate-700">You are about to issue <b>{doc.doc_number}</b> for <b>{money(doc.total, doc.currency)}</b>.</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li>Its number, client and company details, dates, line items and totals will be <b>locked</b>.</li>
        <li>It will <b>not</b> be emailed automatically. You can download the PDF or email it afterwards.</li>
        {doc.type === 'invoice' && <li>If something needs correcting later, cancel it and create a new one.</li>}
      </ul>
      {err && <p className="mt-3 text-sm text-red-600" role="alert">{err}</p>}
    </Modal>
  );
}

export function CancelModal({ doc, onClose, onDone }: { doc: DocRef; onClose(): void; onDone(): void }) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await post(`${apiBase(doc.type)}/${doc.id}/cancel`, { confirm: true, reason }); onDone(); onClose(); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal title={`Cancel ${doc.doc_number}?`} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Keep it</button><button className="btn btn-danger" onClick={go} disabled={busy || !reason.trim()}>{busy ? 'Cancelling…' : `Cancel ${docLabel(doc.type).toLowerCase()}`}</button></>}>
      <p className="mb-3 text-sm text-slate-600">The record and its number are kept for your history; the number is never reused. This cannot be undone.</p>
      <label className="label" htmlFor="cancel-reason">Reason (required)</label>
      <textarea id="cancel-reason" autoFocus className="input min-h-[80px]" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      {err && <p className="mt-2 text-sm text-red-600" role="alert">{err}</p>}
    </Modal>
  );
}

export function PaymentModal({ doc, onClose, onDone, markPaid = false }: { doc: DocRef; onClose(): void; onDone(): void; markPaid?: boolean }) {
  const { me } = useAuth();
  const key = useMemo(() => uuid(), []); // the same key is re-sent on retries/double clicks, so a payment is recorded once
  const [f, setF] = useState({ amount: doc.outstanding, paid_on: todayISO(me!.timezone), method: PAYMENT_METHODS[0], reference: '', notes: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [recorded, setRecorded] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const pick = (list: FileList | null) => { const next = Array.from(list ?? []); const bad = checkProofs(next); setErr(bad); if (!bad) setFiles(next); };
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await post<{ invoice: { payments?: Payment[] } }>(`/invoices/${doc.id}/payments`, { ...f, reference: f.reference || undefined, notes: f.notes || undefined, idempotency_key: key });
      setRecorded(true);
      if (files.length) {
        const mine = (r.data.invoice.payments ?? []).reduce((a, p) => (p.id > a.id ? p : a)); // the payment just created
        try { const fd = new FormData(); files.forEach((x) => fd.append('files', x)); await upload(`/invoices/${doc.id}/payments/${mine.id}/attachments`, fd); }
        catch (ex) { setErr(`The payment was recorded, but the proof could not be uploaded: ${errMsg(ex)} You can attach it from the payment list.`); setBusy(false); onDone(); return; }
      }
      onDone(); onClose();
    } catch (ex) { setErr(errMsg(ex)); setBusy(false); }
  };
  return (
    <Modal title={`${markPaid ? 'Mark as paid' : 'Add payment'} — ${doc.doc_number}`} onClose={onClose}>
      <form onSubmit={go} className="space-y-3">
        <div className="rounded-lg bg-slate-50 p-2.5 text-sm"><span className="text-slate-500">Outstanding balance</span> <b className="float-right">{money(doc.outstanding, doc.currency)}</b></div>
        {markPaid && <p className="text-xs text-slate-500">An invoice becomes <b>Paid</b> when its payments cover the total. The balance is filled in below — record it to mark the invoice as paid.</p>}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="pay-amt">Amount</label><input id="pay-amt" className="input" inputMode="decimal" required autoFocus disabled={recorded} value={f.amount} onChange={set('amount')} /></div>
          <div><label className="label" htmlFor="pay-date">Payment date</label><input id="pay-date" type="date" className="input" required disabled={recorded} max={todayISO(me!.timezone)} value={f.paid_on} onChange={set('paid_on')} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="pay-method">Method</label><select id="pay-method" className="input" disabled={recorded} value={f.method} onChange={set('method')}>{PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}</select></div>
          <div><label className="label" htmlFor="pay-ref">Reference / transaction no.</label><input id="pay-ref" className="input" maxLength={150} disabled={recorded} value={f.reference} onChange={set('reference')} /></div>
        </div>
        <div><label className="label" htmlFor="pay-notes">Internal notes</label><textarea id="pay-notes" className="input min-h-[60px]" disabled={recorded} value={f.notes} onChange={set('notes')} /></div>
        <div>
          <label className="label" htmlFor="pay-proof">Payment proof — screenshot or PDF (optional)</label>
          <input id="pay-proof" type="file" multiple disabled={recorded} accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" onChange={(e) => pick(e.target.files)} className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200" />
          <p className="mt-0.5 text-[11px] text-slate-500">Up to {PROOF_MAX_FILES} files, 8 MB each. You can also add proof later from the payment list.{files.length > 0 && <b> {files.length} selected.</b>}</p>
        </div>
        {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>{recorded ? 'Close' : 'Cancel'}</button>{!recorded && <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : markPaid ? 'Record & mark paid' : 'Add payment'}</button>}</div>
      </form>
    </Modal>
  );
}

interface EmailDefaults { to: string; subject: string; body: string; configured: boolean }

/** Compose + explicitly confirm. The server attaches the PDF rendered from the saved record. */
export function EmailModal({ doc, onClose, onDone }: { doc: DocRef; onClose(): void; onDone(): void }) {
  const [d, setD] = useState<EmailDefaults | null>(null);
  const [f, setF] = useState({ to: '', cc: '', subject: '', body: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [sentTo, setSentTo] = useState('');
  useEffect(() => {
    get<EmailDefaults>(`${apiBase(doc.type)}/${doc.id}/email-defaults`).then((r) => { setD(r.data); setF({ to: r.data.to, cc: '', subject: r.data.subject, body: r.data.body }); }).catch((e) => setErr(errMsg(e)));
  }, [doc.id, doc.type]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const send = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await post(`${apiBase(doc.type)}/${doc.id}/email`, { to: f.to, cc: f.cc || undefined, subject: f.subject, body: f.body, confirm: true }); setSentTo(f.to); onDone(); }
    catch (ex) { setErr(errMsg(ex)); onDone(); setBusy(false); }
  };
  return (
    <Modal title={`Email ${docLabel(doc.type).toLowerCase()}`} onClose={onClose} wide>
      {!d && !err ? <Spinner /> : sentTo ? (
        <div className="py-6 text-center"><p className="text-3xl">✅</p><p className="mt-2 font-semibold text-slate-900">Email sent to {sentTo}</p><p className="mt-1 text-sm text-slate-500">{doc.doc_number}.pdf was attached.</p><button className="btn btn-primary mt-4" onClick={onClose}>Done</button></div>
      ) : (
        <form onSubmit={send} className="space-y-3">
          {d && !d.configured && <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900">Email isn't set up on the server yet (SMTP). Ask the administrator to configure it — you can still download the PDF.</div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label" htmlFor="em-to">To</label><input id="em-to" type="email" required className="input" value={f.to} onChange={set('to')} placeholder="client@example.com" /></div>
            <div><label className="label" htmlFor="em-cc">CC (optional)</label><input id="em-cc" type="email" className="input" value={f.cc} onChange={set('cc')} /></div>
          </div>
          <div><label className="label" htmlFor="em-sub">Subject</label><input id="em-sub" required className="input" maxLength={255} value={f.subject} onChange={set('subject')} /></div>
          <div><label className="label" htmlFor="em-body">Message</label><textarea id="em-body" required className="input min-h-[190px]" value={f.body} onChange={set('body')} /></div>
          <p className="flex items-center gap-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600"><span aria-hidden>📎</span> {doc.doc_number}.pdf will be attached — generated from the saved {docLabel(doc.type).toLowerCase()}.</p>
          {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !d?.configured}>{busy ? 'Sending…' : 'Send email'}</button></div>
        </form>
      )}
    </Modal>
  );
}

const waDigits = (p: string) => { let d = p.replace(/\D/g, ''); if (d.length === 10) d = `91${d}`; else if (d.length === 11 && d.startsWith('0')) d = `91${d.slice(1)}`; return d; };

/**
 * Opens WhatsApp on the client's number with the message ready (WhatsApp links cannot attach files, so the PDF goes as a secure link).
 * Nothing is sent until the person presses Send inside WhatsApp.
 */
export function WhatsAppModal({ doc, onClose, onDone }: { doc: DocRef; onClose(): void; onDone(): void }) {
  const [ready, setReady] = useState(false);
  const [f, setF] = useState({ phone: '', message: '', link: '' });
  const [err, setErr] = useState(''); const [opened, setOpened] = useState(false); const [copied, setCopied] = useState(false);
  useEffect(() => {
    post<{ phone: string; message: string; link: string }>(`${apiBase(doc.type)}/${doc.id}/whatsapp-prepare`).then((r) => { setF(r.data); setReady(true); }).catch((e) => setErr(errMsg(e)));
  }, [doc.id, doc.type]);
  const open = () => {
    const n = waDigits(f.phone);
    if (n.length < 8) { setErr('Enter the WhatsApp number (with country code if it is not an Indian number).'); return; }
    setErr('');
    window.open(`https://wa.me/${n}?text=${encodeURIComponent(f.message)}`, '_blank', 'noopener'); // opened synchronously so popup blockers allow it
    post(`${apiBase(doc.type)}/${doc.id}/whatsapp-opened`, { to: f.phone }).then(onDone).catch(() => {});
    setOpened(true);
  };
  const copy = async () => { const { copyText } = await import('../../lib/clipboard'); if (await copyText(f.link)) { setCopied(true); setTimeout(() => setCopied(false), 1600); } };
  return (
    <Modal title="Send on WhatsApp" onClose={onClose} wide>
      {!ready && !err ? <Spinner /> : !ready ? <p className="text-sm text-red-600" role="alert">{err}</p> : opened ? (
        <div className="py-5 text-center"><p className="text-3xl">💬</p><p className="mt-2 font-semibold text-slate-900">WhatsApp opened</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">The message is ready in your chat with {f.phone}. Press <b>Send</b> in WhatsApp to deliver it.</p>
          <div className="mt-4 flex justify-center gap-2"><button className="btn btn-ghost" onClick={() => setOpened(false)}>Open again</button><button className="btn btn-primary" onClick={onClose}>Done</button></div></div>
      ) : (
        <div className="space-y-3">
          <div><label className="label" htmlFor="wa-phone">WhatsApp number</label><input id="wa-phone" className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+91 98765 43210" /><p className="mt-0.5 text-[11px] text-slate-500">Taken from the client's phone on this {docLabel(doc.type).toLowerCase()} (the lead's number). Correct it here if needed.</p></div>
          <div><label className="label" htmlFor="wa-msg">Message</label><textarea id="wa-msg" className="input min-h-[190px]" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></div>
          <p className="rounded-lg bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-600">WhatsApp opens with this message ready — <b>nothing is sent until you press Send there.</b> WhatsApp links can't attach files, so the PDF is shared as a secure link: <b>anyone who has the link can view this {docLabel(doc.type).toLowerCase()}'s PDF</b>.</p>
          {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
          <div className="flex flex-wrap justify-end gap-2"><button className="btn btn-ghost" onClick={copy}>{copied ? 'Link copied ✓' : 'Copy link'}</button><button className="btn btn-primary" style={{ background: '#16a34a' }} onClick={open}>Open WhatsApp</button></div>
        </div>
      )}
    </Modal>
  );
}
