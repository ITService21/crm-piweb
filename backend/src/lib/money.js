import { badRequest } from './errors.js';

/**
 * Exact money maths. Amounts are integers in minor units (paise/cents), quantities in thousandths and
 * percentages in thousandths of a percent, so nothing is ever computed with floating point.
 */
const bigDiv = (num, den) => Number((num * 2n + den) / (den * 2n)); // round half up for non-negative values

function parseFixed(input, dp, label, { allowNegative = false, max = 1e11 } = {}) {
  if (input === null || input === undefined || input === '') throw badRequest(`${label} is required`);
  const s = String(input).trim().replace(/,/g, '');
  const re = new RegExp(`^-?\\d+(\\.\\d{1,${dp}})?$`);
  if (!re.test(s)) throw badRequest(`${label} must be a number with at most ${dp} decimal place${dp === 1 ? '' : 's'}`);
  const neg = s.startsWith('-');
  if (neg && !allowNegative) throw badRequest(`${label} cannot be negative`);
  const [i, f = ''] = s.replace('-', '').split('.');
  const scaled = Number(i) * 10 ** dp + Number(f.padEnd(dp, '0'));
  if (i.length > 12 || scaled / 10 ** dp > max) throw badRequest(`${label} is too large`);
  return neg ? -scaled : scaled;
}

export const toMinor = (v, label = 'Amount', opts) => parseFixed(v, 2, label, opts);
export const toMilli = (v, label = 'Quantity', opts) => parseFixed(v, 3, label, opts); // quantity, rates, percentages

/** DECIMAL columns come back as numbers or strings; convert to integer minor units. */
export const fromDb = (v) => (v === null || v === undefined ? 0 : Math.round(Number(v) * 100));
export const fromDbMilli = (v) => (v === null || v === undefined ? 0 : Math.round(Number(v) * 1000));

/** minor units -> "1234.50" (exact, for DECIMAL columns and API output) */
export function minorToString(minor) {
  const neg = minor < 0; const a = Math.abs(minor);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
export function milliToString(milli, dp = 3) {
  const neg = milli < 0; const a = Math.abs(milli);
  const s = `${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, '0')}`;
  return `${neg ? '-' : ''}${dp === 3 ? s : s.replace(/\.?0+$/, '')}`;
}

/**
 * One line item. Tax is added on top of the discounted amount (tax-exclusive pricing).
 *   gross = qty x unit price;  discount = % of gross or a flat amount (never more than gross)
 *   taxable = gross - discount;  tax = taxable x rate;  total = taxable + tax
 */
export function computeLine({ quantity, unit_price: unitPrice, discount_type: dType = 'none', discount_value: dValue = 0, tax_rate: taxRate = null }) {
  const qty = toMilli(quantity, 'Quantity');
  if (qty <= 0) throw badRequest('Quantity must be greater than zero');
  const price = toMinor(unitPrice, 'Unit price');
  const gross = bigDiv(BigInt(qty) * BigInt(price), 1000n);
  let discount = 0;
  if (dType === 'percent') {
    const pct = toMilli(dValue ?? 0, 'Discount percent');
    if (pct > 100000) throw badRequest('Discount percent cannot exceed 100');
    discount = bigDiv(BigInt(gross) * BigInt(pct), 100000n);
  } else if (dType === 'amount') {
    discount = Math.min(toMinor(dValue ?? 0, 'Discount amount'), gross);
  }
  const taxable = gross - discount;
  let tax = 0; let rateMilli = null;
  if (taxRate !== null && taxRate !== undefined && taxRate !== '') {
    rateMilli = toMilli(taxRate, 'Tax rate');
    if (rateMilli > 100000) throw badRequest('Tax rate cannot exceed 100%');
    tax = bigDiv(BigInt(taxable) * BigInt(rateMilli), 100000n);
  }
  return { qtyMilli: qty, priceMinor: price, gross, discount, taxable, tax, rateMilli, total: taxable + tax };
}

export function computeTotals(lines, additionalCharges = 0) {
  const sum = (k) => lines.reduce((a, l) => a + l[k], 0);
  const extra = additionalCharges || 0;
  const taxable = sum('taxable'); const tax = sum('tax');
  return { subtotal: sum('gross'), discount: sum('discount'), taxable, tax, additional: extra, total: taxable + tax + extra };
}

// ---------- display helpers ----------
const LOCALE = { INR: 'en-IN' };
export function formatMoney(minor, currency = 'INR') {
  return new Intl.NumberFormat(LOCALE[currency] ?? 'en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const below1000 = (n) => `${n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' : ''}` : ''}${below100(n % 100)}`;

const upTo99999 = (n) => `${n >= 1000 ? `${below100(Math.floor(n / 1000))} Thousand${n % 1000 ? ' ' : ''}` : ''}${n % 1000 ? below1000(n % 1000) : ''}`;

/** Indian numbering (lakh / crore): 123456.50 -> "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only" */
export function amountInWordsINR(minor) {
  if (minor < 0) return '';
  let rupees = Math.floor(minor / 100); const paise = minor % 100;
  if (rupees === 0 && paise === 0) return 'Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push(`${upTo99999(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rupees) parts.push(below1000(rupees));
  const r = parts.join(' ');
  return `Rupees ${r || 'Zero'}${paise ? ` and ${below100(paise)} Paise` : ''} Only`;
}
