// End-to-end logic tests against a real Postgres (PGlite) with the production schema:
// queue consumer -> evaluator -> incidents -> alert outbox. Time is injected, never read.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendPendingAlerts, type OutboundAlert } from '../src/app/alerts';
import { redeemLoginToken, createLoginToken } from '../src/app/auth';
import { createCheck, getCheck, pauseCheck, resumeCheck } from '../src/app/checks';
import { consumeBatch } from '../src/app/consumer';
import { CANARY_KEY, gapsSince, getState, setState, type Db } from '../src/app/db';
import { runEvaluator } from '../src/app/evaluator';
import { runRetention } from '../src/app/retention';
import { FLAG_MALFORMED, type PingKind, type PingMessage } from '../src/shared/messages';
import { at, HOUR, intervalCfg, MIN, testDb } from './helpers';

const SECRET = 'test-secret';
const CANARY = 'canary-token';
const APP = 'https://app.test';
const T0 = at('2026-11-10 12:00');

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let accountId: string;
let seq = 0;

beforeAll(async () => {
  ({ db, reset, close } = await testDb());
});
afterAll(() => close());
beforeEach(async () => {
  await reset();
  const token = (await createLoginToken(db, 'owner@example.com', T0))!;
  await redeemLoginToken(db, token, T0, 'pro');
  accountId = (await db.query('SELECT id FROM accounts'))[0].id;
});

async function newCheck(cfg = intervalCfg(), name = 'Lead form → CRM') {
  const id = await createCheck(db, accountId, { name, cfg }, SECRET);
  return (await getCheck(db, accountId, id))!;
}
const reload = async (id: string) => (await getCheck(db, accountId, id))!;

function msg(token: string, ts: number, kind: PingKind = 'ok', extra: Partial<PingMessage> = {}): PingMessage {
  return { id: `m${++seq}`, t: token, ts, k: kind, f: 0, ...extra };
}
const consume = (msgs: PingMessage[], now: number) => consumeBatch(db, msgs, now, CANARY, APP);

/** One evaluator minute. By default the canary sent a minute earlier has landed (healthy pipeline). */
async function tick(now: number, opts: { canaryLanded?: boolean } = {}) {
  if (opts.canaryLanded !== false) await setState(db, CANARY_KEY, String(now - MIN));
  return runEvaluator(db, { now, appUrl: APP, sendCanary: async () => {} });
}
/** Run every minute from `from` to `to` inclusive. */
async function run(from: number, to: number, opts: { canaryLanded?: boolean } = {}) {
  for (let t = from; t <= to; t += MIN) await tick(t, opts);
}

const count = async (table: string, where = 'true') => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n as number;

function recorder() {
  const sent: OutboundAlert[] = [];
  return { sent, send: async (_ch: unknown, alert: OutboundAlert) => void sent.push(alert) };
}

describe('consumer', () => {
  it('first ping flips a new check to up and records the detected payload keys', async () => {
    const check = await newCheck();
    expect(check.state.status).toBe('new');
    await consume([msg(check.token, T0, 'ok', { shape: { $: 'object', email: 'string' }, sh: 'abc' })], T0 + 1000);
    const after = await reload(check.id);
    expect(after.state.status).toBe('up');
    expect(after.state.lastPingAt).toBe(T0);
    expect(after.nextEvalAt).toBe(T0 + HOUR);
    expect(after.lastShape).toEqual({ $: 'object', email: 'string' });
    expect(await count('pings')).toBe(1);
  });

  it('counts each ping once even when the queue redelivers a batch', async () => {
    const check = await newCheck();
    const batch = [msg(check.token, T0), msg(check.token, T0 + 1000), msg(check.token, T0 + 2000, 'fail')];
    await consume(batch, T0 + 3000);
    await consume(batch, T0 + 4000);
    await consume([batch[1]], T0 + 5000);
    expect(await count('pings')).toBe(3);
    expect(await db.query('SELECT ok, fail FROM ping_hourly')).toEqual([{ ok: 2, fail: 1 }]);
    expect(await count('incidents')).toBe(1);
    expect(await count('alert_deliveries')).toBe(1);
  });

  it('still counts a malformed-JSON ping as alive, flags the check, and clears the flag on the next good ping', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0, 'ok', { f: FLAG_MALFORMED })], T0);
    let after = await reload(check.id);
    expect(after.state.status).toBe('up');
    expect(after.state.lastPingAt).toBe(T0);
    expect(after.payloadWarning).toBe('malformed');
    await consume([msg(check.token, T0 + MIN)], T0 + MIN);
    after = await reload(check.id);
    expect(after.payloadWarning).toBeNull();
  });

  it('drops pings for unknown tokens and ignores junk messages', async () => {
    const r = await consume([msg('no-such-token', T0), { nonsense: true } as any], T0);
    expect(r.pings).toBe(0);
    expect(await count('pings')).toBe(0);
  });

  it('tracks the canary watermark and never moves it backwards', async () => {
    await consume([msg(CANARY, T0)], T0);
    await consume([msg(CANARY, T0 - MIN)], T0);
    expect(await getState(db, CANARY_KEY)).toBe(String(T0));
  });

  it('records a monitoring gap when a batch lands long after it was received', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0 + 10 * MIN);
    const gaps = await gapsSince(db, 0);
    expect(gaps).toEqual([{ startedAt: T0, endedAt: T0 + 10 * MIN, reason: 'ingest_delay' }]);
  });

  it('an explicit /fail takes the check down and a later success recovers it', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await consume([msg(check.token, T0 + MIN, 'fail')], T0 + MIN);
    expect((await reload(check.id)).state.status).toBe('down');
    await consume([msg(check.token, T0 + 2 * MIN)], T0 + 2 * MIN);
    expect((await reload(check.id)).state.status).toBe('up');
    const events = (await db.query('SELECT event FROM alert_deliveries ORDER BY created_at, event')).map((r) => r.event).sort();
    expect(events).toEqual(['down', 'recovered']);
    expect(await count('incidents', 'resolved_at IS NULL')).toBe(0);
  });
});

describe('evaluator', () => {
  it('walks a silent check through up -> late -> down and raises exactly one incident', async () => {
    const check = await newCheck(); // every hour, 10 min grace
    await consume([msg(check.token, T0)], T0);

    await run(T0, T0 + 60 * MIN);
    expect((await reload(check.id)).state.status).toBe('up'); // watermark is a minute behind
    await run(T0 + 61 * MIN, T0 + 62 * MIN);
    expect((await reload(check.id)).state.status).toBe('late');
    expect(await count('incidents')).toBe(0);

    await run(T0 + 63 * MIN, T0 + 75 * MIN);
    expect((await reload(check.id)).state.status).toBe('down');
    await run(T0 + 76 * MIN, T0 + 180 * MIN); // stays down; no repeats
    expect(await count('incidents')).toBe(1);
    expect(await count('alert_deliveries')).toBe(1);
    const d = (await db.query('SELECT subject, body, link, event FROM alert_deliveries'))[0];
    expect(d.event).toBe('down');
    expect(d.subject).toBe('Down: "Lead form → CRM" has stopped checking in');
    expect(d.body).toContain('at least one ping every 1 hour');
    expect(d.link).toBe(`${APP}/checks/${check.id}`);
  });

  it('never alerts for a check that has not sent its first ping', async () => {
    const check = await newCheck();
    await run(T0, T0 + 5 * HOUR);
    expect((await reload(check.id)).state.status).toBe('new');
    expect(await count('incidents')).toBe(0);
  });

  it('does not alert for paused checks, and resume restarts the clock', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await pauseCheck(db, await reload(check.id), T0 + MIN);
    await run(T0, T0 + 3 * HOUR);
    expect(await count('incidents')).toBe(0);

    await resumeCheck(db, await reload(check.id), T0 + 3 * HOUR);
    const resumed = await reload(check.id);
    expect(resumed.state.status).toBe('up');
    expect(resumed.nextEvalAt).toBe(T0 + 4 * HOUR); // a full interval from the resume, not from the old ping
  });

  it('is a no-op when invoked twice for the same minute', async () => {
    await tick(T0);
    const second = await tick(T0 + 5000);
    expect(second.ran).toBe(false);
    expect(await count('evaluator_runs')).toBe(1);
  });

  it('recovers with exactly one "recovered" alert when pings resume', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await run(T0, T0 + 80 * MIN);
    expect((await reload(check.id)).state.status).toBe('down');

    await consume([msg(check.token, T0 + 81 * MIN), msg(check.token, T0 + 81 * MIN + 5)], T0 + 81 * MIN);
    await consume([msg(check.token, T0 + 82 * MIN)], T0 + 82 * MIN);
    expect((await reload(check.id)).state.status).toBe('up');
    expect(await count('alert_deliveries', "event = 'recovered'")).toBe(1);
    expect(await count('alert_deliveries')).toBe(2);
    expect(await count('incidents', 'resolved_at IS NOT NULL')).toBe(1);
  });

  it('a second outage after a recovery is a new incident with its own alert', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await run(T0, T0 + 80 * MIN);
    await consume([msg(check.token, T0 + 81 * MIN)], T0 + 81 * MIN);
    await run(T0 + 81 * MIN, T0 + 81 * MIN + 80 * MIN);
    expect(await count('incidents')).toBe(2);
    expect(await count('alert_deliveries', "event = 'down'")).toBe(2);
  });

  it('respects active windows end to end: quiet over the weekend, down on Monday morning', async () => {
    const LON = 'Europe/London';
    const check = await newCheck(
      intervalCfg({ intervalSeconds: 7200, graceSeconds: 900, timezone: LON, activeWindow: { days: [1, 2, 3, 4, 5], start: 540, end: 1080 } }),
    );
    const friday = at('2026-11-13 17:30', LON);
    await consume([msg(check.token, friday)], friday);
    expect((await reload(check.id)).nextEvalAt).toBe(at('2026-11-16 10:30', LON));

    // Sample the weekend hourly (each sample is two consecutive healthy minutes).
    await tick(friday);
    // Pretend the evaluator ran healthily the minute before `t`, so sampling is not itself a "gap".
    const seedPreviousRun = async (t: number) => {
      await db.query('DELETE FROM evaluator_runs');
      await db.query(`INSERT INTO evaluator_runs (minute, started_at, finished_at, healthy) VALUES ($1, $2::timestamptz, $2::timestamptz, true)`, [
        Math.floor((t - MIN) / MIN),
        new Date(t - MIN).toISOString(),
      ]);
    };
    for (let t = friday + HOUR; t < at('2026-11-16 09:00', LON); t += HOUR) {
      await seedPreviousRun(t);
      await tick(t);
    }
    expect((await reload(check.id)).state.status).toBe('up');
    expect(await count('incidents')).toBe(0);
    expect(await count('monitoring_gaps')).toBe(0);

    await seedPreviousRun(at('2026-11-16 09:00', LON));
    await run(at('2026-11-16 09:00', LON), at('2026-11-16 10:50', LON));
    expect(await count('monitoring_gaps')).toBe(0);
    expect((await reload(check.id)).state.status).toBe('down');
    expect(await count('incidents')).toBe(1);
  });
});

describe('monitoring-gap suppression (no false alarms when WE are broken)', () => {
  it('sends no "down" while the ingestion canary is stale, and records the gap', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await run(T0, T0 + 30 * MIN); // healthy

    // Our pipeline stalls for 2 hours: the customer's pings (and our canary) are not landing.
    await run(T0 + 31 * MIN, T0 + 150 * MIN, { canaryLanded: false });
    expect((await reload(check.id)).state.status).toBe('up');
    expect(await count('incidents')).toBe(0);
    const gaps = await gapsSince(db, 0);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].reason).toBe('ingest_stalled');
    expect(gaps[0].endedAt).toBe(T0 + 150 * MIN);
  });

  it('restarts the clock when the gap ends: silence is only judged from then on', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await run(T0, T0 + 30 * MIN);
    await run(T0 + 31 * MIN, T0 + 150 * MIN, { canaryLanded: false });
    const gapEnd = T0 + 150 * MIN;

    // Healthy again. The check is well past its original deadline but must not go down yet.
    await run(gapEnd + MIN, gapEnd + 55 * MIN);
    expect((await reload(check.id)).state.status).toBe('up');
    expect(await count('incidents')).toBe(0);

    // A full interval + grace of healthy monitoring after the gap with no ping: now it is real.
    await run(gapEnd + 56 * MIN, gapEnd + 75 * MIN);
    expect((await reload(check.id)).state.status).toBe('down');
    expect(await count('incidents')).toBe(1);
  });

  it('suppresses alerts after the evaluator itself missed runs', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await run(T0, T0 + 30 * MIN);

    // Cron did not fire for 3 hours. When it comes back the check is "overdue" on paper.
    const back = T0 + 30 * MIN + 3 * HOUR;
    const first = await tick(back);
    expect(first.health!.canEvaluate).toBe(false);
    expect(first.health!.note).toContain('evaluator_missed');
    await run(back + MIN, back + 10 * MIN);
    expect((await reload(check.id)).state.status).toBe('up');
    expect(await count('incidents')).toBe(0);
    expect((await gapsSince(db, 0))[0]).toMatchObject({ startedAt: T0 + 30 * MIN, endedAt: back, reason: 'evaluator_missed' });
  });

  it('treats a crashed previous run as a gap', async () => {
    await run(T0, T0 + 5 * MIN);
    // Simulate a run that started but never finished (database error mid-run).
    await db.query(`INSERT INTO evaluator_runs (minute, started_at) VALUES ($1, $2::timestamptz)`, [
      Math.floor((T0 + 6 * MIN) / MIN),
      new Date(T0 + 6 * MIN).toISOString(),
    ]);
    const next = await tick(T0 + 7 * MIN);
    expect(next.health!.note).toContain('evaluator_error');
    expect(next.health!.canEvaluate).toBe(false);
    expect(await count('monitoring_gaps')).toBe(1);
  });

  it('does not evaluate on the first run after a fresh deploy', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0 - 5 * HOUR)], T0 - 5 * HOUR);
    const first = await tick(T0);
    expect(first.health!.note).toBe('first_run');
    expect(first.evaluated).toBe(0);
    expect(await count('incidents')).toBe(0);
  });

  it('one broken check does not stop the others from being evaluated', async () => {
    const good = await newCheck(intervalCfg(), 'good');
    const broken = await newCheck(intervalCfg(), 'broken');
    await consume([msg(good.token, T0), msg(broken.token, T0)], T0);
    await db.query(`UPDATE checks SET mode = 'schedule', cron = 'not a cron' WHERE id = $1`, [broken.id]);
    await run(T0, T0 + 80 * MIN);
    expect((await reload(good.id)).state.status).toBe('down');
    const lastRun = (await db.query('SELECT errors, finished_at FROM evaluator_runs ORDER BY minute DESC LIMIT 1'))[0];
    expect(lastRun.errors).toBe(1);
    expect(lastRun.finished_at).not.toBeNull();
  });
});

describe('alert idempotency', () => {
  async function downCheck() {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await run(T0, T0 + 80 * MIN);
    return check;
  }

  it('sends each alert once, however often the sender runs', async () => {
    await downCheck();
    const r = recorder();
    const now = T0 + 81 * MIN;
    expect(await sendPendingAlerts(db, r.send, now)).toEqual({ sent: 1, failed: 0 });
    expect(await sendPendingAlerts(db, r.send, now + MIN)).toEqual({ sent: 0, failed: 0 });
    expect(await sendPendingAlerts(db, r.send, now + HOUR)).toEqual({ sent: 0, failed: 0 });
    expect(r.sent).toHaveLength(1);
    expect(await count('alert_deliveries', "status = 'sent'")).toBe(1);
  });

  it('sends once when two senders race', async () => {
    await downCheck();
    const r = recorder();
    const now = T0 + 81 * MIN;
    await Promise.all([sendPendingAlerts(db, r.send, now), sendPendingAlerts(db, r.send, now), sendPendingAlerts(db, r.send, now)]);
    expect(r.sent).toHaveLength(1);
  });

  it('cannot create a second open incident or a duplicate delivery, even by direct insert', async () => {
    const check = await downCheck();
    await expect(
      db.query(`INSERT INTO incidents (id, check_id, kind, reason, opened_at) VALUES ('dup', $1, 'down', 'missed', now())`, [check.id]),
    ).rejects.toThrow();
    const d = (await db.query('SELECT incident_id, channel_id FROM alert_deliveries'))[0];
    await expect(
      db.query(
        `INSERT INTO alert_deliveries (id, incident_id, event, channel_id, next_attempt_at, subject, body, link) VALUES ('dup', $1, 'down', $2, now(), 's', 'b', 'l')`,
        [d.incident_id, d.channel_id],
      ),
    ).rejects.toThrow();
  });

  it('retries a failed send with backoff, using the same idempotency key', async () => {
    await downCheck();
    const now = T0 + 81 * MIN;
    const keys: string[] = [];
    let fail = true;
    const send = async (_c: unknown, a: OutboundAlert) => {
      keys.push(a.idempotencyKey);
      if (fail) throw new Error('provider 500');
    };
    expect(await sendPendingAlerts(db, send, now)).toEqual({ sent: 0, failed: 1 });
    expect(await sendPendingAlerts(db, send, now + 10_000)).toEqual({ sent: 0, failed: 0 }); // backing off
    fail = false;
    expect(await sendPendingAlerts(db, send, now + 2 * MIN)).toEqual({ sent: 1, failed: 0 });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect((await db.query('SELECT status, attempts FROM alert_deliveries'))[0]).toEqual({ status: 'sent', attempts: 2 });
  });

  it('re-claims a delivery whose sender crashed mid-send', async () => {
    await downCheck();
    const now = T0 + 81 * MIN;
    await db.query(`UPDATE alert_deliveries SET status = 'sending', claimed_at = $1::timestamptz, attempts = 1`, [new Date(now).toISOString()]);
    const r = recorder();
    expect((await sendPendingAlerts(db, r.send, now + 2 * MIN)).sent).toBe(0); // lease still held
    expect((await sendPendingAlerts(db, r.send, now + 6 * MIN)).sent).toBe(1);
  });

  it('sends "down" before "recovered" when both are waiting', async () => {
    const check = await downCheck();
    await consume([msg(check.token, T0 + 81 * MIN)], T0 + 81 * MIN);
    const r = recorder();
    await sendPendingAlerts(db, r.send, T0 + 82 * MIN);
    expect(r.sent.map((a) => a.subject.split(':')[0])).toEqual(['Down', 'Recovered']);
  });
});

describe('retention', () => {
  it('rolls hourly counts into daily counts and deletes data past its retention', async () => {
    const check = await newCheck();
    const now = at('2026-11-10 03:00');
    const old = now - 40 * 86_400_000;
    const yesterday = now - 86_400_000;
    await consume([msg(check.token, old)], old);
    await consume([msg(check.token, yesterday), msg(check.token, yesterday + 1000), msg(check.token, yesterday + 2000, 'fail')], yesterday);
    await db.query(`INSERT INTO ping_daily (check_id, day, ok, fail) VALUES ($1, '2025-01-01', 5, 0)`, [check.id]);
    await db.query('DELETE FROM monitoring_gaps');

    await runRetention(db, now);
    await runRetention(db, now); // idempotent

    expect(await count('pings')).toBe(3);
    expect(await count('ping_hourly')).toBe(1);
    const daily = await db.query(`SELECT day::text AS day, ok, fail FROM ping_daily ORDER BY day`);
    expect(daily).toEqual([{ day: '2026-11-09', ok: 2, fail: 1 }]);
  });
});
