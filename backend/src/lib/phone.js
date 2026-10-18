import { config } from '../config.js';

/**
 * Normalises to "+<digits>" (E.164-style). A bare 10-digit number gets the
 * default country code. Returns null when the number is not plausible.
 */
export function normalizePhone(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const hasPlus = s.startsWith('+') || s.startsWith('00');
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.slice(2);
  if (!hasPlus) {
    if (digits.length === 10) digits = config.defaultCountryCode + digits;
    else if (digits.length === 11 && digits.startsWith('0')) digits = config.defaultCountryCode + digits.slice(1);
  }
  if (digits.length < 8 || digits.length > 15) return undefined;
  return `+${digits}`;
}
