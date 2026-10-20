/**
 * The issuer (our company) shown on every quotation and invoice.
 * This is the single source of truth: it is copied into each document as a snapshot when the draft is created,
 * and the API never accepts issuer details from a client. Nothing here is invented — only what the business supplied.
 * To change it for FUTURE documents, edit this file and redeploy; existing documents keep their own snapshot.
 */
export const ISSUER = Object.freeze({
  company_name: 'Piweb Tech Software Solution PVT LTD',
  cin: 'U62010RJ2025PTC102136',
  headquarters: Object.freeze({ label: 'Headquarters', lines: Object.freeze(['Ganesh Nagar, Jaipur, Rajasthan, India']) }),
  office: Object.freeze({
    label: 'Office Address',
    lines: Object.freeze(['33, Golf Course Extension Road', 'Sector 50', 'Gurugram', 'Haryana - 122101', 'India']),
  }),
  phone: '7296003817',
  // Where clients pay. Printed on every quotation and invoice exactly as supplied by the business; no bank name was given, so none is shown.
  bank: Object.freeze({ account_name: 'Piweb Tech Software Solutions PVT LTD', account_number: '2502244481711832', ifsc: 'AUBL0002444' }),
  website: 'https://www.piwebtechnology.com/landing-page',
});

/** A deep, mutable copy for storing in a document snapshot. */
export const issuerSnapshot = () => JSON.parse(JSON.stringify(ISSUER));

/** Pre-filled into the payment terms of every new quotation / invoice (editable per document). */
export const DEFAULT_PAYMENT_TERMS = '20% Advanced';

/** Standard terms printed on the invoice / quotation PDF (the document's own payment terms and notes are added above them). */
export const INVOICE_TERMS = Object.freeze(['Late payment may attract additional charges.']);
export const QUOTATION_TERMS = Object.freeze([]);
