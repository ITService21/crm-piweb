import { DateTime } from 'luxon';
import { config } from '../config.js';

/**
 * Business-day boundaries as UTC instants, so date filters become
 * index-friendly range predicates: col >= start AND col < end.
 */
export function dayStartUtc(dateStr, tz = config.tz) {
  const dt = DateTime.fromISO(dateStr, { zone: tz }).startOf('day');
  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

/** Start of the day *after* dateStr (exclusive upper bound). */
export function nextDayStartUtc(dateStr, tz = config.tz) {
  const dt = DateTime.fromISO(dateStr, { zone: tz }).startOf('day').plus({ days: 1 });
  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

export function todayStr(now = new Date(), tz = config.tz) {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate();
}

export function addDaysStr(dateStr, n, tz = config.tz) {
  return DateTime.fromISO(dateStr, { zone: tz }).plus({ days: n }).toISODate();
}

export function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

/** Day boundaries relative to `now` in business tz. */
export function dayBounds(now = new Date(), tz = config.tz) {
  const today = todayStr(now, tz);
  return {
    today,
    todayStart: dayStartUtc(today, tz),
    tomorrowStart: nextDayStartUtc(today, tz),
  };
}

export function formatBusiness(d, tz = config.tz) {
  return DateTime.fromJSDate(new Date(d), { zone: tz }).toFormat('dd LLL yyyy, hh:mm a');
}
