import { DateTime } from 'luxon';
import type { DocType } from './types';

export const apiBase = (t: DocType) => (t === 'invoice' ? '/invoices' : '/quotations');
export const routeBase = (t: DocType) => (t === 'invoice' ? '/invoices' : '/quotations');
export const docLabel = (t: DocType) => (t === 'invoice' ? 'Invoice' : 'Quotation');
export const docLabelPlural = (t: DocType) => (t === 'invoice' ? 'Invoices' : 'Quotations');
export const bandGradient = (t: DocType) => (t === 'invoice' ? 'linear-gradient(105deg,#4338ca 0%,#9333ea 55%,#ec4899 100%)' : 'linear-gradient(105deg,#0f766e 0%,#0891b2 55%,#2563eb 100%)');
export const accent = (_t: DocType) => '#4b5563';

const LOCALE: Record<string, string> = { INR: 'en-IN' };
/** Display only: totals always come from the server. */
export function money(value: string | number | null | undefined, currency = 'INR'): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat(LOCALE[currency] ?? 'en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(n) ? n : 0);
}
export const fmtDay = (s: string | null | undefined) => (s ? DateTime.fromISO(s).toFormat('dd LLL yyyy') : '—');
export const todayISO = (tz: string) => DateTime.now().setZone(tz).toISODate()!;
export const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 32) : `${Date.now()}${Math.random().toString(36).slice(2, 12)}`);

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-slate-100 text-slate-700 border-slate-300' },
  issued: { label: 'Issued', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  partially_paid: { label: 'Partially paid', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  paid: { label: 'Paid', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-50 text-red-700 border-red-200' },
  accepted: { label: 'Accepted', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  rejected: { label: 'Rejected', cls: 'bg-red-50 text-red-700 border-red-200' },
  converted: { label: 'Converted', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  overdue: { label: 'Overdue', cls: 'bg-red-50 text-red-700 border-red-200' },
  expired: { label: 'Expired', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
};
export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled'];
export const QUOTATION_STATUSES = ['draft', 'issued', 'accepted', 'rejected', 'converted', 'expired', 'cancelled'];
export const PAYMENT_METHODS = ['Bank transfer', 'UPI', 'Cash', 'Cheque', 'Card', 'Other'];

export const PROOF_MAX_BYTES = 8 * 1024 * 1024;
export const PROOF_MAX_FILES = 6;
/** Friendly client-side check before uploading (the server re-validates the real file content). */
export function checkProofs(files: File[]): string {
  if (files.length > PROOF_MAX_FILES) return `Choose at most ${PROOF_MAX_FILES} files at a time.`;
  for (const f of files) {
    if (f.size > PROOF_MAX_BYTES) return `“${f.name}” is larger than 8 MB.`;
    if (!/^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/.test(f.type)) return `“${f.name}” is not an image or PDF.`;
  }
  return '';
}
export const proofUrl = (docId: number, paymentId: number, fileId: number) => `/api/invoices/${docId}/payments/${paymentId}/attachments/${fileId}`;
export const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Document palettes (invoice = navy / blue, quotation = deep teal) — mirrors the PDF. */
export const DOC_PAL = {
  invoice: { navy: '#14315c', accent: '#2f6fe4', pale: '#eaf1fb', bg: '#f7faff', wave: '#dde9f8', foot2: '#2b5aa0' },
  quotation: { navy: '#0d3b3a', accent: '#0d9488', pale: '#e2f5f1', bg: '#f4fbf9', wave: '#d0eee7', foot2: '#17766f' },
} as const;
export const INVOICE_TERMS = ['Late payment may attract additional charges.'];
export const ICON_PATHS = {
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
} as const;
