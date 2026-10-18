import { DateTime } from 'luxon';

export interface FollowupInfo { text: string; overdue: boolean; kind: 'none' | 'overdue' | 'today' | 'future' }

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * Human-readable follow-up countdown / delay. Uses calendar dates in the
 * business timezone for "tomorrow" / "N days" and exact timestamps for hours/minutes.
 */
export function followupInfo(iso: string | null | undefined, now: Date, tz: string): FollowupInfo {
  if (!iso) return { text: 'No follow-up set', overdue: false, kind: 'none' };
  const target = DateTime.fromISO(iso, { zone: tz });
  const cur = DateTime.fromJSDate(now, { zone: tz });

  if (target.toMillis() <= cur.toMillis()) {
    const mins = Math.max(1, Math.floor((cur.toMillis() - target.toMillis()) / 60000));
    if (mins < 60) return { text: `Delayed by ${plural(mins, 'min')}`, overdue: true, kind: 'overdue' };
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return { text: `Delayed by ${plural(hrs, 'hr')}`, overdue: true, kind: 'overdue' };
    return { text: `Delayed by ${plural(Math.floor(hrs / 24), 'day')}`, overdue: true, kind: 'overdue' };
  }

  const dayGap = Math.round(target.startOf('day').diff(cur.startOf('day'), 'days').days);
  if (dayGap === 0) {
    const mins = Math.max(1, Math.ceil((target.toMillis() - cur.toMillis()) / 60000)); // partial minute rounds up
    if (mins < 60) return { text: `Follow-up in ${plural(mins, 'min')}`, overdue: false, kind: 'today' };
    return { text: `Follow-up in ${plural(Math.floor(mins / 60), 'hr')}`, overdue: false, kind: 'today' };
  }
  if (dayGap === 1) return { text: 'Follow-up tomorrow', overdue: false, kind: 'future' };
  return { text: `Follow-up in ${plural(dayGap, 'day')}`, overdue: false, kind: 'future' };
}

export const businessDate = (now: Date, tz: string) => DateTime.fromJSDate(now, { zone: tz }).toISODate()!;

export const fmtDateTime = (iso: string | null | undefined, tz: string) =>
  iso ? DateTime.fromISO(iso, { zone: tz }).toFormat('dd LLL yyyy, hh:mm a') : '—';
export const fmtShort = (iso: string | null | undefined, tz: string) =>
  iso ? DateTime.fromISO(iso, { zone: tz }).toFormat('dd LLL, hh:mm a') : '—';
export const fmtTime = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: tz }).toFormat('hh:mm a');

/** For <input type="datetime-local">: wall-clock in the business timezone. */
export const toInputValue = (iso: string | null | undefined, tz: string) =>
  iso ? DateTime.fromISO(iso, { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm") : '';

/** Preset follow-up moments, as naive business-tz wall-clock strings the API understands. */
export function presetFollowup(kind: '1h' | 'tomorrow' | '3d' | '1w', now: Date, tz: string): string {
  const cur = DateTime.fromJSDate(now, { zone: tz });
  const t = kind === '1h' ? cur.plus({ hours: 1 }).startOf('minute')
    : kind === 'tomorrow' ? cur.plus({ days: 1 }).set({ hour: 10, minute: 0 })
      : kind === '3d' ? cur.plus({ days: 3 }).set({ hour: 10, minute: 0 })
        : cur.plus({ weeks: 1 }).set({ hour: 10, minute: 0 });
  return t.toFormat("yyyy-MM-dd'T'HH:mm");
}
