import { describe, it, expect } from 'vitest';
import { money, apiBase, routeBase, docLabel, STATUS_META, INVOICE_STATUSES, QUOTATION_STATUSES } from './billing';

describe('billing helpers', () => {
  it('formats Indian rupees with lakh grouping and other currencies normally', () => {
    expect(money('123456.5')).toBe('₹1,23,456.50');
    expect(money('0')).toBe('₹0.00');
    expect(money('2500', 'USD')).toBe('$2,500.00');
    expect(money(null)).toBe('₹0.00');
    expect(money('not a number')).toBe('₹0.00');
  });
  it('maps document types to API paths, routes and labels', () => {
    expect(apiBase('invoice')).toBe('/invoices'); expect(apiBase('quotation')).toBe('/quotations');
    expect(routeBase('invoice')).toBe('/invoices'); expect(docLabel('quotation')).toBe('Quotation');
  });
  it('has a label for every selectable status', () => {
    for (const s of [...INVOICE_STATUSES, ...QUOTATION_STATUSES]) expect(STATUS_META[s], s).toBeTruthy();
  });
});
