// Volume baseline: learn how many pings are normal, then notice when volume drops. Pure functions.
//
// Learning looks at 14 complete local days. With only two samples per weekday, hour-by-hour
// numbers are noise for most automations, so:
//   - "daily" granularity (the default) compares each day's total with what is typical for
//     that weekday, so quiet weekends never look like a problem;
//   - "hourly" granularity is used only when the automation is busy enough (20+ pings in a
//     typical active hour) for an hourly comparison to mean something.
// Hours outside the active window, and days touched by a monitoring gap, are left out of both
// learning and evaluation.

import { DateTime } from 'luxon';
import { isInWindow, type ActiveWindow } from './window';

export const LEARNING_DAYS = 14;
export const HOUR_MS = 3_600_000;
/** Wait this long after a bucket closes before judging it, so late-arriving pings are counted. */
export const SETTLE_MS = 5 * 60_000;
/** Mean pings per active hour needed before hourly comparison is used. */
export const HOURLY_MIN_MEAN = 20;
/** Individual hours expected to be quieter than this are not judged. */
export const HOURLY_MIN_EXPECTED = 10;

export interface Baseline {
  granularity: 'daily' | 'hourly';
  /** ISO weekday ("1" = Monday) -> typical pings on that day. Missing = no data / outside window. */
  daily: Record<string, number>;
  /** "weekday-hour" (local) -> typical pings in that hour. */
  hourly: Record<string, number>;
  /** Complete days the baseline was learned from. */
  days: number;
  from: number;
  to: number;
}

export interface HourCount {
  /** Start of a UTC hour, epoch ms. */
  hour: number;
  ok: number;
}

export interface Interval {
  start: number;
  end: number;
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function localDay(t: number, tz: string): Interval & { weekday: number; date: string } {
  const start = DateTime.fromMillis(t, { zone: tz }).startOf('day');
  return { start: start.toMillis(), end: start.plus({ days: 1 }).startOf('day').toMillis(), weekday: start.weekday, date: start.toISODate()! };
}

/** The 14-day learning period: the first 14 complete local days after the first ping. */
export function learningPeriod(firstPingAt: number, tz: string): Interval {
  const start = DateTime.fromMillis(firstPingAt, { zone: tz }).startOf('day').plus({ days: 1 }).startOf('day');
  return { start: start.toMillis(), end: start.plus({ days: LEARNING_DAYS }).startOf('day').toMillis() };
}

/** The most recent 14 complete local days (used by "recompute baseline"). */
export function recentPeriod(now: number, tz: string): Interval {
  const end = DateTime.fromMillis(now, { zone: tz }).startOf('day');
  return { start: end.minus({ days: LEARNING_DAYS }).startOf('day').toMillis(), end: end.toMillis() };
}

export interface BaselineInput {
  counts: HourCount[];
  period: Interval;
  timezone: string;
  window: ActiveWindow | null;
  gaps: Interval[];
}

export function computeBaseline({ counts, period, timezone: tz, window, gaps }: BaselineInput): Baseline {
  const byHour = new Map(counts.map((c) => [c.hour, c.ok]));
  const dayTotals = new Map<number, number[]>(); // weekday -> totals of each sampled day
  const hourSamples = new Map<string, number[]>(); // "weekday-hour" -> counts
  let days = 0;

  for (let day = localDay(period.start, tz); day.end <= period.end; day = localDay(day.end, tz)) {
    if (day.start < period.start) continue;
    if (gaps.some((g) => overlaps(g, day))) continue; // we were not watching properly that day
    let total = 0;
    let activeHours = 0;
    for (let h = Math.ceil(day.start / HOUR_MS) * HOUR_MS; h < day.end; h += HOUR_MS) {
      if (!isInWindow(h, window, tz)) continue;
      activeHours++;
      const n = byHour.get(h) ?? 0;
      total += n;
      const key = `${day.weekday}-${DateTime.fromMillis(h, { zone: tz }).hour}`;
      let list = hourSamples.get(key);
      if (!list) hourSamples.set(key, (list = []));
      list.push(n);
    }
    if (activeHours === 0) continue; // a day entirely outside the active window
    days++;
    let list = dayTotals.get(day.weekday);
    if (!list) dayTotals.set(day.weekday, (list = []));
    list.push(total);
  }

  const daily: Record<string, number> = {};
  for (const [weekday, totals] of dayTotals) daily[String(weekday)] = Math.round(median(totals));
  const hourly: Record<string, number> = {};
  let sum = 0;
  for (const [key, samples] of hourSamples) {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    hourly[key] = Math.round(mean);
    sum += mean;
  }
  const meanPerActiveHour = hourSamples.size ? sum / hourSamples.size : 0;

  return {
    granularity: meanPerActiveHour >= HOURLY_MIN_MEAN ? 'hourly' : 'daily',
    daily,
    hourly,
    days,
    from: period.start,
    to: period.end,
  };
}

export interface VolumeBucket extends Interval {
  /** Typical count for this bucket, or null when it should not be judged at all. */
  expected: number | null;
  /** e.g. "on a Tuesday" or "between 14:00 and 15:00 on a Tuesday". */
  when: string;
  /** e.g. "Tue 10 Nov" */
  label: string;
}

function bucketContaining(b: Baseline, tz: string, t: number): Interval {
  if (b.granularity === 'daily') return localDay(t, tz);
  const start = Math.floor(t / HOUR_MS) * HOUR_MS;
  return { start, end: start + HOUR_MS };
}

/** The most recent bucket that closed at least SETTLE_MS before `asOf`. */
export function lastClosedBucket(b: Baseline, tz: string, window: ActiveWindow | null, asOf: number): VolumeBucket {
  const current = bucketContaining(b, tz, asOf - SETTLE_MS);
  const { start, end } = bucketContaining(b, tz, current.start - 1);
  const dt = DateTime.fromMillis(start, { zone: tz });
  const dayName = dt.toFormat('cccc');
  if (b.granularity === 'daily') {
    const expected = b.daily[String(dt.weekday)];
    return { start, end, expected: expected ?? null, when: `on a ${dayName}`, label: dt.toFormat('ccc d LLL') };
  }
  const expected = b.hourly[`${dt.weekday}-${dt.hour}`];
  const judged = expected != null && expected >= HOURLY_MIN_EXPECTED && isInWindow(start, window, tz);
  return {
    start,
    end,
    expected: judged ? expected : null,
    when: `between ${dt.toFormat('HH:mm')} and ${dt.plus({ hours: 1 }).toFormat('HH:mm')} on a ${dayName}`,
    label: `${dt.toFormat('ccc d LLL, HH:mm')}–${dt.plus({ hours: 1 }).toFormat('HH:mm')}`,
  };
}

/** When the bucket that is open at `asOf` can be judged. */
export function nextVolumeEvalAt(b: Baseline, tz: string, asOf: number): number {
  return bucketContaining(b, tz, asOf - SETTLE_MS).end + SETTLE_MS;
}

/** Pings counted towards a bucket: only hours inside the active window. */
export function countInBucket(counts: HourCount[], bucket: Interval, window: ActiveWindow | null, tz: string): number {
  let total = 0;
  for (const c of counts) {
    if (c.hour >= bucket.start && c.hour < bucket.end && isInWindow(c.hour, window, tz)) total += c.ok;
  }
  return total;
}

export interface VolumeVerdict {
  /** False when this bucket cannot be judged (nothing is normally expected then). */
  judged: boolean;
  low: boolean;
  /** Alert when the count is below this. */
  threshold: number;
}

/** Below `pct` percent of normal is "low". Anything normally active must at least send one ping. */
export function judgeVolume(expected: number | null, actual: number, pct: number): VolumeVerdict {
  if (expected == null || expected < 1) return { judged: false, low: false, threshold: 0 };
  const threshold = Math.max(1, (expected * pct) / 100);
  return { judged: true, low: actual < threshold, threshold };
}

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Rows for showing a learned baseline to the user: [weekday name, typical count or null]. */
export function baselineRows(b: Baseline): [string, number | null][] {
  return [1, 2, 3, 4, 5, 6, 7].map((d) => [WEEKDAYS[d], b.daily[String(d)] ?? null]);
}
