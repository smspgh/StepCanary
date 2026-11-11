import { describe, expect, it } from 'vitest';
import { composeAlert, describeExpectation, formatDays, formatDuration } from '../src/core/describe';
import { assessHealth } from '../src/core/health';
import { validateCheckForm } from '../src/core/validate';
import { PLANS } from '../src/core/plans';
import { at, intervalCfg, MIN, scheduleCfg } from './helpers';

const now = at('2026-11-10 12:00');
const okPrev = { startedAt: now - MIN, finishedAt: now - MIN + 500, healthy: true };

describe('self-health assessment', () => {
  it('evaluates when the previous run was healthy and the canary is fresh', () => {
    const h = assessHealth({ now, prevRun: okPrev, canaryAt: now - 58_000 });
    expect(h).toMatchObject({ healthy: true, canEvaluate: true, gaps: [], note: 'ok' });
    expect(h.asOf).toBe(now - 58_000); // judge as of the watermark, not the wall clock
  });

  it('does nothing on the very first run', () => {
    const h = assessHealth({ now, prevRun: null, canaryAt: null });
    expect(h).toMatchObject({ healthy: false, canEvaluate: false, gaps: [], asOf: null });
  });

  it('tolerates a single missed minute', () => {
    const h = assessHealth({ now, prevRun: { ...okPrev, startedAt: now - 2 * MIN }, canaryAt: now - 2 * MIN });
    expect(h.canEvaluate).toBe(true);
  });

  it('records a gap when evaluator runs were missed', () => {
    const h = assessHealth({ now, prevRun: { ...okPrev, startedAt: now - 10 * MIN }, canaryAt: now - 30_000 });
    expect(h.canEvaluate).toBe(false);
    expect(h.gaps).toEqual([{ start: now - 10 * MIN, end: now, reason: 'evaluator_missed' }]);
  });

  it('records a gap when the previous run crashed (never finished)', () => {
    const h = assessHealth({ now, prevRun: { ...okPrev, finishedAt: null, healthy: false }, canaryAt: now - 30_000 });
    expect(h.canEvaluate).toBe(false);
    expect(h.gaps[0].reason).toBe('evaluator_error');
  });

  it('records a gap when the ingestion canary is stale or missing', () => {
    const stale = assessHealth({ now, prevRun: okPrev, canaryAt: now - 5 * MIN });
    expect(stale.canEvaluate).toBe(false);
    expect(stale.gaps).toEqual([{ start: now - 5 * MIN, end: now, reason: 'ingest_stalled' }]);
    expect(assessHealth({ now, prevRun: okPrev, canaryAt: null }).gaps[0].reason).toBe('ingest_stalled');
  });

  it('needs two consecutive healthy runs before evaluating again', () => {
    const h = assessHealth({ now, prevRun: { ...okPrev, healthy: false }, canaryAt: now - 30_000 });
    expect(h).toMatchObject({ healthy: true, canEvaluate: false, gaps: [], note: 'warming_up' });
  });
});

describe('plain-English wording', () => {
  it('formats durations and day lists', () => {
    expect(formatDuration(45)).toBe('45 seconds');
    expect(formatDuration(60)).toBe('1 minute');
    expect(formatDuration(5400)).toBe('1 hour 30 minutes');
    expect(formatDuration(86400)).toBe('1 day');
    expect(formatDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(formatDays([1, 3, 6, 7])).toBe('Mon, Wed, Sat, Sun');
    expect(formatDays([1, 2, 3, 4, 5, 6, 7])).toBe('every day');
  });

  it('describes what was expected', () => {
    expect(describeExpectation(intervalCfg())).toBe('at least one ping every 1 hour, with 10 minutes of grace');
    expect(
      describeExpectation(intervalCfg({ timezone: 'Europe/London', activeWindow: { days: [1, 2, 3, 4, 5], start: 540, end: 1080 } })),
    ).toBe('at least one ping every 1 hour, counted only during Mon–Fri, 9:00 AM–6:00 PM (Europe/London), with 10 minutes of grace');
    expect(describeExpectation(scheduleCfg('0 9 * * 1-5', 'UTC'))).toContain('"0 9 * * 1-5" (UTC), within 10 minutes');
  });

  it('writes a down alert that says which automation, what was expected and what happened', () => {
    const msg = composeAlert('down', {
      name: 'New lead → CRM',
      cfg: intervalCfg({ timezone: 'Europe/London' }),
      lastPingAt: now - 70 * MIN,
      at: now,
      reason: 'missed',
      link: 'https://app.test/checks/abc',
    });
    expect(msg.subject).toBe('Down: "New lead → CRM" has stopped checking in');
    expect(msg.body).toContain('at least one ping every 1 hour');
    expect(msg.body).toContain('Tue, Nov 10, 2026, 10:50 AM');
    expect(msg.body).toContain('1 hour 10 minutes earlier');
    expect(msg.link).toBe('https://app.test/checks/abc');
  });

  it('writes recovered and reported-failure alerts', () => {
    const ctx = { name: 'Invoices', cfg: intervalCfg(), lastPingAt: now, at: now, link: 'x' };
    expect(composeAlert('recovered', { ...ctx, openedAt: now - 3 * 3600_000 }).body).toContain('down for about 3 hours');
    expect(composeAlert('down', { ...ctx, reason: 'reported_failure' }).subject).toBe('Down: "Invoices" reported a failure');
  });
});

describe('check form validation', () => {
  const base = { name: 'Lead form', mode: 'interval', interval_value: '2', interval_unit: 'hours', grace_value: '15', grace_unit: 'minutes', timezone: 'Europe/London' };

  it('accepts an interval check', () => {
    const r = validateCheckForm(base, PLANS.free);
    expect(r).toMatchObject({
      ok: true,
      value: {
        name: 'Lead form',
        cfg: { mode: 'interval', intervalSeconds: 7200, cron: null, timezone: 'Europe/London', graceSeconds: 900, activeWindow: null },
        driftEnabled: false,
      },
    });
  });

  it('accepts volume mode and payload drift on Pro, and rejects them on Free', () => {
    const form = { name: 'Orders', mode: 'volume', volume_pct: '40', timezone: 'UTC', drift_enabled: '1' };
    const pro = validateCheckForm(form, PLANS.pro);
    expect(pro.ok && pro.value).toMatchObject({ cfg: { mode: 'volume', volumeThresholdPct: 40, intervalSeconds: null }, driftEnabled: true });
    const free = validateCheckForm(form, PLANS.free);
    expect(!free.ok && free.errors).toHaveLength(2);
    expect(validateCheckForm({ ...form, volume_pct: '150' }, PLANS.pro).ok).toBe(false);
  });

  it('refuses a check with no alert destination, and only offers folders on Agency', () => {
    const none = validateCheckForm({ ...base, channels_shown: '1' }, PLANS.pro);
    expect(!none.ok && none.errors[0]).toContain('at least one place');
    const some = validateCheckForm({ ...base, channels_shown: '1', channel_ids: ['a', 'b'], folder_id: 'f1' }, PLANS.pro);
    expect(some.ok && some.value).toMatchObject({ channelIds: ['a', 'b'], folderId: null });
    const agency = validateCheckForm({ ...base, folder_id: 'f1' }, PLANS.agency);
    expect(agency.ok && agency.value.folderId).toBe('f1');
  });

  it('accepts an active window on Pro and rejects it on Free', () => {
    const form = { ...base, window_enabled: '1', window_days: ['1', '2', '3', '4', '5'], window_start: '09:00', window_end: '18:00' };
    const pro = validateCheckForm(form, PLANS.pro);
    expect(pro.ok && pro.value.cfg.activeWindow).toEqual({ days: [1, 2, 3, 4, 5], start: 540, end: 1080 });
    const free = validateCheckForm(form, PLANS.free);
    expect(!free.ok && free.errors.join(' ')).toContain('Pro plan');
  });

  it('accepts schedules on Pro, and explains bad ones', () => {
    const form = { ...base, mode: 'schedule', cron: '0 9 * * 1-5' };
    const ok = validateCheckForm(form, PLANS.pro);
    expect(ok.ok && ok.value.cfg).toMatchObject({ mode: 'schedule', cron: '0 9 * * 1-5', intervalSeconds: null });
    expect(validateCheckForm(form, PLANS.free).ok).toBe(false);
    expect(validateCheckForm({ ...form, cron: 'every morning' }, PLANS.pro).ok).toBe(false);
    expect(validateCheckForm({ ...form, cron: '0 9 * *' }, PLANS.pro).ok).toBe(false);
    expect(validateCheckForm({ ...form, cron: '* * * * * *' }, PLANS.pro).ok).toBe(false);
  });

  it('rejects bad names, timezones, durations and windows', () => {
    const errs = (over: Record<string, string | string[]>) => {
      const r = validateCheckForm({ ...base, ...over }, PLANS.pro);
      return r.ok ? [] : r.errors;
    };
    expect(errs({ name: '  ' })).toHaveLength(1);
    expect(errs({ timezone: 'Mars/Olympus' })).toHaveLength(1);
    expect(errs({ interval_value: '0' })).toHaveLength(1);
    expect(errs({ interval_value: 'abc' })).toHaveLength(1);
    expect(errs({ grace_value: '500', grace_unit: 'days' })).toHaveLength(1);
    expect(errs({ window_enabled: '1', window_days: [], window_start: '09:00', window_end: '18:00' })).toHaveLength(1);
    expect(errs({ window_enabled: '1', window_days: ['1'], window_start: '18:00', window_end: '09:00' })).toHaveLength(1);
  });
});
