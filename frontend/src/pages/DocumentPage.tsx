import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, get, patch, post } from '../lib/api';
import { apiBase, docLabel, docLabelPlural, fmtDay, money, routeBase, uuid } from '../lib/billing';
import { CLIENT_KEYS, type BillingDoc, type ClientInfo, type DocType, type Issuer } from '../lib/types';
import { useAuth } from '../store';
import { useRealtime } from '../realtime';
import { CancelModal, EmailModal, IssueModal, PaymentModal, WhatsAppModal, type DocRef } from '../components/billing/DocModals';
import { DocumentPreview, type PreviewData } from '../components/billing/DocumentPreview';
import { StatusBadge } from '../components/billing/StatusBadge';
import { PaymentSummary } from '../components/billing/PaymentSummary';
import { StatusMenu, type StatusOption } from '../components/billing/StatusMenu';
import { ErrorState, Spinner, errMsg } from '../components/ui';

type ClientKey = (typeof CLIENT_KEYS)[number];
interface FormItem { key: string; name: string; description: string; quantity: string; unit_price: string; discount_type: 'none' | 'percent' | 'amount'; discount_value: string; tax_rate: string }
interface Form {
  client: Record<ClientKey, string>; issue_date: string; due_date: string; currency: string; payment_terms: string; po_number: string; place_of_supply: string;
  client_notes: string; internal_notes: string; additional_charges: string; additional_charges_label: string; items: FormItem[];
}
interface Calc { items: { error?: string; taxable_amount: string; tax_amount: string; discount_amount: string; line_total: string }[]; totals: { subtotal: string; discount_total: string; taxable_amount: string; tax_amount: string; additional_charges: string; total: string }; amount_in_words: string | null }
interface Preset { id: number; name: string; description: string | null; unit_price: string; tax_rate: string | null; discount_type: 'none' | 'percent' | 'amount'; discount_value: string | null; is_default: boolean }
interface Prefill { default_items: { name: string; description: string | null; quantity: string; unit_price: string; tax_rate: string | null; discount_type: 'none' | 'percent' | 'amount'; discount_value: string | null }[]; lead: { id: number; lead_code: string; nickname: string | null; removed: boolean }; client: ClientInfo; issuer: Issuer; defaults: { issue_date: string; currency: string; payment_terms?: string }; expected_number: string | null; error: string | null }

const emptyItem = (): FormItem => ({ key: uuid(), name: '', description: '', quantity: '1', unit_price: '', discount_type: 'none', discount_value: '', tax_rate: '' });
const s = (v: string | null | undefined) => v ?? '';
const clientForm = (c: ClientInfo): Record<ClientKey, string> => Object.fromEntries(CLIENT_KEYS.map((k) => [k, s(c[k])])) as Record<ClientKey, string>;
const blankItem = (i: FormItem) => !i.name.trim() && !i.unit_price.trim() && !i.description.trim();

function formFromDoc(d: BillingDoc): Form {
  return {
    client: clientForm(d.client), issue_date: d.issue_date, due_date: s(d.due_date), currency: d.currency, payment_terms: s(d.payment_terms), po_number: s(d.po_number), place_of_supply: s(d.place_of_supply),
    client_notes: s(d.client_notes), internal_notes: s(d.internal_notes), additional_charges: Number(d.additional_charges) ? d.additional_charges : '', additional_charges_label: s(d.additional_charges_label),
    items: d.items.map((i) => ({ key: uuid(), name: i.name, description: s(i.description), quantity: i.quantity, unit_price: i.unit_price, discount_type: i.discount_type, discount_value: Number(i.discount_value) ? s(i.discount_value) : '', tax_rate: i.tax_rate ?? '' })),
  };
}
const itemPayload = (i: FormItem) => ({ name: i.name, description: i.description, quantity: i.quantity, unit_price: i.unit_price, discount_type: i.discount_type, discount_value: i.discount_type === 'none' ? null : i.discount_value || '0', tax_rate: i.tax_rate.trim() === '' ? null : i.tax_rate });
const buildPayload = (f: Form) => ({
  issue_date: f.issue_date, due_date: f.due_date || null, currency: f.currency, payment_terms: f.payment_terms, po_number: f.po_number, place_of_supply: f.place_of_supply,
  client_notes: f.client_notes, internal_notes: f.internal_notes, additional_charges: f.additional_charges.trim() || null, additional_charges_label: f.additional_charges_label,
  client: f.client, items: f.items.filter((i) => !blankItem(i)).map(itemPayload),
});

function Card({ title, hint, children, right }: { title: string; hint?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
      <div className="mb-3 flex items-start justify-between gap-2"><div><h3 className="text-sm font-bold text-slate-900">{title}</h3>{hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}</div>{right}</div>
      {children}
    </section>
  );
}
const Field = ({ label, children, span = false }: { label: string; children: ReactNode; span?: boolean }) => <div className={span ? 'sm:col-span-2' : ''}><label className="label">{label}</label>{children}</div>;

/** Each document gets a fresh editor instance, so busy/modal/idempotency state never leaks between documents. */
export function DocumentPage({ type }: { type: DocType }) {
  const { id } = useParams();
  return <DocumentEditor key={`${type}:${id}`} type={type} />;
}

function DocumentEditor({ type }: { type: DocType }) {
  const { id } = useParams(); const [sp] = useSearchParams(); const nav = useNavigate(); const { me } = useAuth(); const { refreshSummary } = useRealtime();
  const isNew = id === 'new'; const leadParam = Number(sp.get('lead')) || 0; const inv = type === 'invoice'; const canEdit = me!.role !== 'telecaller'; const tz = me!.timezone;
  const [doc, setDoc] = useState<BillingDoc | null>(null);
  const [pre, setPre] = useState<Prefill | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [calc, setCalc] = useState<Calc | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loadErr, setLoadErr] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState('');
  const [tab, setTab] = useState<'edit' | 'preview'>('edit'); const [dirty, setDirty] = useState(false);
  const [modal, setModal] = useState<'issue' | 'email' | 'whatsapp' | 'payment' | 'markpaid' | 'cancel' | null>(null);
  const [notesDraft, setNotesDraft] = useState<string | null>(null); const [taxAll, setTaxAll] = useState('');
  const idemKey = useRef(uuid());

  const load = useCallback(async () => {
    setLoadErr('');
    try {
      if (isNew) {
        if (!canEdit) { setLoadErr('Your role can view quotations and invoices but cannot create them.'); return; }
        if (!leadParam) { setLoadErr('Open a lead and choose “Generate” to start a new document.'); return; }
        const r = (await get<Prefill>(`${apiBase(type)}/prefill/${leadParam}`)).data;
        setPre(r); setDoc(null);
        // New documents start with the seeded default services (editable / removable)
        const starter = (r.default_items ?? []).map((i) => ({ ...emptyItem(), name: i.name, description: s(i.description), quantity: i.quantity, unit_price: i.unit_price, tax_rate: s(i.tax_rate), discount_type: i.discount_type ?? 'none', discount_value: s(i.discount_value) }));
        setForm({ client: clientForm(r.client), issue_date: r.defaults.issue_date, due_date: '', currency: r.defaults.currency, payment_terms: r.defaults.payment_terms ?? '', po_number: '', place_of_supply: '', client_notes: '', internal_notes: '', additional_charges: '', additional_charges_label: '', items: starter.length ? starter : [emptyItem()] });
        setDirty(starter.length > 0);
      } else {
        const d = (await get<BillingDoc>(`${apiBase(type)}/${id}`)).data;
        setDoc(d); setPre(null); setForm(formFromDoc(d).items.length ? formFromDoc(d) : { ...formFromDoc(d), items: [emptyItem()] }); setNotesDraft(null);
        refreshSummary(); // keeps the sidebar's payment follow-up badge in step with payments / dates changed here
      }
      setDirty(false);
    } catch (e) { setLoadErr(errMsg(e)); }
  }, [isNew, leadParam, id, type, refreshSummary, canEdit]);
  useEffect(() => { setDoc(null); setForm(null); void load(); }, [load]);
  useEffect(() => { get<Preset[]>('/billing/presets').then((r) => setPresets(r.data)).catch(() => {}); }, []);

  const editable = canEdit && (isNew || doc?.status === 'draft');
  useEffect(() => { // browsers warn before discarding unsaved edits
    if (!dirty) return undefined;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // Live totals come from the server (single source of truth for the maths), debounced while typing.
  useEffect(() => {
    if (!form || !editable) return undefined;
    const t = setTimeout(() => {
      api<Calc>('POST', `${apiBase(type)}/calculate`, { items: form.items.map(itemPayload), additional_charges: form.additional_charges || null, currency: form.currency }).then((r) => setCalc(r.data)).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [form?.items, form?.additional_charges, form?.currency, editable, type]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => (f ? { ...f, [k]: v } : f)); setDirty(true); };
  const setClient = (k: ClientKey, v: string) => { setForm((f) => (f ? { ...f, client: { ...f.client, [k]: v } } : f)); setDirty(true); };
  const setItem = (key: string, patchItem: Partial<FormItem>) => { setForm((f) => (f ? { ...f, items: f.items.map((i) => (i.key === key ? { ...i, ...patchItem } : i)) } : f)); setDirty(true); };

  const save = useCallback(async (): Promise<BillingDoc | null> => {
    if (!form) return null;
    setBusy('save'); setErr('');
    try {
      let d: BillingDoc;
      if (isNew) {
        d = (await api<BillingDoc>('POST', apiBase(type), { ...buildPayload(form), lead_id: leadParam }, { 'Idempotency-Key': idemKey.current })).data;
        setDirty(false); nav(`${routeBase(type)}/${d.id}`, { replace: true });
      } else {
        d = (await api<BillingDoc>('PUT', `${apiBase(type)}/${id}`, buildPayload(form))).data;
        setDoc(d); setDirty(false);
      }
      return d;
    } catch (e) { setErr(errMsg(e)); return null; } finally { setBusy(''); }
  }, [form, isNew, type, leadParam, id, nav]);

  const viewPdf = async () => {
    const w = window.open('', '_blank'); // opened first so the popup blocker allows it
    const d = editable ? await save() : doc;
    if (!d) { w?.close(); return; }
    if (w) w.location.href = `/api${apiBase(type)}/${d.id}/pdf`;
  };
  const startIssue = async () => { const d = await save(); if (d) { setDoc(d); setModal('issue'); } };
  const run = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setErr(''); try { await fn(); await load(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(''); } };

  // ---------- preview data ----------
  const preview: PreviewData | null = useMemo(() => {
    if (!form) return null;
    if (!editable && doc) {
      return { type, number: doc.doc_number, showBalance: inv && doc.status !== 'draft' && doc.status !== 'cancelled', currency: doc.currency, issuer: doc.issuer, client: doc.client, reference: doc.lead.lead_code,
        issue_date: doc.issue_date, due_date: doc.due_date, po_number: doc.po_number, place_of_supply: doc.place_of_supply, items: doc.items, words: doc.amount_in_words,
        totals: { subtotal: doc.subtotal, discount_total: doc.discount_total, taxable_amount: doc.taxable_amount, tax_amount: doc.tax_amount, additional_charges: doc.additional_charges, additional_charges_label: doc.additional_charges_label, total: doc.total, amount_paid: doc.amount_paid, outstanding: doc.outstanding },
        payment_terms: doc.payment_terms, client_notes: doc.client_notes };
    }
    const issuer = doc?.issuer ?? pre?.issuer; if (!issuer) return null;
    const lines = form.items.filter((i) => !blankItem(i));
    const idx = form.items.filter((i) => !blankItem(i)).map((i) => form.items.indexOf(i));
    return { type, number: doc?.doc_number ?? null, currency: form.currency, issuer, client: form.client, reference: doc?.lead.lead_code ?? pre?.lead.lead_code ?? null,
      issue_date: form.issue_date, due_date: form.due_date || null, po_number: form.po_number, place_of_supply: form.place_of_supply,
      items: lines.map((i, n) => { const c = calc?.items[idx[n]]; return { name: i.name, description: i.description, quantity: i.quantity, unit_price: i.unit_price || '0', discount_type: i.discount_type, discount_value: i.discount_value, discount_amount: c?.discount_amount ?? '0', tax_rate: i.tax_rate || null, tax_amount: c?.tax_amount ?? '0', taxable_amount: c?.taxable_amount ?? '0' }; }),
      words: calc?.amount_in_words, totals: { ...(calc?.totals ?? { subtotal: '0', discount_total: '0', taxable_amount: '0', tax_amount: '0', additional_charges: '0', total: '0' }), additional_charges_label: form.additional_charges_label },
      payment_terms: form.payment_terms, client_notes: form.client_notes };
  }, [form, calc, doc, pre, editable, type]);

  if (loadErr) return <div className="p-6"><ErrorState message={loadErr} onRetry={load} /><p className="text-center"><Link className="btn btn-ghost" to={routeBase(type)}>← Back to {docLabelPlural(type).toLowerCase()}</Link></p></div>;
  if (!form || !preview) return <Spinner />;

  const issuer = (doc?.issuer ?? pre?.issuer)!; const lead = doc?.lead ?? pre?.lead;
  const goBack = () => { if ((window.history.state?.idx ?? 0) > 0) nav(-1); else nav(lead ? `/leads?lead=${lead.id}` : routeBase(type)); };
  const ref: DocRef | null = doc ? { id: doc.id, type, doc_number: doc.doc_number, total: doc.total, outstanding: doc.outstanding, currency: doc.currency } : null;
  const live = doc && !['draft', 'cancelled'].includes(doc.status);
  const canPay = inv && canEdit && doc && ['issued', 'partially_paid'].includes(doc.status);
  const canCancel = doc && doc.status !== 'cancelled' && !(doc.status === 'converted') && (doc.status === 'draft' || canEdit);
  const total = calc?.totals.total ?? doc?.total ?? '0.00';
  // Statuses an invoice can be moved to: payment-driven ones go through the payment form so the books always add up.
  const statusOptions: StatusOption[] = (() => {
    if (!doc || doc.status === 'draft') return [];
    const out: StatusOption[] = [];
    if (inv && canEdit && canPay) {
      out.push({ key: 'partially_paid', label: 'Partially paid', hint: 'Add a payment for part of the balance', onPick: () => setModal('payment') });
      out.push({ key: 'paid', label: 'Paid', hint: 'Record the full balance as received', onPick: () => setModal('markpaid') });
    }
    if (!inv && canEdit && ['issued', 'accepted', 'rejected'].includes(doc.status)) {
      for (const [k, label, hint] of [['issued', 'Issued', 'Sent, waiting for the client'], ['accepted', 'Accepted', 'The client agreed'], ['rejected', 'Rejected', 'The client declined']] as const) {
        out.push({ key: k, label, hint: doc.status === k ? 'Current status' : hint, disabled: doc.status === k, onPick: () => void run('status', () => post(`/quotations/${doc.id}/status`, { status: k })) });
      }
    }
    if (canCancel) out.push({ key: 'cancelled', label: 'Cancelled', hint: 'Keeps the record; the number is never reused', tone: 'danger', onPick: () => setModal('cancel') });
    return out;
  })();
  const input = (k: ClientKey, ph = '') => <input className="input" value={form.client[k]} onChange={(e) => setClient(k, e.target.value)} placeholder={ph} maxLength={k === 'address' ? 1000 : 255} />;

  return (
    <div className="flex h-full flex-col">
      {/* top bar */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-2.5 sm:px-5">
        <div className={`mx-auto flex ${editable ? 'max-w-5xl' : 'max-w-6xl'} flex-wrap items-center gap-2`}>
          {/* Back goes to wherever you came from (usually the lead); the lead page is the fallback for direct links */}
          <button onClick={goBack} className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100" aria-label="Back">← Back</button>
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-slate-900">{doc ? doc.doc_number : `New ${docLabel(type).toLowerCase()}`}</p>
            {!doc && pre?.expected_number && <p className="text-[11px] text-slate-500">Number assigned when you save — expected {pre.expected_number}</p>}
          </div>
          {doc && (doc.status === 'draft' ? <StatusBadge status={doc.status} overdue={doc.is_overdue} expired={doc.is_expired} /> : <StatusMenu doc={doc} options={statusOptions} busy={!!busy} />)}
          {lead && <Link to={`/leads?lead=${lead.id}`} className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-brand-700 hover:bg-brand-50" title="Open the lead">Lead {lead.lead_code}</Link>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {editable && <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 text-xs font-semibold">
              {(['edit', 'preview'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 capitalize ${tab === t ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{t}</button>)}
            </div>}
            {doc && <a className="btn btn-ghost !py-1.5 text-xs" href={`/api${apiBase(type)}/${doc.id}/pdf?download=1`}>⬇ PDF</a>}
            {doc && <button className="btn btn-ghost !py-1.5 text-xs" onClick={viewPdf}>View PDF</button>}
            {doc && doc.status !== 'draft' && canEdit && <button className="btn btn-ghost !py-1.5 text-xs" disabled={!!busy} title={`Make an editable copy of this ${docLabel(type).toLowerCase()} (the original stays as it is)`} onClick={async () => { setBusy('dup'); setErr(''); try { const r = await post<BillingDoc>(`${apiBase(type)}/${doc.id}/duplicate`); nav(`${routeBase(type)}/${r.data.id}`); } catch (e) { setErr(errMsg(e)); setBusy(''); } }}>⧉ Duplicate</button>}
            {live && <button className="btn btn-ghost !py-1.5 text-xs" onClick={() => setModal('email')}>✉ Email</button>}
            {live && <button className="btn btn-ghost !py-1.5 text-xs text-green-700" onClick={() => setModal('whatsapp')}>💬 WhatsApp</button>}
            {canPay && <button className="btn btn-primary !py-1.5 text-xs" onClick={() => setModal('payment')}>Add payment</button>}
            {doc && canEdit && type === 'quotation' && ['issued', 'accepted'].includes(doc.status) && !doc.converted_invoice && <button className="btn btn-primary !py-1.5 text-xs" disabled={!!busy} onClick={async () => { setBusy('convert'); setErr(''); try { const r = await post<BillingDoc>(`/quotations/${doc.id}/convert`); nav(`/invoices/${r.data.id}`); } catch (e) { setErr(errMsg(e)); setBusy(''); } }}>Convert to invoice</button>}
          </div>
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto ${editable ? 'max-w-5xl' : 'max-w-6xl'} space-y-4 px-3 py-4 sm:px-5`}>
          {err && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{err}</div>}
          {pre?.error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{pre.error}</div>}
          {lead?.removed && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">This lead has been removed.</div>}
          {doc?.status === 'cancelled' && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"><b>Cancelled</b>{doc.cancelled_at && ` on ${fmtDay(doc.cancelled_at.slice(0, 10))}`}: {doc.cancel_reason}</div>}
          {doc?.source_quotation && <p className="text-sm text-slate-600">Created from quotation <Link className="font-semibold text-brand-700 hover:underline" to={`/quotations/${doc.source_quotation.id}`}>{doc.source_quotation.doc_number}</Link></p>}
          {doc?.converted_invoice && <p className="text-sm text-slate-600">Converted to invoice <Link className="font-semibold text-brand-700 hover:underline" to={`/invoices/${doc.converted_invoice.id}`}>{doc.converted_invoice.doc_number}</Link></p>}

          {editable && tab === 'edit' && <>
            <Card title="1 · Client details" hint="Prefilled from the lead. Everything is optional and editable — changes here never alter the lead.">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Client / company name">{input('company_name')}</Field><Field label="Contact person">{input('contact_name')}</Field>
                <Field label="Email">{input('email')}</Field><Field label="Phone">{input('phone')}</Field>
                <Field label="Alternate phone">{input('alt_phone')}</Field><Field label="Website">{input('website')}</Field>
                <Field label="Billing address" span><textarea className="input min-h-[72px]" maxLength={1000} value={form.client.address} onChange={(e) => setClient('address', e.target.value)} /></Field>
                <Field label="City">{input('city')}</Field><Field label="State">{input('state')}</Field>
                <Field label="Postal / ZIP code">{input('postal_code')}</Field><Field label="Country">{input('country')}</Field>
                <Field label="GSTIN">{input('gstin')}</Field><Field label="PAN">{input('pan')}</Field>
                <Field label="Additional details (shown on the document)" span><textarea className="input min-h-[64px]" maxLength={3000} value={form.client.additional_details} onChange={(e) => setClient('additional_details', e.target.value)} /></Field>
                <Field label="Client notes (internal — not shown on the PDF)" span><textarea className="input min-h-[56px]" maxLength={3000} value={form.client.notes} onChange={(e) => setClient('notes', e.target.value)} /></Field>
              </div>
            </Card>

            <Card title="2 · Issuer" hint="Fixed company details — not editable. Saved onto each document when the draft is created." right={<span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">🔒 Locked</span>}>
              <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div className="sm:col-span-2"><p className="font-bold text-slate-900">{issuer.company_name}</p><p className="text-xs text-slate-500">CIN: {issuer.cin}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{issuer.office.label}</p><p className="text-slate-700">{issuer.office.lines.join(', ')}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{issuer.headquarters.label}</p><p className="text-slate-700">{issuer.headquarters.lines.join(', ')}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Phone</p><p className="text-slate-700">{issuer.phone}</p></div>
                <div><p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Website</p><a className="break-all text-blue-600 underline underline-offset-2" href={issuer.website} target="_blank" rel="noopener noreferrer">{issuer.website}</a></div>
              </div>
            </Card>

            <Card title={`3 · ${docLabel(type)} information`}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={`${docLabel(type)} number`}><input className="input bg-slate-50 font-mono text-xs" readOnly value={doc?.doc_number ?? pre?.expected_number ?? ''} placeholder="Assigned on save" title="Generated by the system" /></Field>
                <Field label={inv ? 'Invoice date' : 'Quotation date'}><input type="date" className="input" value={form.issue_date} onChange={(e) => set('issue_date', e.target.value)} /></Field>
                <Field label={inv ? 'Due date (optional)' : 'Valid until (optional)'}><input type="date" className="input" min={form.issue_date} value={form.due_date} onChange={(e) => set('due_date', e.target.value)} /></Field>
                <Field label="Currency"><select className="input" value={form.currency} onChange={(e) => set('currency', e.target.value)}>{['INR', 'USD', 'EUR', 'GBP', 'AED'].map((c) => <option key={c}>{c}</option>)}</select></Field>
                <Field label="Purchase order no. (optional)"><input className="input" maxLength={100} value={form.po_number} onChange={(e) => set('po_number', e.target.value)} /></Field>
                <Field label="Place of supply (optional)"><input className="input" maxLength={150} value={form.place_of_supply} onChange={(e) => set('place_of_supply', e.target.value)} /></Field>
                <Field label="Payment terms (optional)" span><input className="input" maxLength={500} value={form.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} placeholder="e.g. 50% advance, balance on delivery" /></Field>
                <Field label="Reference lead"><p className="input flex items-center bg-slate-50 text-sm">{lead && <Link className="font-mono text-xs font-semibold text-brand-700 hover:underline" to={`/leads?lead=${lead.id}`}>{lead.lead_code}</Link>} <span className="ml-2 truncate text-slate-500">{lead?.nickname}</span></p></Field>
              </div>
            </Card>

            <Card title="4 · Services & pricing" hint="Type anything — there is no fixed service list. Discount and tax are optional per line."
              right={<div className="flex items-center gap-1.5"><input className="input !h-8 !w-16 !py-0 text-xs" inputMode="decimal" placeholder="Tax %" value={taxAll} onChange={(e) => setTaxAll(e.target.value)} aria-label="Tax rate to apply to all lines" /><button className="btn btn-ghost !px-2 !py-1 text-xs" disabled={!taxAll.trim()} onClick={() => { setForm((f) => (f ? { ...f, items: f.items.map((i) => ({ ...i, tax_rate: taxAll.trim() })) } : f)); setDirty(true); }}>Apply to all</button></div>}>
              <div className="space-y-3">
                {form.items.map((it, n) => {
                  const c = calc?.items[n]; const started = !blankItem(it);
                  return (
                    <div key={it.key} className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                      <div className="mb-2 flex items-center justify-between"><span className="text-xs font-bold text-slate-400">ITEM {n + 1}</span>
                        <button className="rounded px-2 py-0.5 text-xs font-medium text-red-500 hover:bg-red-50" onClick={() => { setForm((f) => (f ? { ...f, items: f.items.length > 1 ? f.items.filter((x) => x.key !== it.key) : [emptyItem()] } : f)); setDirty(true); }} aria-label={`Remove item ${n + 1}`}>Remove</button></div>
                      <div className="grid gap-2">
                        <input className="input bg-white" placeholder="Service or product name" maxLength={255} value={it.name} onChange={(e) => setItem(it.key, { name: e.target.value })} aria-label={`Item ${n + 1} name`} />
                        <textarea className="input min-h-[52px] bg-white" placeholder="Description (optional)" maxLength={3000} value={it.description} onChange={(e) => setItem(it.key, { description: e.target.value })} aria-label={`Item ${n + 1} description`} />
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                          <div><label className="label">Qty</label><input className="input bg-white" inputMode="decimal" value={it.quantity} onChange={(e) => setItem(it.key, { quantity: e.target.value })} aria-label={`Item ${n + 1} quantity`} /></div>
                          <div><label className="label">Unit price</label><input className="input bg-white" inputMode="decimal" placeholder="0.00" value={it.unit_price} onChange={(e) => setItem(it.key, { unit_price: e.target.value })} aria-label={`Item ${n + 1} unit price`} /></div>
                          <div className="sm:col-span-2"><label className="label">Discount</label>
                            <div className="flex gap-1.5"><select className="input !w-[5.5rem] bg-white" value={it.discount_type} onChange={(e) => setItem(it.key, { discount_type: e.target.value as FormItem['discount_type'] })} aria-label={`Item ${n + 1} discount type`}><option value="none">None</option><option value="percent">%</option><option value="amount">Amount</option></select>
                              <input className="input bg-white" inputMode="decimal" disabled={it.discount_type === 'none'} placeholder={it.discount_type === 'percent' ? '10' : '500'} value={it.discount_value} onChange={(e) => setItem(it.key, { discount_value: e.target.value })} aria-label={`Item ${n + 1} discount value`} /></div></div>
                          <div><label className="label">Tax % (optional)</label><input className="input bg-white" inputMode="decimal" placeholder="—" value={it.tax_rate} onChange={(e) => setItem(it.key, { tax_rate: e.target.value })} aria-label={`Item ${n + 1} tax rate`} /></div>
                          <div><label className="label">Line total</label><p className="flex h-[34px] items-center justify-end rounded-lg bg-slate-100 px-2 text-sm font-bold tabular-nums text-slate-900">{started && c && !c.error ? money(c.line_total, form.currency) : '—'}</p></div>
                        </div>
                        {started && c?.error && <p className="text-xs text-red-600" role="alert">{c.error}</p>}
                      </div>
                    </div>
                  );
                })}
                <button className="btn btn-ghost w-full border-dashed" onClick={() => { setForm((f) => (f ? { ...f, items: [...f.items, emptyItem()] } : f)); setDirty(true); }} disabled={form.items.length >= 200}>＋ Add line item</button>
                {presets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5" aria-label="Quick add services">
                    <span className="text-xs font-semibold text-slate-500">Quick add:</span>
                    {presets.map((p) => (
                      <button key={p.id} type="button" className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:border-brand-500 hover:text-brand-700"
                        onClick={() => { setForm((f) => (f ? { ...f, items: [...f.items.filter((i) => !blankItem(i)), { ...emptyItem(), name: p.name, description: s(p.description), unit_price: p.unit_price, tax_rate: s(p.tax_rate), discount_type: p.discount_type ?? 'none', discount_value: s(p.discount_value) }] } : f)); setDirty(true); }}>
                        ＋ {p.name} <span className="text-slate-400">· {money(p.unit_price, form.currency)}{p.discount_type === 'percent' && p.discount_value ? ` (${p.discount_value}% off)` : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Card>

            <Card title="5 · Tax & totals" hint="Tax is optional and never applied automatically — enter a rate on the lines that need it.">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-3">
                  <Field label="Additional charges label (optional)"><input className="input" maxLength={100} placeholder="e.g. Setup fee, Shipping" value={form.additional_charges_label} onChange={(e) => set('additional_charges_label', e.target.value)} /></Field>
                  <Field label="Additional charges amount (optional)"><input className="input" inputMode="decimal" placeholder="0.00" value={form.additional_charges} onChange={(e) => set('additional_charges', e.target.value)} /></Field>
                </div>
                <dl className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm">
                  {([['Subtotal', calc?.totals.subtotal], ['Discount', calc?.totals.discount_total], ['Taxable amount', calc?.totals.taxable_amount], ['Tax', calc?.totals.tax_amount], ['Additional charges', calc?.totals.additional_charges]] as const).map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-slate-500">{k}</dt><dd className="font-medium tabular-nums text-slate-900">{money(v ?? '0', form.currency)}</dd></div>)}
                  <div className="flex justify-between border-t border-slate-200 pt-2 text-base"><dt className="font-bold text-slate-900">Total</dt><dd className="font-black tabular-nums text-slate-900">{money(total, form.currency)}</dd></div>
                  {calc?.amount_in_words && <p className="pt-1 text-[11px] text-slate-500">{calc.amount_in_words}</p>}
                </dl>
              </div>
            </Card>

            {inv && <Card title="6 · Payment information"><p className="text-sm text-slate-600">Payments are recorded after the invoice is issued, from its details page. The outstanding balance and payment status are calculated automatically from those payments.</p></Card>}

            <Card title="7 · Notes">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Notes for the client (printed on the PDF)"><textarea className="input min-h-[96px]" maxLength={5000} value={form.client_notes} onChange={(e) => set('client_notes', e.target.value)} /></Field>
                <Field label="Internal notes (never shown to the client)"><textarea className="input min-h-[96px] bg-amber-50/40" maxLength={5000} value={form.internal_notes} onChange={(e) => set('internal_notes', e.target.value)} /></Field>
              </div>
            </Card>
          </>}

          {(tab === 'preview' || !editable) && (
            <>
            {!editable && inv && doc && (live || (doc.payments?.length ?? 0) > 0) && <div className="mb-4"><PaymentSummary doc={doc} canEdit={canEdit} tz={tz} onRecord={() => setModal('payment')} onChanged={load} /></div>}
            <div className={!editable ? 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]' : ''}>
              <DocumentPreview data={preview} />
              {!editable && doc && (
                <aside className="space-y-4">
                  <Card title="Summary">
                    <dl className="space-y-1.5 text-sm">
                      <div className="flex justify-between"><dt className="text-slate-500">Total</dt><dd className="font-bold tabular-nums">{money(doc.total, doc.currency)}</dd></div>
                      {inv && <><div className="flex justify-between"><dt className="text-slate-500">Paid</dt><dd className="font-semibold tabular-nums text-emerald-600">{money(doc.amount_paid, doc.currency)}</dd></div>
                        <div className="flex justify-between border-t border-slate-100 pt-1.5"><dt className="font-semibold text-slate-700">Balance due</dt><dd className="font-bold tabular-nums">{money(doc.outstanding, doc.currency)}</dd></div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, Number(doc.total) ? (Number(doc.amount_paid) / Number(doc.total)) * 100 : 0)}%` }} /></div></>}
                      <div className="flex justify-between pt-1 text-xs text-slate-500"><dt>Created</dt><dd>{fmtDay(doc.created_at.slice(0, 10))}{doc.created_by_name && ` · ${doc.created_by_name}`}</dd></div>
                      {doc.issued_at && <div className="flex justify-between text-xs text-slate-500"><dt>Issued</dt><dd>{fmtDay(doc.issued_at.slice(0, 10))}</dd></div>}
                    </dl>
                  </Card>
                  <Card title="Sent to client">
                    {!doc.emails?.length ? <p className="text-sm text-slate-500">Not sent yet.</p> : (
                      <ul className="space-y-2">{doc.emails.map((e) => (
                        <li key={e.id} className="text-sm"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium text-slate-800">{e.channel === 'whatsapp' ? '💬' : '✉'} {e.to_email}</span><span className={`rounded-full px-1.5 py-px text-[10px] font-bold uppercase ${e.status === 'failed' ? 'bg-red-50 text-red-700' : e.status === 'opened' ? 'bg-green-50 text-green-700' : 'bg-emerald-50 text-emerald-700'}`}>{e.status === 'opened' ? 'WhatsApp opened' : e.status}</span></div>
                          <p className="text-xs text-slate-500">{fmtDay(e.created_at.slice(0, 10))}{e.sent_by_name && ` · ${e.sent_by_name}`}</p>{e.error && <p className="text-xs text-red-600">{e.error}</p>}</li>))}</ul>)}
                  </Card>
                  <Card title="Internal notes" hint="Private. Never printed or emailed.">
                    <textarea className="input min-h-[80px] bg-amber-50/40" readOnly={!canEdit} value={notesDraft ?? s(doc.internal_notes)} onChange={(e) => setNotesDraft(e.target.value)} maxLength={5000} aria-label="Internal notes" />
                    {notesDraft !== null && notesDraft !== s(doc.internal_notes) && <div className="mt-2 flex justify-end"><button className="btn btn-primary !py-1 text-xs" onClick={() => run('notes', () => patch(`${apiBase(type)}/${doc.id}/internal-notes`, { internal_notes: notesDraft }))}>Save notes</button></div>}
                  </Card>
                </aside>
              )}
            </div>
            </>
          )}
        </div>
      </div>

      {editable && (
        <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-2.5 sm:px-5">
          <div className="mx-auto flex max-w-5xl items-center gap-2">
            <div className="mr-auto leading-tight"><p className="text-[11px] text-slate-500">Total{dirty && <span className="ml-1.5 font-semibold text-amber-600">· unsaved changes</span>}</p><p className="text-lg font-black tabular-nums text-slate-900">{money(total, form.currency)}</p></div>
            <button className="btn btn-ghost whitespace-nowrap !px-3 sm:!px-4" onClick={viewPdf} disabled={!!busy || !!pre?.error}><span className="sm:hidden">PDF</span><span className="hidden sm:inline">View PDF</span></button>
            <button className="btn btn-ghost whitespace-nowrap !px-3 sm:!px-4" onClick={save} disabled={!!busy || !!pre?.error}>{busy === 'save' ? 'Saving…' : <>Save<span className="hidden sm:inline">&nbsp;draft</span></>}</button>
            <button className="btn btn-primary whitespace-nowrap !px-3 sm:!px-4" onClick={startIssue} disabled={!!busy || !!pre?.error}>Issue<span className="hidden sm:inline">&nbsp;{docLabel(type).toLowerCase()}</span>…</button>
          </div>
        </div>
      )}

      {modal === 'issue' && ref && <IssueModal doc={ref} onClose={() => setModal(null)} onDone={load} />}
      {modal === 'cancel' && ref && <CancelModal doc={ref} onClose={() => setModal(null)} onDone={load} />}
      {(modal === 'payment' || modal === 'markpaid') && ref && <PaymentModal doc={ref} markPaid={modal === 'markpaid'} onClose={() => setModal(null)} onDone={load} />}
      {modal === 'whatsapp' && ref && <WhatsAppModal doc={ref} onClose={() => setModal(null)} onDone={load} />}
      {modal === 'email' && ref && <EmailModal doc={ref} onClose={() => setModal(null)} onDone={load} />}
    </div>
  );
}
