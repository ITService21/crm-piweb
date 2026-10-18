import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { followupInfo, businessDate, presetFollowup } from './time';

const TZ = 'Asia/Kolkata';
const at = (s: string) => DateTime.fromISO(s, { zone: TZ }).toJSDate();
const iso = (s: string) => DateTime.fromISO(s, { zone: TZ }).toUTC().toISO()!;

describe('followupInfo', () => {
  const now = at('2026-10-18T11:00:00');
  it('handles missing dates explicitly', () => expect(followupInfo(null, now, TZ).text).toBe('No follow-up set'));
  it('delayed: 9:00 today at 11:00 is delayed by 2 hrs yet still a same-day follow-up', () => {
    const r = followupInfo(iso('2026-10-18T09:00:00'), now, TZ);
    expect(r).toMatchObject({ text: 'Delayed by 2 hrs', overdue: true });
  });
  it('singular/plural and rounding', () => {
    expect(followupInfo(iso('2026-10-18T10:59:10'), now, TZ).text).toBe('Delayed by 1 min');
    expect(followupInfo(iso('2026-10-18T10:58:00'), now, TZ).text).toBe('Delayed by 2 mins');
    expect(followupInfo(iso('2026-10-18T10:15:00'), now, TZ).text).toBe('Delayed by 45 mins');
    expect(followupInfo(iso('2026-10-18T10:00:00'), now, TZ).text).toBe('Delayed by 1 hr');
    expect(followupInfo(iso('2026-10-17T11:00:00'), now, TZ).text).toBe('Delayed by 1 day');
    expect(followupInfo(iso('2026-10-15T11:00:00'), now, TZ).text).toBe('Delayed by 3 days');
  });
  it('future: minutes, hours, tomorrow, days', () => {
    expect(followupInfo(iso('2026-10-18T11:02:00'), now, TZ).text).toBe('Follow-up in 2 mins');
    expect(followupInfo(iso('2026-10-18T11:30:00'), now, TZ).text).toBe('Follow-up in 30 mins');
    expect(followupInfo(iso('2026-10-18T13:00:00'), now, TZ).text).toBe('Follow-up in 2 hrs');
    expect(followupInfo(iso('2026-10-19T09:00:00'), now, TZ).text).toBe('Follow-up tomorrow');
    expect(followupInfo(iso('2026-10-21T09:00:00'), now, TZ).text).toBe('Follow-up in 3 days');
  });
  it('flips from upcoming to delayed as the clock advances (no reload needed)', () => {
    const f = iso('2026-10-18T11:30:00');
    expect(followupInfo(f, at('2026-10-18T11:00:00'), TZ).overdue).toBe(false);
    expect(followupInfo(f, at('2026-10-18T11:31:00'), TZ)).toMatchObject({ overdue: true, text: 'Delayed by 1 min' });
  });
  it('uses the business calendar, not the browser/UTC calendar, around midnight', () => {
    // 23:30 IST on the 18th (18:00Z); follow-up at 00:30 IST on the 19th is "tomorrow", not "today"
    expect(followupInfo(iso('2026-10-19T00:30:00'), at('2026-10-18T23:30:00'), TZ).text).toBe('Follow-up tomorrow');
    expect(businessDate(at('2026-10-18T23:30:00'), TZ)).toBe('2026-10-18');
    expect(businessDate(at('2026-10-19T00:05:00'), TZ)).toBe('2026-10-19');
  });
});

describe('presetFollowup', () => {
  it('produces naive business wall-clock strings', () => {
    expect(presetFollowup('tomorrow', at('2026-10-18T23:30:00'), TZ)).toBe('2026-10-19T10:00');
    expect(presetFollowup('1h', at('2026-10-18T11:00:30'), TZ)).toBe('2026-10-18T12:00');
  });
});
