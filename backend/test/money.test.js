import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, toMilli, computeLine, computeTotals, minorToString, amountInWordsINR, formatMoney } from '../src/lib/money.js';

test('parsing is strict and exact (no floating point surprises)', () => {
  assert.equal(toMinor('0.1') + toMinor('0.2'), toMinor('0.3'));
  assert.equal(toMinor('1,234.5'), 123450);
  assert.equal(toMinor(19.99), 1999);
  assert.throws(() => toMinor('1.234'), /at most 2 decimal/);
  assert.throws(() => toMinor('abc'));
  assert.throws(() => toMinor('-5'), /negative/);
  assert.throws(() => toMinor(''), /required/);
  assert.equal(toMilli('2.5'), 2500);
  assert.equal(minorToString(5), '0.05'); assert.equal(minorToString(123456), '1234.56'); assert.equal(minorToString(0), '0.00');
});

test('line maths: quantity, percent discount, flat discount, tax, half-up rounding', () => {
  let l = computeLine({ quantity: '3', unit_price: '1999.99' });
  assert.deepEqual([l.gross, l.discount, l.taxable, l.tax, l.total], [599997, 0, 599997, 0, 599997]);
  l = computeLine({ quantity: '2', unit_price: '1000', discount_type: 'percent', discount_value: '10', tax_rate: '18' });
  assert.deepEqual([l.gross, l.discount, l.taxable, l.tax, l.total], [200000, 20000, 180000, 32400, 212400]);
  l = computeLine({ quantity: '1', unit_price: '500', discount_type: 'amount', discount_value: '9999' });
  assert.equal(l.discount, 50000, 'flat discount is capped at the line amount'); assert.equal(l.taxable, 0);
  l = computeLine({ quantity: '1.5', unit_price: '333.33', tax_rate: '5' }); // 499.995 -> 500.00 (half up), tax 25.00
  assert.deepEqual([l.gross, l.tax], [50000, 2500]);
  l = computeLine({ quantity: '1', unit_price: '0.01', tax_rate: '12.5' }); // tax 0.00125 -> 0
  assert.equal(l.tax, 0);
  assert.throws(() => computeLine({ quantity: '0', unit_price: '1' }), /greater than zero/);
  assert.throws(() => computeLine({ quantity: '1', unit_price: '1', discount_type: 'percent', discount_value: '101' }), /exceed 100/);
  assert.throws(() => computeLine({ quantity: '1', unit_price: '1', tax_rate: '150' }), /exceed 100/);
});

test('totals add up exactly, with additional charges', () => {
  const a = computeLine({ quantity: '2', unit_price: '1000', discount_type: 'percent', discount_value: '10', tax_rate: '18' });
  const b = computeLine({ quantity: '1', unit_price: '250.50' });
  const t = computeTotals([a, b], toMinor('100'));
  assert.deepEqual(t, { subtotal: 225050, discount: 20000, taxable: 205050, tax: 32400, additional: 10000, total: 247450 });
});

test('amount in words uses lakh/crore and paise', () => {
  assert.equal(amountInWordsINR(0), 'Rupees Zero Only');
  assert.equal(amountInWordsINR(12345600), 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only');
  assert.equal(amountInWordsINR(12345650), 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only');
  assert.equal(amountInWordsINR(50000), 'Rupees Five Hundred Only');
  assert.equal(amountInWordsINR(1500000000), 'Rupees One Crore Fifty Lakh Only');
  assert.equal(amountInWordsINR(150000000000), 'Rupees One Hundred Fifty Crore Only');
  assert.equal(amountInWordsINR(1234500000000), 'Rupees One Thousand Two Hundred Thirty Four Crore Fifty Lakh Only');
  assert.equal(amountInWordsINR(100), 'Rupees One Only');
  assert.equal(amountInWordsINR(5), 'Rupees Zero and Five Paise Only');
});

test('currency formatting', () => {
  assert.equal(formatMoney(12345600, 'INR'), '₹1,23,456.00');
  assert.equal(formatMoney(5, 'USD'), '$0.05');
});
