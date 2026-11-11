import { describe, expect, it } from 'vitest';
import {
  baselineRows,
  computeBaseline,
  countInBucket,
  judgeVolume,
  lastClosedBucket,
  learningPeriod,
  learningReadyAt,
  nextVolumeEvalAt,
  recentPeriod,
  SETTLE_MS,
  type HourCount,
} from '../src/core/volume';
import type { ActiveWindow } from '../src/core/window';
import { at, HOUR, MIN } from './helpers';

const DAY = 24 * HOUR;
const iso = (t: number) => new Date(t).toISOString();

/** Hourly counts for [from, to): `perHour(localHour, isoWeekday)` pings in each hour. */
function fill(from: number, to: number, tz: string, perHour: (hour: number, weekday: number) => number): HourCount[] {
  const out: HourCount[] = [];
  for (let h = from; h < to; h += HOUR) {
    const d = new Date(h);
    // Tests use UTC or whole-hour zones, so derive local fields via Intl.
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(d);
    const hour = Number(parts.find((p) => p.type === 'hour')!.value);
    const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find((p) => p.type === 'weekday')!.value) + 1;
    const ok = perHour(hour, weekday);
    if (ok > 0) out.push({ hour: h, ok });
  }
  return out;
}

// 2026-10-05 is a Monday.
const period = { start: at('2026-10-05 00:00'), end: at('2026-10-19 00:00') };
const officeHours = (hour: number, weekday: number) => (weekday <= 5 && hour >= 9 && hour < 13 ? 10 : 0); // 40 per weekday

describe('learning a volume baseline', () => {
  it('learns a typical count per weekday, so weekends are not expected to match weekdays', () => {
    const b = computeBaseline({ counts: fill(period.start, period.end, 'UTC', officeHours), period, timezone: 'UTC', window: null, gaps: [] });
    expect(b.days).toBe(14);
    expect(b.daily).toEqual({ '1': 40, '2': 40, '3': 40, '4': 40, '5': 40, '6': 0, '7': 0 });
    expect(b.granularity).toBe('daily'); // far too quiet for hour-by-hour comparison
    expect(baselineRows(b)[0]).toEqual(['Monday', 40]);
    expect(baselineRows(b)[5]).toEqual(['Saturday', 0]);
  });

  it('uses the median, so one freak day does not skew what is normal', () => {
    const three = { start: at('2026-10-05 00:00'), end: at('2026-10-26 00:00') };
    const spike = at('2026-10-12 00:00'); // the middle Monday
    const counts = fill(three.start, three.end, 'UTC', officeHours).map((c) => (c.hour >= spike && c.hour < spike + DAY ? { ...c, ok: 500 } : c));
    const b = computeBaseline({ counts, period: three, timezone: 'UTC', window: null, gaps: [] });
    expect(b.daily['1']).toBe(40);
  });

  it('switches to hourly comparison only for busy automations', () => {
    const busy = computeBaseline({ counts: fill(period.start, period.end, 'UTC', () => 50), period, timezone: 'UTC', window: null, gaps: [] });
    expect(busy.granularity).toBe('hourly');
    expect(busy.hourly['3-14']).toBe(50);
    expect(busy.daily['3']).toBe(1200);
  });

  it('leaves out days that were hit by a monitoring gap', () => {
    const outage = { start: at('2026-10-07 10:00'), end: at('2026-10-07 11:00') }; // first Wednesday
    const counts = fill(period.start, period.end, 'UTC', officeHours).filter((c) => !(c.hour >= at('2026-10-07 00:00') && c.hour < at('2026-10-08 00:00')));
    const b = computeBaseline({ counts, period, timezone: 'UTC', window: null, gaps: [outage] });
    expect(b.days).toBe(13);
    expect(b.daily['3']).toBe(40); // learned from the other Wednesday only, not dragged down to 20
  });

  it('counts only hours inside the active window', () => {
    const window: ActiveWindow = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 11 * 60 };
    const b = computeBaseline({ counts: fill(period.start, period.end, 'UTC', officeHours), period, timezone: 'UTC', window, gaps: [] });
    expect(b.daily).toEqual({ '1': 20, '2': 20, '3': 20, '4': 20, '5': 20 }); // weekends are outside the window entirely
    expect(b.days).toBe(10);
  });

  it('buckets by the check timezone, including across a DST change', () => {
    const tz = 'America/New_York';
    // Two weeks around the fall change (1 Nov 2026). 10 pings at 09:00 local every day.
    const p = { start: at('2026-10-26 00:00', tz), end: at('2026-11-09 00:00', tz) };
    const b = computeBaseline({ counts: fill(p.start, p.end, tz, (hour) => (hour === 9 ? 10 : 0)), period: p, timezone: tz, window: null, gaps: [] });
    expect(b.days).toBe(14);
    expect(Object.values(b.daily)).toEqual([10, 10, 10, 10, 10, 10, 10]);
    expect(b.hourly['7-9']).toBe(10); // Sunday 09:00 local on both sides of the change
    expect(b.hourly['7-8'] ?? 0).toBe(0);
  });

  it('defines the learning period as the first 14 complete local days after the first ping', () => {
    const p = learningPeriod(at('2026-10-01 15:30', 'Europe/London'), 'Europe/London');
    expect(p.start).toBe(at('2026-10-02 00:00', 'Europe/London'));
    expect(p.end).toBe(at('2026-10-16 00:00', 'Europe/London'));
    const r = recentPeriod(at('2026-11-10 12:00'), 'UTC');
    expect([iso(r.start), iso(r.end)]).toEqual(['2026-10-27T00:00:00.000Z', '2026-11-10T00:00:00.000Z']);
  });
});

describe('judging volume', () => {
  const daily = computeBaseline({ counts: fill(period.start, period.end, 'UTC', officeHours), period, timezone: 'UTC', window: null, gaps: [] });

  it('judges yesterday at 08:00 in the check timezone, not at midnight', () => {
    const tz = 'America/Chicago';
    const b0 = computeBaseline({ counts: fill(at('2026-10-05 00:00', tz), at('2026-10-19 00:00', tz), tz, officeHours), period: { start: at('2026-10-05 00:00', tz), end: at('2026-10-19 00:00', tz) }, timezone: tz, window: null, gaps: [] });
    // Just after midnight on Tuesday, Monday is closed but not judged yet: nobody wants a 00:01 alert.
    expect(lastClosedBucket(b0, tz, null, at('2026-10-20 00:01', tz)).start).toBe(at('2026-10-18 00:00', tz));
    expect(lastClosedBucket(b0, tz, null, at('2026-10-20 07:59', tz)).start).toBe(at('2026-10-18 00:00', tz));
    expect(nextVolumeEvalAt(b0, tz, at('2026-10-20 00:01', tz))).toBe(at('2026-10-20 08:00', tz));
    // At 08:00 local, Monday is judged.
    const b = lastClosedBucket(b0, tz, null, at('2026-10-20 08:00', tz));
    expect([b.start, b.end]).toEqual([at('2026-10-19 00:00', tz), at('2026-10-20 00:00', tz)]);
    expect(b).toMatchObject({ expected: 40, when: 'on a Monday', label: 'Mon, Oct 19' });
    expect(nextVolumeEvalAt(b0, tz, at('2026-10-20 08:00', tz))).toBe(at('2026-10-21 08:00', tz));
    expect(nextVolumeEvalAt(daily, 'UTC', at('2026-10-20 15:00'))).toBe(at('2026-10-21 08:00'));
  });

  it('keeps the 08:00 wall-clock time across a DST change', () => {
    const tz = 'America/New_York';
    // Sunday 1 Nov 2026 is the 25-hour day. Its result is due Monday 08:00 EST (13:00 UTC).
    expect(new Date(nextVolumeEvalAt(daily, tz, at('2026-11-01 12:00', tz))).toISOString()).toBe('2026-11-02T13:00:00.000Z');
    // Saturday's result was due Sunday 08:00 local, which is still 08:00 on the wall clock (13:00 UTC, after the change at 02:00).
    expect(new Date(nextVolumeEvalAt(daily, tz, at('2026-11-01 01:00', tz))).toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(new Date(learningReadyAt(at('2026-10-17 15:00', tz), tz)).toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });

  it('still judges busy checks hour by hour, five minutes after each hour', () => {
    const busy = computeBaseline({ counts: fill(period.start, period.end, 'UTC', () => 50), period, timezone: 'UTC', window: null, gaps: [] });
    expect(lastClosedBucket(busy, 'UTC', null, at('2026-10-20 15:04')).start).toBe(at('2026-10-20 13:00'));
    expect(lastClosedBucket(busy, 'UTC', null, at('2026-10-20 15:04') + MIN).start).toBe(at('2026-10-20 14:00'));
    expect(nextVolumeEvalAt(busy, 'UTC', at('2026-10-20 15:04'))).toBe(at('2026-10-20 15:00') + SETTLE_MS);
  });

  it('alerts below the chosen percentage of normal, and never for normally quiet days', () => {
    expect(judgeVolume(40, 3, 50)).toEqual({ judged: true, low: true, threshold: 20 });
    expect(judgeVolume(40, 20, 50).low).toBe(false);
    expect(judgeVolume(40, 19, 50).low).toBe(true);
    expect(judgeVolume(40, 9, 20).low).toBe(false); // user-adjustable threshold
    expect(judgeVolume(0, 0, 50)).toMatchObject({ judged: false, low: false }); // weekend: nothing expected
    expect(judgeVolume(null, 0, 50).judged).toBe(false);
  });

  it('for low-volume checks, only complete silence counts as low', () => {
    expect(judgeVolume(1, 0, 50).low).toBe(true);
    expect(judgeVolume(1, 1, 50).low).toBe(false);
    expect(judgeVolume(3, 1, 10).low).toBe(false);
  });

  it('does not judge quiet hours of a busy check, or hours outside the active window', () => {
    const p = period;
    const dayOnly = computeBaseline({ counts: fill(p.start, p.end, 'UTC', (hour) => (hour >= 8 && hour < 20 ? 100 : 2)), period: p, timezone: 'UTC', window: null, gaps: [] });
    expect(dayOnly.granularity).toBe('hourly');
    const busyHour = lastClosedBucket(dayOnly, 'UTC', null, at('2026-10-20 15:06'));
    expect(busyHour).toMatchObject({ start: at('2026-10-20 14:00'), expected: 100, when: 'between 2:00 PM and 3:00 PM on a Tuesday' });
    expect(lastClosedBucket(dayOnly, 'UTC', null, at('2026-10-20 04:06')).expected).toBeNull(); // 03:00 normally has 2
    const window: ActiveWindow = { days: [1, 2, 3, 4, 5], start: 8 * 60, end: 20 * 60 };
    expect(lastClosedBucket(dayOnly, 'UTC', window, at('2026-10-24 15:06')).expected).toBeNull(); // Saturday
    expect(nextVolumeEvalAt(dayOnly, 'UTC', at('2026-10-20 15:06'))).toBe(at('2026-10-20 16:05'));
  });

  it('counts only in-window pings toward a day', () => {
    const window: ActiveWindow = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 11 * 60 };
    const monday = { start: at('2026-10-19 00:00'), end: at('2026-10-20 00:00') };
    const counts = fill(monday.start, monday.end, 'UTC', () => 5);
    expect(countInBucket(counts, monday, null, 'UTC')).toBe(120);
    expect(countInBucket(counts, monday, window, 'UTC')).toBe(10);
  });
});
