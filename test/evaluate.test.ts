import { describe, expect, it } from 'vitest';
import { applyEvents, computeDeadlines, evaluate, scheduleNextEval } from '../src/core/evaluate';
import { at, HOUR, intervalCfg, MIN, scheduleCfg, state } from './helpers';

const iso = (t: number) => new Date(t).toISOString();

describe('interval mode', () => {
  const cfg = intervalCfg(); // every 1 hour, 10 minutes grace
  const T = at('2026-11-10 12:00');

  it('is up, then late at the deadline, then down after grace', () => {
    const s = state({ lastPingAt: T });
    expect(evaluate(cfg, s, T + 59 * MIN, null)!.status).toBe('up');
    expect(evaluate(cfg, s, T + 60 * MIN, null)!.status).toBe('late');
    expect(evaluate(cfg, s, T + 69 * MIN, null)!.status).toBe('late');
    expect(evaluate(cfg, s, T + 70 * MIN, null)!.status).toBe('down');
  });

  it('schedules the next look at the deadline, then at the end of grace', () => {
    expect(evaluate(cfg, state({ lastPingAt: T }), T + MIN, null)!.nextEvalAt).toBe(T + 60 * MIN);
    expect(evaluate(cfg, state({ lastPingAt: T, status: 'late' }), T + 61 * MIN, null)!.nextEvalAt).toBe(T + 70 * MIN);
    expect(evaluate(cfg, state({ lastPingAt: T }), T + 2 * HOUR, null)!.nextEvalAt).toBeNull();
  });

  it('never evaluates new, paused or already-down checks', () => {
    const longAgo = T - 30 * 24 * HOUR;
    expect(evaluate(cfg, state({ status: 'new' }), T, null)).toBeNull();
    expect(evaluate(cfg, state({ status: 'new', clockResetAt: longAgo }), T, null)).toBeNull();
    expect(evaluate(cfg, state({ status: 'paused', lastPingAt: longAgo }), T, null)).toBeNull();
    expect(evaluate(cfg, state({ status: 'down', lastPingAt: longAgo }), T, null)).toBeNull();
  });

  it('counts from a manual reset (resume / settings change) when that is later than the last ping', () => {
    const s = state({ lastPingAt: T - 5 * HOUR, clockResetAt: T });
    expect(evaluate(cfg, s, T + 30 * MIN, null)!.status).toBe('up');
    expect(evaluate(cfg, s, T + 70 * MIN, null)!.status).toBe('down');
  });
});

describe('interval mode with an active window', () => {
  const LON = 'Europe/London';
  const cfg = intervalCfg({
    intervalSeconds: 2 * 3600,
    graceSeconds: 900,
    timezone: LON,
    activeWindow: { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60 },
  });
  const friday = at('2026-11-13 17:30', LON);
  const s = state({ lastPingAt: friday });

  it('does not alert over the weekend for a business-hours automation', () => {
    expect(evaluate(cfg, s, at('2026-11-14 12:00', LON), null)!.status).toBe('up'); // Saturday
    expect(evaluate(cfg, s, at('2026-11-15 23:59', LON), null)!.status).toBe('up'); // Sunday
    expect(evaluate(cfg, s, at('2026-11-16 09:05', LON), null)!.status).toBe('up'); // Monday, 35 min counted
  });

  it('resumes the timer on Monday morning: late at 10:30, down at 10:45', () => {
    const d = computeDeadlines(cfg, friday);
    expect(d.lateAt).toBe(at('2026-11-16 10:30', LON));
    expect(d.downAt).toBe(at('2026-11-16 10:45', LON));
    expect(evaluate(cfg, s, at('2026-11-16 10:30', LON), null)!.status).toBe('late');
    expect(evaluate(cfg, s, at('2026-11-16 10:45', LON), null)!.status).toBe('down');
  });

  it('lets the grace period spill into the next day rather than ending at closing time', () => {
    // Ping Monday 16:00; 2h interval is used up at 18:00 closing; 15 min grace runs Tuesday 09:00-09:15.
    const d = computeDeadlines(cfg, at('2026-11-16 16:00', LON));
    expect(d.lateAt).toBe(at('2026-11-16 18:00', LON));
    expect(d.downAt).toBe(at('2026-11-17 09:15', LON));
  });
});

describe('schedule mode', () => {
  it('expects the next scheduled time after the last ping, plus grace', () => {
    const cfg = scheduleCfg('0 9 * * 1-5', 'Europe/London', 600);
    const s = state({ lastPingAt: at('2026-11-06 09:02', 'Europe/London') }); // Friday
    const d = evaluate(cfg, s, at('2026-11-07 12:00', 'Europe/London'), null)!;
    expect(d.status).toBe('up'); // Saturday: nothing scheduled
    expect(d.deadlines.lateAt).toBe(at('2026-11-09 09:00', 'Europe/London')); // Monday
    expect(evaluate(cfg, s, at('2026-11-09 09:05', 'Europe/London'), null)!.status).toBe('late');
    expect(evaluate(cfg, s, at('2026-11-09 09:10', 'Europe/London'), null)!.status).toBe('down');
  });

  it('interprets the schedule in the check timezone', () => {
    const ping = at('2026-11-10 00:00', 'UTC');
    // Midnight UTC is exactly 09:00 in Tokyo, so that run is satisfied; the next is a day later.
    expect(iso(computeDeadlines(scheduleCfg('0 9 * * *', 'Asia/Tokyo'), ping).lateAt)).toBe('2026-11-11T00:00:00.000Z');
    expect(iso(computeDeadlines(scheduleCfg('0 9 * * *', 'America/Los_Angeles'), ping).lateAt)).toBe('2026-11-10T17:00:00.000Z');
    expect(iso(computeDeadlines(scheduleCfg('0 9 * * *', 'UTC'), ping).lateAt)).toBe('2026-11-10T09:00:00.000Z');
  });

  it('follows the wall clock across the spring DST change (London)', () => {
    const cfg = scheduleCfg('0 9 * * *', 'Europe/London');
    // Saturday 28 Mar is GMT (09:00 = 09:00Z); Sunday 29 Mar is BST (09:00 = 08:00Z).
    const d = computeDeadlines(cfg, at('2026-03-28 09:02', 'Europe/London'));
    expect(iso(d.lateAt)).toBe('2026-03-29T08:00:00.000Z');
  });

  it('expects a time that falls in the skipped spring hour shortly after the jump, not never (New York)', () => {
    const cfg = scheduleCfg('30 2 * * *', 'America/New_York');
    // 02:30 does not exist on 8 Mar 2026; the run is expected at 03:00 EDT instead.
    const d = computeDeadlines(cfg, at('2026-03-07 02:31', 'America/New_York'));
    expect(iso(d.lateAt)).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(computeDeadlines(cfg, d.lateAt).lateAt)).toBe('2026-03-09T06:30:00.000Z');
  });

  it('expects a time in the repeated fall hour only once (New York)', () => {
    const cfg = scheduleCfg('30 1 * * *', 'America/New_York');
    // 01:30 happens twice on 1 Nov 2026. One ping satisfies the day.
    const first = computeDeadlines(cfg, at('2026-10-31 01:31', 'America/New_York')).lateAt;
    expect(iso(first)).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    const afterPing = computeDeadlines(cfg, first + 2 * MIN).lateAt;
    expect(iso(afterPing)).toBe('2026-11-02T06:30:00.000Z'); // next day 01:30 EST, not the repeat
  });

  it('accepts a ping that arrives slightly early for its scheduled time', () => {
    const cfg = scheduleCfg('0 9 * * *', 'UTC');
    const thirtySecondsEarly = at('2026-11-10 08:59') + 30_000;
    expect(iso(computeDeadlines(cfg, thirtySecondsEarly).lateAt)).toBe('2026-11-11T09:00:00.000Z');
    // ...but a ping 5 minutes early does not excuse the scheduled run.
    expect(iso(computeDeadlines(cfg, at('2026-11-10 08:55')).lateAt)).toBe('2026-11-10T09:00:00.000Z');
  });
});

describe('monitoring gaps restart the clock (pure part)', () => {
  const cfg = intervalCfg();
  const T = at('2026-11-10 12:00');

  it('does not call a check down for silence that overlaps a gap on our side', () => {
    const s = state({ lastPingAt: T });
    const gapEnd = T + 50 * MIN;
    expect(evaluate(cfg, s, T + 75 * MIN, null)!.status).toBe('down'); // without the gap
    const d = evaluate(cfg, s, T + 75 * MIN, gapEnd)!;
    expect(d.status).toBe('up');
    expect(d.gapAffected).toBe(true);
    expect(d.nextEvalAt).toBe(gapEnd + 60 * MIN);
  });

  it('still catches a check that stays silent for a full interval after the gap', () => {
    const s = state({ lastPingAt: T });
    const gapEnd = T + 50 * MIN;
    expect(evaluate(cfg, s, gapEnd + 60 * MIN, gapEnd)!.status).toBe('late');
    expect(evaluate(cfg, s, gapEnd + 70 * MIN, gapEnd)!.status).toBe('down');
  });

  it('ignores gaps that ended before the last ping', () => {
    const d = evaluate(cfg, state({ lastPingAt: T }), T + 75 * MIN, T - 5 * MIN)!;
    expect(d.status).toBe('down');
    expect(d.gapAffected).toBe(false);
  });

  it('skips a scheduled run whose window overlapped a gap', () => {
    const sched = scheduleCfg('0 9 * * *', 'UTC', 600);
    const s = state({ lastPingAt: at('2026-11-09 09:01') });
    // Our outage covered 08:50-09:20 on the 10th. The 09:00 run cannot be judged.
    const gapEnd = at('2026-11-10 09:20');
    const d = evaluate(sched, s, at('2026-11-10 09:30'), gapEnd)!;
    expect(d.status).toBe('up');
    expect(d.deadlines.lateAt).toBe(at('2026-11-11 09:00'));
  });

  it('a gap never resurrects monitoring for a check that has not pinged yet', () => {
    expect(evaluate(cfg, state({ status: 'new' }), T, T - MIN)).toBeNull();
    expect(scheduleNextEval(cfg, state({ status: 'new' }), T)).toBeNull();
  });
});

describe('applying pings', () => {
  const cfg = intervalCfg();
  const T = at('2026-11-10 12:00');

  it('first ping moves a new check to up and schedules its first deadline', () => {
    const r = applyEvents(cfg, state({ status: 'new' }), [{ ts: T, kind: 'ok' }], null);
    expect(r.state.status).toBe('up');
    expect(r.state.lastPingAt).toBe(T);
    expect(r.nextEvalAt).toBe(T + HOUR);
    expect(r.effects).toEqual([]);
  });

  it('a ping recovers a down check', () => {
    const r = applyEvents(cfg, state({ status: 'down', lastPingAt: T - 5 * HOUR }), [{ ts: T, kind: 'ok' }], null);
    expect(r.state.status).toBe('up');
    expect(r.effects).toEqual([{ type: 'resolve', at: T }]);
  });

  it('a late check that pings goes back to up without any alert', () => {
    const r = applyEvents(cfg, state({ status: 'late', lastPingAt: T - 65 * MIN }), [{ ts: T, kind: 'ok' }], null);
    expect(r.state.status).toBe('up');
    expect(r.effects).toEqual([]);
  });

  it('an explicit failure takes the check down once', () => {
    const r = applyEvents(cfg, state({ lastPingAt: T - MIN }), [{ ts: T, kind: 'fail' }, { ts: T + 1000, kind: 'fail' }], null);
    expect(r.state.status).toBe('down');
    expect(r.state.lastFailAt).toBe(T + 1000);
    expect(r.effects).toEqual([{ type: 'open', at: T, reason: 'reported_failure' }]);
    expect(r.nextEvalAt).toBeNull();
  });

  it('start pings are recorded but change nothing', () => {
    const r = applyEvents(cfg, state({ status: 'new' }), [{ ts: T, kind: 'start' }], null);
    expect(r.state.status).toBe('new');
    expect(r.state.lastStartAt).toBe(T);
    expect(r.effects).toEqual([]);
  });

  it('paused checks record the ping but stay paused and silent', () => {
    const r = applyEvents(cfg, state({ status: 'paused' }), [{ ts: T, kind: 'ok' }, { ts: T + 1, kind: 'fail' }], null);
    expect(r.state.status).toBe('paused');
    expect(r.state.lastPingAt).toBe(T);
    expect(r.effects).toEqual([]);
    expect(r.nextEvalAt).toBeNull();
  });

  it('an older success delivered late cannot hide a newer failure', () => {
    const r = applyEvents(cfg, state({ status: 'down', lastFailAt: T }), [{ ts: T - MIN, kind: 'ok' }], null);
    expect(r.state.status).toBe('down');
    expect(r.effects).toEqual([]);
  });

  it('handles events out of order within one batch', () => {
    const r = applyEvents(cfg, state({ status: 'new' }), [{ ts: T + 2000, kind: 'ok' }, { ts: T, kind: 'fail' }], null);
    expect(r.state.status).toBe('up');
    expect(r.effects.map((e) => e.type)).toEqual(['open', 'resolve']);
  });
});
