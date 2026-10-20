import type { ReactNode } from 'react';
import type { ClientInfo, DocType, Issuer } from '../../lib/types';
import { DOC_PAL, ICON_PATHS, INVOICE_TERMS, fmtDay, money } from '../../lib/billing';

export interface PreviewItem { name: string; description?: string | null; quantity: string; unit_price: string; discount_type: string; discount_value?: string | null; discount_amount: string; tax_rate?: string | null; tax_amount: string; taxable_amount: string }
export interface PreviewData {
  type: DocType; number: string | null; currency: string;
  issuer: Issuer; client: Partial<ClientInfo>; reference: string | null;
  issue_date: string; due_date: string | null; po_number?: string | null; place_of_supply?: string | null;
  items: PreviewItem[]; showBalance?: boolean;
  totals: { subtotal: string; discount_total: string; taxable_amount: string; tax_amount: string; additional_charges: string; additional_charges_label?: string | null; total: string; amount_paid?: string; outstanding?: string };
  words?: string | null; payment_terms?: string | null; client_notes?: string | null;
}

const has = (v: string | null | undefined) => !!v && v.trim() !== '';
const pos = (v: string | undefined | null) => Number(v ?? 0) > 0;
const asUrl = (u: string) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
const tel = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;
const A = ({ href, children }: { href: string; children: string }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 [overflow-wrap:anywhere] underline decoration-blue-300 underline-offset-2 hover:text-blue-700">{children}</a>;
const Icon = ({ name, color, size = 14 }: { name: keyof typeof ICON_PATHS; color: string; size?: number }) => <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className="mt-[2px] shrink-0" fill={color}><path d={ICON_PATHS[name]} /></svg>;
const Row = ({ icon, color, children }: { icon: keyof typeof ICON_PATHS; color: string; children: ReactNode }) => <div className="flex items-start gap-2 text-[13px] leading-snug text-slate-700"><Icon name={icon} color={color} /><div className="min-w-0 break-words">{children}</div></div>;
const SERVICES: [keyof typeof ICON_PATHS, string][] = [['code', 'Web Development'], ['cloud', 'Cloud Solutions'], ['growth', 'Digital Growth'], ['verified', 'Long Term Support']];

/** An on-screen twin of the PDF: same layout, wording and order. Documents never show a workflow status. */
export function DocumentPreview({ data: d }: { data: PreviewData }) {
  const P = DOC_PAL[d.type]; const inv = d.type === 'invoice'; const c = d.client; const m = (v: string) => money(v, d.currency); const iss = d.issuer;
  const label = inv ? 'Invoice' : 'Quotation';
  const [brand, ...rest] = iss.company_name.split(' ');
  const host = (() => { try { return new URL(iss.website).host; } catch { return iss.website; } })();
  const loc = [c.city, [c.state, c.postal_code].filter(has).join(' ')].filter(has).join(', ');
  const addr = [...(c.address ?? '').split(/\r?\n/).filter(has), [loc, c.country].filter(has).join(', ')].filter(has);
  const docLines = [...(has(c.gstin) ? [`GSTIN: ${c.gstin}`] : []), ...(has(c.pan) ? [`PAN: ${c.pan}`] : []), ...(c.additional_details ?? '').split(/\r?\n/).filter(has)];
  const facts: [string, string][] = ([
    [`${label} No.`, d.number ?? ''], ['Date', fmtDay(d.issue_date)], [inv ? 'Due date' : 'Valid until', d.due_date ? fmtDay(d.due_date) : ''],
    ['PO number', d.po_number ?? ''], ['Place of supply', d.place_of_supply ?? ''], ['Reference', d.reference ?? ''],
  ] as [string, string][]).filter(([, v]) => v);
  const t = d.totals;
  const hasDisc = d.items.some((i) => pos(i.discount_amount)); const hasTax = d.items.some((i) => has(i.tax_rate) && Number(i.tax_rate) > 0);
  const showPaid = inv && !!d.showBalance && pos(t.amount_paid);
  const hero = inv ? { label: 'Amount Due', value: d.showBalance ? (t.outstanding ?? t.total) : t.total } : { label: 'Estimated Total', value: t.total };
  const terms = [has(d.payment_terms) && `Payment terms: ${d.payment_terms}`, has(d.client_notes) && `Notes: ${d.client_notes}`, ...(inv ? INVOICE_TERMS : []), !inv && 'This quotation is an estimate and not a tax invoice.'].filter(Boolean) as string[];
  const cols = 4 + (hasDisc ? 1 : 0) + (hasTax ? 1 : 0);

  return (
    <div className="doc-sans relative overflow-hidden rounded-xl border border-slate-200 shadow-card" style={{ background: P.bg, fontFeatureSettings: "'tnum'" }}>
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-60 w-60 rounded-full" style={{ background: P.wave }} />
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 flex select-none items-center justify-center text-[7rem] font-black sm:text-[11rem]" style={{ color: P.accent, opacity: 0.035, transform: 'rotate(-30deg)' }}>Piweb</div>

      <div className="relative z-10 px-5 pb-6 pt-6 sm:px-9">
        {/* header: brand + contact */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3.5">
            <img src="/logo.png" alt="Piweb" className="h-16 w-auto shrink-0 sm:h-[4.5rem]" />
            <div className="min-w-0">
              <p className="text-3xl font-extrabold leading-none sm:text-4xl" style={{ color: P.navy }}>{brand}</p>
              <p className="mt-1 text-[13px] font-medium text-slate-600">{rest.join(' ')}</p>
              <p className="mt-0.5 text-[9px] tracking-[0.18em] text-slate-500">Build &nbsp;|&nbsp; Innovate &nbsp;|&nbsp; Grow</p>
              <p className="mt-0.5 text-[9px] text-slate-400">CIN {iss.cin}</p>
            </div>
          </div>
          <div className="space-y-1.5 border-slate-200 sm:border-l sm:pl-5">
            <Row icon="pin" color={P.accent}>{iss.office.lines.slice(-3).join(', ')}</Row>
            <Row icon="phone" color={P.accent}><A href={tel(iss.phone)}>{iss.phone}</A></Row>
            <Row icon="web" color={P.accent}><A href={iss.website}>{host}</A></Row>
          </div>
        </div>
        <hr className="my-5 border-slate-200" />

        {/* title, facts, amount card */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-4xl font-extrabold uppercase leading-none tracking-wide sm:text-[2.6rem]" style={{ color: P.navy }}>{label}</h2>
            <dl className="mt-3 space-y-0.5 text-sm">
              {facts.map(([k, v]) => <div key={k} className="flex gap-3"><dt className="w-24 shrink-0 text-slate-500">{k}</dt><dd className="font-bold text-slate-900">{v}</dd></div>)}
              {!d.number && <p className="text-xs text-slate-400">Number assigned when saved</p>}
            </dl>
          </div>
          <div className="rounded-xl border-l-4 px-5 py-3.5 sm:min-w-[15rem]" style={{ borderColor: P.accent, background: P.pale }}>
            <p className="text-sm font-bold" style={{ color: P.navy }}>{hero.label}</p>
            <p className="mt-1 text-right text-3xl font-extrabold tracking-tight" style={{ color: P.navy }}>{m(hero.value)}</p>
          </div>
        </div>
        <hr className="my-5 border-slate-200" />

        {/* bill to | from */}
        <div className="grid gap-5 sm:grid-cols-2 sm:gap-0">
          <div className="space-y-1.5 sm:pr-6">
            <p className="text-sm font-medium" style={{ color: P.accent }}>{inv ? 'Bill To' : 'Prepared For'}</p>
            {has(c.company_name) ? <p className="text-base font-extrabold text-slate-900">{c.company_name}</p> : null}
            {has(c.contact_name) && c.contact_name !== c.company_name && <Row icon="user" color={P.accent}>Attn: {c.contact_name}</Row>}
            {addr.length > 0 && <Row icon="pin" color={P.accent}>{addr.map((l, i) => <p key={i}>{l}</p>)}</Row>}
            {has(c.email) && <Row icon="mail" color={P.accent}><A href={`mailto:${c.email}`}>{c.email!}</A></Row>}
            {[c.phone, c.alt_phone].some(has) && <Row icon="phone" color={P.accent}><A href={tel((c.phone || c.alt_phone)!)}>{[c.phone, c.alt_phone].filter(has).join(' / ')}</A></Row>}
            {has(c.website) && <Row icon="web" color={P.accent}><A href={asUrl(c.website!)}>{c.website!}</A></Row>}
            {docLines.map((l, i) => <Row key={i} icon="doc" color={P.accent}><span className="text-slate-500">{l}</span></Row>)}
            {!has(c.company_name) && addr.length === 0 && !has(c.email) && <p className="text-sm text-slate-400">No client details entered</p>}
          </div>
          <div className="space-y-1.5 border-slate-200 sm:border-l sm:pl-6">
            <p className="text-sm font-medium" style={{ color: P.accent }}>From</p>
            <p className="text-base font-extrabold text-slate-900">{iss.company_name}</p>
            <div><p className="pl-6 text-[11px] text-slate-400">{iss.office.label}:</p><Row icon="pin" color={P.accent}>{iss.office.lines.join(', ')}</Row></div>
            <div><p className="pl-6 text-[11px] text-slate-400">{iss.headquarters.label}:</p><Row icon="pin" color={P.accent}>{iss.headquarters.lines.join(', ')}</Row></div>
            <Row icon="phone" color={P.accent}><A href={tel(iss.phone)}>{iss.phone}</A></Row>
            <Row icon="web" color={P.accent}><A href={iss.website}>{iss.website}</A></Row>
          </div>
        </div>

        {/* items */}
        <div className="mt-6 overflow-x-auto rounded-xl border border-slate-300/70 bg-white/70">
          <table className="w-full min-w-[30rem] text-[13px]">
            <thead>
              <tr className="text-xs font-medium text-white" style={{ background: P.navy }}>
                <th className="w-9 py-2.5 text-center font-medium">#</th><th className="py-2.5 pl-1 text-left font-medium">Description</th><th className="py-2.5 text-right font-medium">Qty</th><th className="py-2.5 text-right font-medium">Rate</th>
                {hasDisc && <th className="py-2.5 text-right font-medium">Discount</th>}{hasTax && <th className="py-2.5 text-right font-medium">Tax</th>}<th className="px-3 py-2.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {d.items.length === 0 && <tr><td colSpan={cols} className="py-10 text-center text-slate-400">No line items yet</td></tr>}
              {d.items.map((it, i) => (
                <tr key={i} className="align-top" style={{ borderTop: i ? '1px solid #e8edf4' : undefined }}>
                  <td className="py-3 text-center text-slate-500">{i + 1}</td>
                  <td className="max-w-[22rem] py-3 pl-1 pr-3"><p className="break-words font-bold text-slate-900">{it.name || <span className="font-normal text-slate-400">Untitled item</span>}</p>{it.description && <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-slate-500">{it.description}</p>}</td>
                  <td className="py-3 text-right text-slate-700">{it.quantity}</td><td className="py-3 text-right text-slate-700">{m(it.unit_price)}</td>
                  {hasDisc && <td className="py-3 text-right text-slate-700">{pos(it.discount_amount) ? <>{it.discount_type === 'percent' ? `${it.discount_value}%` : m(it.discount_value ?? '0')}<br /><span className="text-[11px] text-slate-500">− {m(it.discount_amount)}</span></> : <span className="text-slate-300">—</span>}</td>}
                  {hasTax && <td className="py-3 text-right text-slate-700">{it.tax_rate && Number(it.tax_rate) > 0 ? <>{it.tax_rate}%<br /><span className="text-[11px] text-slate-500">{m(it.tax_amount)}</span></> : <span className="text-slate-300">—</span>}</td>}
                  <td className="px-3 py-3 text-right font-bold text-slate-900">{m(it.taxable_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* payment details | totals */}
        <div className="mt-5 grid gap-6 sm:grid-cols-[1.05fr_1fr]">
          {iss.bank ? (
            <div className="rounded-xl p-4" style={{ background: P.pale }}>
              <div className="flex items-center gap-2"><Icon name="card" color={P.accent} size={20} /><p className="text-[15px] font-bold" style={{ color: P.navy }}>Payment Details</p></div>
              <dl className="mt-3 space-y-1.5 text-[13px]">
                {([['Account name', iss.bank.account_name, ''], ['Account number', iss.bank.account_number, 'tracking-[0.06em] text-[14px]'], ['IFSC code', iss.bank.ifsc.toUpperCase(), 'tracking-[0.06em]']] as const).map(([k, v, cls]) => (
                  <div key={k} className="grid grid-cols-[6.6rem_auto_1fr] items-baseline gap-1.5"><dt className="text-slate-500">{k}</dt><span className="text-slate-500">:</span><dd className={`break-words font-bold text-slate-900 ${cls}`}>{v}</dd></div>
                ))}
              </dl>
            </div>
          ) : <div />}
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between text-slate-500"><span>Subtotal</span><span className="font-semibold text-slate-900">{m(t.subtotal)}</span></div>
            {pos(t.discount_total) && <div className="flex justify-between text-slate-500"><span>Discount</span><span className="font-semibold text-slate-900">− {m(t.discount_total)}</span></div>}
            {(pos(t.discount_total) || pos(t.tax_amount)) && <div className="flex justify-between text-slate-500"><span>Taxable amount</span><span className="font-semibold text-slate-900">{m(t.taxable_amount)}</span></div>}
            {pos(t.tax_amount) && <div className="flex justify-between text-slate-500"><span>Tax</span><span className="font-semibold text-slate-900">{m(t.tax_amount)}</span></div>}
            {pos(t.additional_charges) && <div className="flex justify-between text-slate-500"><span>{t.additional_charges_label || 'Additional charges'}</span><span className="font-semibold text-slate-900">{m(t.additional_charges)}</span></div>}
            <div className="flex items-baseline justify-between rounded-xl px-4 py-3" style={{ background: P.pale, color: P.navy }}><span className="text-base font-extrabold">{inv ? 'Total' : 'Estimated total'}</span><span className="text-2xl font-extrabold">{m(t.total)}</span></div>
            {showPaid && <>
              <div className="flex justify-between pt-1 text-slate-500"><span>Amount paid</span><span className="font-semibold text-green-700">{m(t.amount_paid ?? '0')}</span></div>
              <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold text-slate-900"><span>Balance due</span><span className="text-base">{m(t.outstanding ?? t.total)}</span></div>
            </>}
            {d.words && <p className="pt-1 text-xs text-slate-500">Amount in words<br /><span className="text-[13px] font-bold text-slate-700">{d.words}</span></p>}
          </div>
        </div>
        <hr className="my-5 border-slate-200" />

        {/* terms | thank you | signatory */}
        <div className="grid items-end gap-5 sm:grid-cols-[1.3fr_0.8fr_0.9fr]">
          <div>
            <p className="text-[13px] font-bold" style={{ color: P.navy }}>Terms &amp; Conditions</p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-slate-500">{terms.map((x, i) => <li key={i} className="flex gap-2"><span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" /><span className="whitespace-pre-wrap break-words">{x}</span></li>)}</ul>
          </div>
          <div className="text-center"><p className="doc-serif -rotate-3 text-2xl" style={{ color: P.accent }}>Thank You!</p><p className="mt-1 text-[11px] text-slate-500">{inv ? 'Thank you for your business.' : 'Thank you for the opportunity to work with you.'}</p></div>
          <div className="text-right text-[11px] text-slate-500"><p className="doc-serif text-[13px] text-slate-900">For {iss.company_name}</p>{inv && <img src="/signature.png" alt="Signature" className="ml-auto mt-1 h-12 w-auto" />}<div className={`${inv ? 'mt-1' : 'mt-9'} border-t border-slate-300 pt-1.5 font-bold`}>Authorised Signatory</div></div>
        </div>
      </div>

      {/* services footer */}
      <div className="relative z-10 grid grid-cols-2 gap-y-2 px-5 py-4 text-white sm:grid-cols-4 sm:px-9" style={{ background: `linear-gradient(100deg, ${P.navy} 0%, ${P.navy} 55%, ${P.foot2} 100%)`, borderTopLeftRadius: '55% 14px', borderTopRightRadius: '45% 6px' }}>
        {SERVICES.map(([ic, text], i) => <div key={text} className={`flex items-center gap-2 text-xs ${i ? 'sm:border-l sm:border-white/25 sm:pl-3' : ''}`}><Icon name={ic} color="#ffffff" size={16} /><span>{text}</span></div>)}
      </div>
    </div>
  );
}
