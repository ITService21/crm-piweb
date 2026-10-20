import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { formatMoney, amountInWordsINR, toMinor } from '../lib/money.js';
import { ISSUER, INVOICE_TERMS, QUOTATION_TERMS } from '../config/issuer.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
const FONT_DIR = path.join(ASSETS, 'fonts'); const LOGO = path.join(ASSETS, 'logo.png'); const SIGNATURE = path.join(ASSETS, 'signature.png'); const SIG_RATIO = 867 / 573; const LOGO_RATIO = 357 / 406; // width / height
/** D = display serif (brand name, title, totals label); R/M/S/B/X = body regular/medium/semibold/bold/extra-bold. */
const FONTS = { D: 'PlayfairDisplay_700Bold.ttf', R: 'PlusJakartaSans_400Regular.ttf', M: 'PlusJakartaSans_500Medium.ttf', S: 'PlusJakartaSans_600SemiBold.ttf', B: 'PlusJakartaSans_700Bold.ttf', X: 'PlusJakartaSans_800ExtraBold.ttf' };
const W = 595.28; const H = 841.89; const L = 48; const R = W - 48; const CW = R - L;
const FOOTER_H = 66; const LIMIT = H - FOOTER_H - 6; // content must stay above the footer wave

const INK = '#0f172a'; const BODY = '#334155'; const MUTED = '#64748b'; const FAINT = '#94a3b8'; const LINE = '#e2e8f0'; const LINK = '#2563eb';
// Per-document palettes: invoice = navy / blue, quotation = deep teal / green
const PAL = {
  invoice: { navy: '#14315c', accent: '#2f6fe4', pale: '#eaf1fb', bg: '#f7faff', wave: '#dde9f8', foot2: '#2b5aa0' },
  quotation: { navy: '#0d3b3a', accent: '#0d9488', pale: '#e2f5f1', bg: '#f4fbf9', wave: '#d0eee7', foot2: '#17766f' },
};
// Material-style 24x24 icon outlines, drawn as vectors
const ICONS = {
  pin: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
  mail: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
  phone: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
  web: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z',
  user: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  doc: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  card: 'M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z',
  code: 'M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
  cloud: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z',
  growth: 'M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z',
  verified: 'M23 12l-2.44-2.78.34-3.68-3.61-.82-1.89-3.18L12 3 8.6 1.54 6.71 4.72l-3.61.81.34 3.68L1 12l2.44 2.78-.34 3.69 3.61.82 1.89 3.18L12 21l3.4 1.46 1.89-3.18 3.61-.82-.34-3.68L23 12zm-12.91 4.72l-3.8-3.81 1.48-1.48 2.32 2.33 5.85-5.87 1.48 1.48-7.33 7.35z',
};
const SERVICES = [['code', 'Web Development'], ['cloud', 'Cloud Solutions'], ['growth', 'Digital Growth'], ['verified', 'Long Term Support']];
const TITLE = { invoice: 'INVOICE', quotation: 'QUOTATION' };
const BRAND = 'Piweb';

const minor = (s) => toMinor(s ?? '0', 'Amount', { allowNegative: true });
const fmtDate = (s) => (s ? DateTime.fromISO(s).toFormat('dd LLL yyyy') : '');
const lines = (s) => (s ? String(s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : []);
const asUrl = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);

/**
 * The exact, ordered facts that go on the page. Kept separate from drawing so it can be unit-tested.
 * Documents never show a workflow status (draft/issued/paid…): that lives in the CRM, not on the client's copy.
 */
export function pdfModel(d) {
  const c = d.client; const money = (s) => formatMoney(minor(s), d.currency);
  const loc = [c.city, [c.state, c.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const billed = [
    c.company_name && { text: c.company_name, strong: true, kind: 'name' },
    c.contact_name && c.contact_name !== c.company_name && { text: `Attn: ${c.contact_name}`, kind: 'attn' },
    ...[...lines(c.address), [loc, c.country].filter(Boolean).join(', ')].filter(Boolean).map((t) => ({ text: t, kind: 'addr' })),
    c.email && { text: c.email, link: `mailto:${c.email}`, label: 'Email', kind: 'email' },
    [c.phone, c.alt_phone].filter(Boolean).length && { text: [c.phone, c.alt_phone].filter(Boolean).join(' / '), label: 'Phone', kind: 'phone', link: `tel:${String(c.phone || c.alt_phone).replace(/[^\d+]/g, '')}` },
    c.website && { text: c.website, link: asUrl(c.website), label: 'Web', kind: 'web' }, c.gstin && { text: `GSTIN: ${c.gstin}`, kind: 'doc' }, c.pan && { text: `PAN: ${c.pan}`, kind: 'doc' },
    ...lines(c.additional_details).map((t) => ({ text: t, muted: true, kind: 'doc' })),
  ].filter(Boolean);
  const inv = d.type === 'invoice';
  const meta = [
    [inv ? 'Invoice date' : 'Quotation date', fmtDate(d.issue_date)],
    [inv ? 'Due date' : 'Valid until', fmtDate(d.due_date)],
    d.po_number && ['PO number', d.po_number], d.place_of_supply && ['Place of supply', d.place_of_supply], ['Reference', d.lead.lead_code],
  ].filter((r) => r && r[1]);
  const showBalance = inv && d.status !== 'draft' && d.status !== 'cancelled';
  const showPaid = showBalance && minor(d.amount_paid) > 0;
  const totals = [
    ['Subtotal', money(d.subtotal)],
    minor(d.discount_total) > 0 && ['Discount', `− ${money(d.discount_total)}`],
    (minor(d.discount_total) > 0 || minor(d.tax_amount) > 0) && ['Taxable amount', money(d.taxable_amount)],
    minor(d.tax_amount) > 0 && ['Tax', money(d.tax_amount)],
    minor(d.additional_charges) > 0 && [d.additional_charges_label || 'Additional charges', money(d.additional_charges)],
  ].filter(Boolean);
  const iss = d.issuer;
  const bank = iss.bank ?? ISSUER.bank; // documents created before bank details existed still show the current ones
  const heroLabel = inv ? 'Amount Due' : 'Estimated Total';
  const heroValue = inv && showBalance ? money(d.outstanding) : money(d.total);
  const heroSub = null; // dates live in the facts row; no repeats
  return {
    title: TITLE[d.type], number: d.doc_number, issuer: iss,
    bank: bank ? [['Account name', bank.account_name], ['Account number', bank.account_number], ['IFSC code', String(bank.ifsc).toUpperCase()]] : null,
    hero: { label: heroLabel, value: heroValue, sub: heroSub },
    thanks: inv ? 'Thank you for your business.' : 'Thank you for the opportunity to work with you.',
    // Office Address first, then Headquarters
    addresses: [{ label: iss.office.label, text: iss.office.lines.join(', ') }, { label: iss.headquarters.label, text: iss.headquarters.lines.join(', ') }],
    billedLabel: inv ? 'Bill To' : 'Prepared For', billed, meta, totals, grandLabel: inv ? 'Total' : 'Estimated total', grand: money(d.total),
    paid: showPaid ? money(d.amount_paid) : null, balance: showPaid ? money(d.outstanding) : null,
    words: d.currency === 'INR' ? amountInWordsINR(minor(d.total)) : null,
    rows: d.items.map((i, n) => ({
      no: n + 1, name: i.name, description: i.description, qty: i.quantity, rate: money(i.unit_price),
      discount: minor(i.discount_amount) > 0 ? { main: i.discount_type === 'percent' ? `${i.discount_value}%` : money(i.discount_value), sub: `− ${money(i.discount_amount)}` } : null,
      tax: i.tax_rate !== null && Number(i.tax_rate) > 0 ? { main: `${i.tax_rate}%`, sub: money(i.tax_amount) } : null, amount: money(i.taxable_amount),
    })),
    paymentTerms: d.payment_terms, notes: d.client_notes,
    footnote: inv ? null : 'This quotation is an estimate and not a tax invoice.',
    noTax: minor(d.tax_amount) === 0 && !d.items.some((i) => i.tax_rate !== null && Number(i.tax_rate) > 0),
    watermark: BRAND,
  };
}

export function renderPdf(d) {
  const m = pdfModel(d); const P = PAL[d.type]; const iss = m.issuer; const inv = d.type === 'invoice';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: L, right: 48, bottom: 0 }, bufferPages: true, info: { Title: `${m.title} ${m.number}`, Author: iss.company_name, Subject: `${m.title} for ${d.client.company_name || d.client.contact_name || d.lead.lead_code}` } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    for (const [k, file] of Object.entries(FONTS)) doc.registerFont(k, path.join(FONT_DIR, file));
    const h = (str, font, size, width, opts = {}) => { doc.font(font).fontSize(size); return doc.heightOfString(str, { width, ...opts }); };
    let dry = false; // measuring pass: same layout maths, nothing drawn
    const put = (str, font, size, x, y, width, color = INK, opts = {}) => { if (!dry) doc.font(font).fontSize(size).fillColor(color).text(str, x, y, { width, ...opts }); return y + h(str, font, size, width, opts); };
    const link = (str, url, font, size, x, y, width, opts = {}) => put(str, font, size, x, y, width, LINK, { link: url, underline: true, ...opts });
    const fitSize = (str, font, max, start) => { let sz = start; doc.font(font); while (sz > 6 && doc.fontSize(sz).widthOfString(str) > max) sz -= 0.2; return sz; };
    const hair = (y, color = LINE, w = 0.8, x1 = L, x2 = R) => { if (!dry) doc.moveTo(x1, y).lineTo(x2, y).strokeColor(color).lineWidth(w).stroke(); };
    const icon = (name, x, y, size, color) => { if (dry) return; doc.save(); doc.translate(x, y); doc.scale(size / 24); doc.path(ICONS[name]).fill(color); doc.restore(); };
    const logo = (x, y, hgt) => doc.image(LOGO, x, y, { height: hgt });
    const titleCase = m.title.charAt(0) + m.title.slice(1).toLowerCase();

    // light page, soft corner wave, and a faint brand mark (drawn the moment a page is created, so it can never smudge text)
    const background = () => {
      doc.save(); doc.rect(0, 0, W, H).fill(P.bg);
      doc.moveTo(W - 210, 0).bezierCurveTo(W - 170, 58, W - 80, 36, W, 104).lineTo(W, 0).closePath().fill(P.wave);
      doc.opacity(0.035); doc.rotate(-30, { origin: [W / 2, H / 2 + 40] });
      doc.font('D').fontSize(150).fillColor(P.accent).text(m.watermark, 0, H / 2 - 40, { width: W, align: 'center', lineBreak: false });
      doc.restore();
    };
    background(); doc.on('pageAdded', background);

    // an icon + text row; returns the y below it
    const iconRow = (ic, text, x, y, w, opts = {}) => {
      const { url, size = 9.2, color = BODY, font = 'R', gap = 3.5 } = opts;
      icon(ic, x, y + 0.6, 10.5, P.accent);
      const sz = url ? fitSize(text, 'M', w - 17, size) : size;
      return (url ? link(text, url, 'M', sz, x + 17, y + (size - sz) / 2, w - 17, { lineBreak: false }) : put(text, font, size, x + 17, y, w - 17, color)) + gap;
    };

    // ---------- header ----------
    function header(first) {
      if (!first) {
        logo(L, 20, 34); put(iss.company_name, 'X', fitSize(iss.company_name, 'X', 260, 12), L + 44, 24, 270, P.navy, { lineBreak: false }); put(`CIN ${iss.cin}`, 'M', 7, L + 44, 41, 260, FAINT);
        put(titleCase, 'D', 14, R - 200, 20, 200, P.navy, { align: 'right' }); put(`${m.number} · continued`, 'B', 8.6, R - 260, 40, 260, MUTED, { align: 'right' });
        hair(64); return 80;
      }
      logo(L, 24, 62);
      const [brand, ...rest] = iss.company_name.split(' ');
      put(brand, 'X', 31, L + 70, 22, 200, P.navy, { lineBreak: false });
      put(rest.join(' '), 'M', 11, L + 71, 60, 200, BODY, { lineBreak: false });
      put('Build   |   Innovate   |   Grow', 'M', 7.4, L + 71, 77, 200, MUTED, { characterSpacing: 1, lineBreak: false });
      put(`CIN ${iss.cin}`, 'M', 7, L + 71, 90, 200, FAINT, { lineBreak: false });
      doc.moveTo(296, 28).lineTo(296, 98).strokeColor(LINE).lineWidth(1).stroke();
      let cy = 28; const cx = 312; const cw = 170;
      const host = (() => { try { return new URL(iss.website).host; } catch { return iss.website; } })();
      const rows = [['pin', iss.office.lines.slice(-3).join(', '), null], ...(iss.email ? [['mail', iss.email, `mailto:${iss.email}`]] : []), ['phone', iss.phone, `tel:${String(iss.phone).replace(/[^\d+]/g, '')}`], ['web', host, iss.website]];
      for (const [ic, text, url] of rows) { icon(ic, cx, cy + 0.5, 10.5, P.accent); const sz = fitSize(text, 'M', cw - 18, 8.6); (url ? link : (t, _u, ...a) => put(t, ...a))(text, url, 'M', sz, cx + 17, cy + 1, cw - 18, ...(url ? [{ lineBreak: false }] : [BODY, { lineBreak: false }])); cy += 17; }
      put('YOUR VISION', 'M', 6.4, R - 90, 70, 90, MUTED, { align: 'right', characterSpacing: 1.6 }); put('OUR TECHNOLOGY', 'M', 6.4, R - 90, 80, 90, MUTED, { align: 'right', characterSpacing: 1.6 });
      hair(112, LINE, 0.8);

      // title, key facts (left), and the amount card (right)
      put(m.title, 'X', 35, L, 122, 300, P.navy, { characterSpacing: 0.5 });
      const facts = [[`${titleCase} No.`, m.number], ['Date', m.meta[0]?.[1] ?? ''], ...m.meta.slice(1)].filter(([, v]) => v);
      let fy = 166; for (const [k, v] of facts) { put(k, 'M', 9.2, L, fy + 0.6, 78, MUTED); put(v, 'B', 10, L + 80, fy, 220, INK); fy += 13.5; }
      const hw = 214; const hx = R - hw;
      doc.roundedRect(hx, 124, hw, 62, 7).fill(P.pale); doc.roundedRect(hx, 124, 4, 62, 2).fill(P.accent);
      put(m.hero.label, 'B', 10.5, hx + 20, 135, hw - 30, P.navy);
      put(m.hero.value, 'X', 25, hx + 14, 151, hw - 24, P.navy, { align: 'right' });
      const bottom = Math.max(fy, 192) + 2; hair(bottom + 4, LINE, 0.8); return bottom + 14;
    }

    // ---------- parties: Bill To | From, separated by a hairline ----------
    const half = CW / 2; const pw = half - 22; const rx = L + half + 22;
    function billBody(x, y0) {
      let y = put(m.billedLabel, 'M', 9.6, x, y0, pw, P.accent) + 3;
      for (let i = 0; i < m.billed.length; i += 1) {
        const r = m.billed[i];
        if (r.kind === 'name') { y = put(r.text, 'B', 13, x, y, pw, INK) + 4; continue; }
        if (r.kind === 'addr') { const block = []; while (m.billed[i]?.kind === 'addr') { block.push(m.billed[i].text); i += 1; } i -= 1; y = iconRow('pin', block.join('\n'), x, y, pw); continue; }
        const ic = { attn: 'user', email: 'mail', phone: 'phone', web: 'web', doc: 'doc' }[r.kind];
        y = iconRow(ic, r.text, x, y, pw, { url: r.link, color: r.muted ? MUTED : BODY });
      }
      return y;
    }
    function fromBody(x, y0) {
      let y = put('From', 'M', 9.6, x, y0, pw, P.accent) + 3;
      y = put(iss.company_name, 'B', 12, x, y, pw, INK) + 5;
      for (const a of m.addresses) {
        y = put(`${a.label}:`, 'M', 7.2, x + 17, y, pw - 17, FAINT) + 0.5;
        y = iconRow('pin', a.text, x, y, pw, { gap: 4.5 });
      }
      y = iconRow('phone', iss.phone, x, y, pw, { url: `tel:${String(iss.phone).replace(/[^\d+]/g, '')}` });
      return iconRow('web', iss.website, x, y, pw, { url: iss.website });
    }
    function parties(y0) {
      dry = true; const bottom = Math.max(billBody(L, y0), fromBody(rx, y0)); dry = false;
      doc.moveTo(L + half, y0).lineTo(L + half, bottom).strokeColor(LINE).lineWidth(0.9).stroke();
      billBody(L, y0); fromBody(rx, y0);
      return bottom + 8;
    }

    // ---------- items table: navy header, rows inside a soft rounded frame ----------
    const hasDisc = m.rows.some((r) => r.discount); const hasTax = m.rows.some((r) => r.tax);
    const cols = { no: 28, qty: 40, rate: 78, disc: hasDisc ? 66 : 0, tax: hasTax ? 58 : 0, amt: 84 }; cols.desc = CW - Object.values(cols).reduce((a, b) => a + b, 0);
    const x = { no: L, desc: L + cols.no }; x.qty = x.desc + cols.desc; x.rate = x.qty + cols.qty; x.disc = x.rate + cols.rate; x.tax = x.disc + cols.disc; x.amt = x.tax + cols.tax;
    let tableTop = 0;
    function tableHeader(y) {
      tableTop = y;
      doc.save(); doc.roundedRect(L, y, CW, 26, 7).clip(); doc.rect(L, y, CW, 26).fill(P.navy); doc.restore();
      const t = (str, cx, cw, al) => put(str, 'M', 8.8, cx, y + 8.5, cw, '#ffffff', { align: al });
      t('#', x.no, cols.no, 'center'); t('Description', x.desc + 4, cols.desc, 'left'); t('Qty', x.qty, cols.qty - 6, 'right'); t('Rate', x.rate, cols.rate - 6, 'right');
      if (hasDisc) t('Discount', x.disc, cols.disc - 6, 'right'); if (hasTax) t('Tax', x.tax, cols.tax - 6, 'right'); t('Amount', x.amt, cols.amt - 10, 'right');
      return y + 26;
    }
    const frame = (yEnd) => { doc.roundedRect(L, tableTop, CW, yEnd - tableTop, 7).lineWidth(0.8).strokeColor('#d6deea').stroke(); };
    function row(r, y) {
      const nameH = h(r.name, 'B', 9.8, cols.desc - 12); const descH = r.description ? h(r.description, 'R', 8.4, cols.desc - 12) : 0;
      const rh = Math.max(nameH + (descH ? descH + 2 : 0), (hasDisc && r.discount) || (hasTax && r.tax) ? 22 : 12) + 13;
      return { rh, draw: (last) => {
        put(String(r.no), 'M', 9, x.no, y + 6.5, cols.no, MUTED, { align: 'center' });
        const ty = put(r.name, 'B', 9.8, x.desc + 4, y + 6.5, cols.desc - 12, INK);
        if (r.description) put(r.description, 'R', 8.4, x.desc + 4, ty + 2, cols.desc - 12, MUTED);
        put(r.qty, 'M', 9.4, x.qty, y + 6.5, cols.qty - 6, BODY, { align: 'right' });
        put(r.rate, 'M', 9.4, x.rate, y + 6.5, cols.rate - 6, BODY, { align: 'right' });
        if (hasDisc) {
          if (r.discount) { put(r.discount.main, 'M', 9.4, x.disc, y + 6.5, cols.disc - 6, BODY, { align: 'right' }); put(r.discount.sub, 'M', 7.4, x.disc, y + 20, cols.disc - 6, MUTED, { align: 'right' }); }
          else put('—', 'R', 9.4, x.disc, y + 6.5, cols.disc - 6, FAINT, { align: 'right' });
        }
        if (hasTax) {
          if (r.tax) { put(r.tax.main, 'M', 9.4, x.tax, y + 6.5, cols.tax - 6, BODY, { align: 'right' }); put(r.tax.sub, 'M', 7.4, x.tax, y + 20, cols.tax - 6, MUTED, { align: 'right' }); }
          else put('—', 'R', 9.4, x.tax, y + 6.5, cols.tax - 6, FAINT, { align: 'right' });
        }
        put(r.amount, 'B', 9.8, x.amt, y + 6.5, cols.amt - 10, INK, { align: 'right' });
        if (!last) hair(y + rh, '#e8edf4', 0.7, L + 10, R - 10);
      } };
    }
    const newPage = () => { frame(Math.min(lastY, LIMIT)); doc.addPage(); return header(false); };
    let lastY = 0;

    // ---------- build ----------
    let y = tableHeader(parties(header(true)));
    if (!m.rows.length) { put('No line items', 'R', 9.5, L, y + 14, CW, MUTED, { align: 'center' }); y += 40; }
    m.rows.forEach((r, n) => {
      const { rh, draw } = row(r, y);
      if (y + rh > LIMIT) { frame(y); y = tableHeader(newPage0()); const again = row(r, y); again.draw(n === m.rows.length - 1); y += again.rh; lastY = y; return; }
      draw(n === m.rows.length - 1); y += rh; lastY = y;
    });
    function newPage0() { doc.addPage(); return header(false); }
    frame(y); y += 12;

    // payment details (left) + totals (right)
    const tw = 232; const tx = R - tw; const rowH = 15.5; const cardW = 258;
    const bankRows = m.bank ? m.bank.map(([k, v]) => ({ k, v, vh: h(v, 'B', k === 'Account number' ? 10.2 : 9.4, cardW - 126, { characterSpacing: k === 'Account number' ? 0.6 : 0 }) })) : [];
    const brh = (r) => Math.max(15, r.vh + 4);
    const CARD_H = m.bank ? 36 + bankRows.reduce((a, r) => a + brh(r), 0) + 8 : 0;
    const totalsH = m.totals.length * rowH + 44 + (m.paid ? 2 * rowH + 8 : 0) + (m.words ? 18 + h(m.words, 'B', 8.6, tw) : 0) + 4;
    const termsList = [m.paymentTerms && `Payment terms: ${m.paymentTerms}`, m.notes && `Notes: ${m.notes}`, ...(inv ? INVOICE_TERMS : QUOTATION_TERMS), m.footnote].filter(Boolean);
    const TW = 238; const termsH = 17 + termsList.reduce((a, t) => a + h(t, 'R', 8, TW - 12) + 3, 0);
    const BAND = Math.max(termsH, 70);
    if (y + Math.max(CARD_H, totalsH) + 14 + BAND > LIMIT) { frame(Math.min(lastY, LIMIT)); y = newPage0(); }
    let ty = y;
    for (const [k, v] of m.totals) { put(k, 'M', 9.4, tx, ty + 3, 120, MUTED); put(v, 'B', 9.8, tx + 100, ty + 3, tw - 100, INK, { align: 'right' }); ty += rowH; }
    doc.roundedRect(tx - 8, ty + 4, tw + 8, 35, 7).fill(P.pale);
    put(m.grandLabel, 'X', fitSize(m.grandLabel, 'X', 120, 13.5), tx, ty + 14.5, 130, P.navy); put(m.grand, 'X', 19, tx + 70, ty + 11.5, tw - 78, P.navy, { align: 'right' });
    ty += 44;
    if (m.paid) {
      put('Amount paid', 'M', 9.4, tx, ty + 1, 120, MUTED); put(m.paid, 'B', 9.8, tx + 100, ty + 1, tw - 108, '#15803d', { align: 'right' }); ty += rowH + 2;
      hair(ty - 2, LINE, 0.7, tx, R);
      put('Balance due', 'B', 10.4, tx, ty + 5, 120, INK); put(m.balance, 'X', 12.5, tx + 80, ty + 4, tw - 88, INK, { align: 'right' }); ty += rowH + 6;
    }
    if (m.words) { put('Amount in words', 'M', 7.2, tx - 8, ty + 2, tw, FAINT, { characterSpacing: 0.6 }); ty = put(m.words, 'B', 8.6, tx - 8, ty + 12, tw + 8, BODY) + 4; }
    if (m.bank) {
      doc.roundedRect(L, y, cardW, CARD_H, 9).fill(P.pale);
      icon('card', L + 14, y + 11, 15, P.accent); put('Payment Details', 'B', 11.2, L + 36, y + 12.5, cardW - 50, P.navy);
      let by = y + 36;
      for (const r of bankRows) {
        put(r.k, 'R', 8.8, L + 16, by + 0.8, 90, MUTED); put(':', 'R', 8.8, L + 104, by + 0.8, 8, MUTED);
        put(r.v, 'B', r.k === 'Account number' ? 10.2 : 9.4, L + 118, by, cardW - 126, INK, { characterSpacing: r.k === 'Account number' ? 0.6 : 0 });
        by += brh(r);
      }
    }
    y = Math.max(ty, y + CARD_H) + 14; hair(y - 6, LINE, 0.8);

    // terms (left) · thank-you (centre) · authorised signatory (right). Always printed.
    y += 2; if (y + BAND > LIMIT) y = newPage0() + 0;
    put('Terms & Conditions', 'B', 9.4, L, y, TW, P.navy); let by2 = y + 15;
    for (const t of termsList) { doc.circle(L + 3, by2 + 4.4, 1.2).fill(MUTED); by2 = put(t, 'R', 8, L + 11, by2, TW - 12, MUTED) + 3; }
    const cxm = L + TW + 8;
    doc.save(); doc.rotate(-5, { origin: [cxm + 60, y + 24] }); put('Thank You!', 'D', 19, cxm, y + 10, 112, P.accent, { align: 'center' }); doc.restore();
    put(m.thanks, 'R', 7.4, cxm, y + 40, 112, MUTED, { align: 'center' });
    const sw = 138; const sx = R - sw; const co = `For ${iss.company_name}`;
    put(co, 'D', 8.8, sx, y + 2, sw, INK, { align: 'right' });
    if (inv) { const sh = 29; doc.image(SIGNATURE, R - sh * SIG_RATIO - 8, y + BAND - 18 - sh + 2, { height: sh }); } // handwritten signature: invoices only
    hair(y + BAND - 18, '#cbd5e1', 0.8, sx, R);
    put('Authorised Signatory', 'B', 8, sx, y + BAND - 12, sw, MUTED, { align: 'right' });

    // ---------- footer wave on every page ----------
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(i);
      const fy = H - FOOTER_H;
      doc.save();
      doc.moveTo(0, fy + 14).bezierCurveTo(W * 0.22, fy - 8, W * 0.52, fy + 38, W, fy + 2).lineTo(W, H).lineTo(0, H).closePath().fill(P.navy);
      doc.opacity(0.55).moveTo(W * 0.42, H).bezierCurveTo(W * 0.6, fy + 34, W * 0.8, fy + 16, W, fy + 8).lineTo(W, H).closePath().fill(P.foot2);
      doc.restore();
      const colW = (W - 2 * L) / 4;
      SERVICES.forEach(([ic, label], n) => {
        const cx2 = L + n * colW; const cyy = H - 36;
        doc.save(); doc.translate(cx2 + 8, cyy); doc.scale(15 / 24); doc.path(ICONS[ic]).lineWidth(0).fill('#ffffff'); doc.restore();
        doc.font('M').fontSize(7.8).fillColor('#ffffff').text(label, cx2 + 30, cyy + 3.5, { width: colW - 34, lineBreak: false });
        if (n) { doc.save(); doc.opacity(0.3).moveTo(cx2, cyy - 2).lineTo(cx2, cyy + 20).strokeColor('#ffffff').lineWidth(0.8).stroke(); doc.restore(); }
      });
      doc.font('B').fontSize(6.8).fillColor('#c3d3ee').text(`Page ${i + 1} of ${range.count}`, R - 80, H - 13, { width: 80, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
