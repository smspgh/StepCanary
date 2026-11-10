import { describe, expect, it } from 'vitest';
import { addMonitored, isInWindow, monitoredBetween, type ActiveWindow } from '../src/core/window';
import { at, HOUR, MIN } from './helpers';

const weekdays9to6: ActiveWindow = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60 };
const everyDay = (start: number, end: number): ActiveWindow => ({ days: [1, 2, 3, 4, 5, 6, 7], start, end });
const LON = 'Europe/London';
const NY = 'America/New_York';

describe('active windows', () => {
  it('knows whether an instant is inside the window', () => {
    expect(isInWindow(at('2026-11-10 09:00', LON), weekdays9to6, LON)).toBe(true); // Tuesday
    expect(isInWindow(at('2026-11-10 08:59', LON), weekdays9to6, LON)).toBe(false);
    expect(isInWindow(at('2026-11-10 18:00', LON), weekdays9to6, LON)).toBe(false); // end is exclusive
    expect(isInWindow(at('2026-11-14 12:00', LON), weekdays9to6, LON)).toBe(false); // Saturday
    expect(isInWindow(at('2026-11-14 12:00', LON), null, LON)).toBe(true);
  });

  it('uses the check timezone, not UTC', () => {
    // 09:30 in New York is 14:30 UTC: inside for NY, and for a UTC window too; 22:30 UTC is 17:30 NY.
    expect(isInWindow(at('2026-11-10 22:30', 'UTC'), weekdays9to6, NY)).toBe(true);
    expect(isInWindow(at('2026-11-10 22:30', 'UTC'), weekdays9to6, 'UTC')).toBe(false);
  });

  it('pauses the clock overnight and across the weekend', () => {
    const fri = at('2026-11-13 17:30', LON);
    const mon = at('2026-11-16 10:00', LON);
    expect(monitoredBetween(fri, mon, weekdays9to6, LON)).toBe(30 * MIN + 60 * MIN);
    // 2 hours of monitored time after Friday 17:30 lands on Monday 10:30.
    expect(addMonitored(fri, 2 * HOUR, weekdays9to6, LON)).toBe(at('2026-11-16 10:30', LON));
  });

  it('starts counting at the next window when the clock starts outside it', () => {
    const saturday = at('2026-11-14 03:00', LON);
    expect(addMonitored(saturday, 15 * MIN, weekdays9to6, LON)).toBe(at('2026-11-16 09:15', LON));
    expect(monitoredBetween(saturday, at('2026-11-15 23:00', LON), weekdays9to6, LON)).toBe(0);
  });

  it('is plain arithmetic without a window', () => {
    expect(addMonitored(1000, 500, null, 'UTC')).toBe(1500);
    expect(monitoredBetween(1000, 4000, null, 'UTC')).toBe(3000);
    expect(monitoredBetween(4000, 1000, null, 'UTC')).toBe(0);
  });

  it('keeps wall-clock hours across the spring DST change (London, 29 Mar 2026)', () => {
    // Friday 27 Mar 17:30 GMT -> Monday 30 Mar 09:30 BST. The window opens at 09:00 local, i.e. 08:00 UTC.
    const fri = at('2026-03-27 17:30', LON);
    const due = addMonitored(fri, HOUR, weekdays9to6, LON);
    expect(due).toBe(at('2026-03-30 09:30', LON));
    expect(new Date(due).toISOString()).toBe('2026-03-30T08:30:00.000Z');
  });

  it('counts real elapsed time on a 23-hour day (New York, 8 Mar 2026)', () => {
    const all = everyDay(0, 1440);
    const dayStart = at('2026-03-08 00:00', NY);
    const dayEnd = at('2026-03-09 00:00', NY);
    expect(monitoredBetween(dayStart, dayEnd, all, NY)).toBe(23 * HOUR);
    // 01:00-04:00 on the wall clock is only 2 real hours because 02:00-03:00 does not exist.
    expect(monitoredBetween(dayStart, dayEnd, everyDay(60, 240), NY)).toBe(2 * HOUR);
  });

  it('counts real elapsed time on a 25-hour day (New York, 1 Nov 2026)', () => {
    const dayStart = at('2026-11-01 00:00', NY);
    const dayEnd = at('2026-11-02 00:00', NY);
    expect(monitoredBetween(dayStart, dayEnd, everyDay(0, 1440), NY)).toBe(25 * HOUR);
    // 01:00-03:00 on the wall clock is 3 real hours because 01:00-02:00 happens twice.
    expect(monitoredBetween(dayStart, dayEnd, everyDay(60, 180), NY)).toBe(3 * HOUR);
  });

  it('addMonitored and monitoredBetween agree', () => {
    const from = at('2026-03-06 16:45', NY); // Friday before the DST weekend
    for (const minutes of [1, 30, 75, 600, 1500]) {
      const due = addMonitored(from, minutes * MIN, weekdays9to6, NY);
      expect(monitoredBetween(from, due, weekdays9to6, NY)).toBe(minutes * MIN);
    }
  });

  it('gives up (Infinity) rather than loop forever on a window that never opens', () => {
    expect(addMonitored(0, HOUR, { days: [], start: 0, end: 60 }, 'UTC')).toBe(Infinity);
  });
});
