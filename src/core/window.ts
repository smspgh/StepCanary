// Active windows: "only expect pings Mon-Fri 09:00-18:00 in this timezone".
// Outside the window the evaluation clock is paused. All arithmetic is done on wall-clock
// times in the check's timezone, so DST changes shorten or lengthen a day's window correctly.

import { DateTime } from 'luxon';

export interface ActiveWindow {
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** Minutes after local midnight; 0 <= start < end <= 1440. */
  start: number;
  end: number;
}

const MAX_DAYS_AHEAD = 800;

function atMinutes(day: DateTime, minutes: number): number {
  if (minutes >= 1440) return day.plus({ days: 1 }).startOf('day').toMillis();
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 }).toMillis();
}

/** Active periods [start, end) at or after `from`, in order. */
function* periods(from: number, w: ActiveWindow, tz: string): Generator<[number, number]> {
  let day = DateTime.fromMillis(from, { zone: tz }).startOf('day');
  for (let i = 0; i < MAX_DAYS_AHEAD; i++) {
    if (w.days.includes(day.weekday)) {
      const start = atMinutes(day, w.start);
      const end = atMinutes(day, w.end);
      if (end > from && end > start) yield [Math.max(start, from), end];
    }
    day = day.plus({ days: 1 }).startOf('day');
  }
}

export function isInWindow(t: number, w: ActiveWindow | null, tz: string): boolean {
  if (!w) return true;
  for (const [start, end] of periods(t, w, tz)) return start <= t && t < end;
  return false;
}

/** Milliseconds of monitored (in-window) time between two instants. */
export function monitoredBetween(from: number, to: number, w: ActiveWindow | null, tz: string): number {
  if (to <= from) return 0;
  if (!w) return to - from;
  let total = 0;
  for (const [start, end] of periods(from, w, tz)) {
    if (start >= to) break;
    total += Math.min(end, to) - start;
  }
  return total;
}

/**
 * The instant at which `duration` ms of monitored time has passed since `from`.
 * Returns Infinity if the window never accumulates that much time.
 */
export function addMonitored(from: number, duration: number, w: ActiveWindow | null, tz: string): number {
  if (!w) return from + duration;
  let remaining = duration;
  for (const [start, end] of periods(from, w, tz)) {
    const span = end - start;
    if (remaining <= span) return start + remaining;
    remaining -= span;
  }
  return Infinity;
}
