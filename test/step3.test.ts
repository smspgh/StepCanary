// Step 3 behaviour against a real Postgres (PGlite): runaway loops, payload drift, volume
// baselines, alert channels, weekly summaries and billing.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendPendingAlerts, type OutboundAlert } from '../src/app/alerts';
import { createLoginToken, redeemLoginToken } from '../src/app/auth';
import { applyPlan, handleStripeEvent, planFromSubscription, verifyStripeSignature, type BillingEnv } from '../src/app/billing';
import { addChannel, listChannels, validateChannelUrl } from '../src/app/channels';
import { acceptDrift, createCheck, enableBaseline, getCheck, markDriftOptional, updateCheck } from '../src/app/checks';
import { consumeBatch } from '../src/app/consumer';
import { CANARY_KEY, recordGap, setState, type Db } from '../src/app/db';
import { evaluateVolume, runEvaluator, RUNAWAY_QUIET_MS } from '../src/app/evaluator';
import { createFolder, runWeeklySummaries } from '../src/app/folders';
import { buildWebhookRequest, makeSender } from '../src/app/sender';
import type { Email } from '../src/app/email';
import type { CheckConfig } from '../src/core/evaluate';
import { composeWeeklySummary, summaryWeek, uptimePercent } from '../src/core/summary';
import { handlePing, type IngestEnv, type Limiter } from '../src/ingest/index';
import { decryptSecret, encryptSecret } from '../src/shared/crypto';
import { shapeOf } from '../src/shared/fingerprint';
import { FLAG_THROTTLED, type PingKind, type PingMessage } from '../src/shared/messages';
import { makeToken } from '../src/shared/token';
import { at, HOUR, intervalCfg, MIN, testDb } from './helpers';

const SECRET = 'test-secret';
const KEY = 'channel-key-for-tests';
const APP = 'https://app.test';
const DAY = 24 * HOUR;
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
  accountId = await newAccount('owner@example.com', 'pro');
});

async function newAccount(email: string, plan: string): Promise<string> {
  const token = (await createLoginToken(db, email, T0))!;
  await redeemLoginToken(db, token, T0, plan);
  return (await db.query('SELECT id FROM accounts WHERE email = $1', [email]))[0].id;
}
async function newCheck(cfg: CheckConfig = intervalCfg(), extra: { name?: string; driftEnabled?: boolean; folderId?: string; account?: string } = {}) {
  const account = extra.account ?? accountId;
  const id = await createCheck(db, account, { name: extra.name ?? 'Orders → Sheet', cfg, driftEnabled: extra.driftEnabled, folderId: extra.folderId }, SECRET);
  return (await getCheck(db, account, id))!;
}
const reload = async (id: string, account = accountId) => (await getCheck(db, account, id))!;
function msg(token: string, ts: number, kind: PingKind = 'ok', extra: Partial<PingMessage> = {}): PingMessage {
  return { id: `s${++seq}`, t: token, ts, k: kind, f: 0, ...extra };
}
const withPayload = (token: string, ts: number, payload: unknown) => {
  const { shape } = shapeOf(payload);
  return msg(token, ts, 'ok', { shape, sh: JSON.stringify(shape).length.toString(16) });
};
const consume = (msgs: PingMessage[], now: number) => consumeBatch(db, msgs, now, 'canary', APP);
const count = async (table: string, where = 'true') => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n as number;
const deliveries = () => db.query('SELECT event, subject, body, link FROM alert_deliveries ORDER BY created_at, id');
async function tick(now: number) {
  await setState(db, CANARY_KEY, String(now - MIN));
  return runEvaluator(db, { now, appUrl: APP, sendCanary: async () => {} });
}

// --- runaway loops --------------------------------------------------------------------------------

/** A limiter that allows `limit` calls per key, like the Cloudflare binding within one period. */
function fakeLimiter(limit: number): Limiter & { calls: number } {
  const seen = new Map<string, number>();
  return {
    calls: 0,
    async limit({ key }) {
      this.calls++;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
}

function ingestEnv(overrides: Partial<IngestEnv> = {}) {
  const sent: PingMessage[] = [];
  const env: IngestEnv = {
    PINGS: { send: async (m: PingMessage) => void sent.push(m) } as unknown as IngestEnv['PINGS'],
    TOKEN_SECRET: SECRET,
    PING_LIMITER: fakeLimiter(60),
    MARKER_LIMITER: fakeLimiter(1),
    ...overrides,
  };
  return { env, sent };
}

describe('per-token rate limiting at the edge', () => {
  it('queues the first 60 pings in a minute, then acknowledges without queueing', async () => {
    const { env, sent } = ingestEnv();
    const token = await makeToken(SECRET);
    const bodies: any[] = [];
    for (let i = 0; i < 500; i++) {
      const res = await handlePing(new Request(`https://ping.test/p/${token}`, { method: 'POST', body: '{"n":1}' }), env, T0 + i);
      expect(res.status).toBe(200); // never breaks the customer's workflow step
      bodies.push(await res.json());
    }
    expect(bodies.slice(0, 60).every((b) => b.throttled === undefined)).toBe(true);
    expect(bodies.slice(60).every((b) => b.ok === true && b.throttled === true)).toBe(true);
    // 60 real pings + exactly one "still looping" marker, instead of 500 queue messages.
    expect(sent).toHaveLength(61);
    expect(sent.filter((m) => m.f & FLAG_THROTTLED)).toHaveLength(1);
    expect(sent[60]).toMatchObject({ t: token, k: 'ok', f: FLAG_THROTTLED });
    expect(sent[60].shape).toBeUndefined(); // throttled requests are not even read
  });

  it('limits each check separately', async () => {
    const { env, sent } = ingestEnv();
    const noisy = await makeToken(SECRET);
    const quiet = await makeToken(SECRET);
    for (let i = 0; i < 200; i++) await handlePing(new Request(`https://ping.test/p/${noisy}`), env, T0 + i);
    const res = await handlePing(new Request(`https://ping.test/p/${quiet}`), env, T0 + 500);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent.filter((m) => m.t === quiet)).toHaveLength(1);
  });

  it('does not rate-limit invalid URLs or spend limiter calls on them', async () => {
    const { env } = ingestEnv();
    for (let i = 0; i < 5; i++) expect((await handlePing(new Request(`https://ping.test/p/${'x'.repeat(30)}`), env)).status).toBe(404);
    expect((env.PING_LIMITER as any).calls).toBe(0);
  });

  it('fails open: if the limiter is missing or broken, pings still flow', async () => {
    const broken: Limiter = { limit: async () => { throw new Error('limiter down'); } };
    for (const overrides of [{ PING_LIMITER: undefined, MARKER_LIMITER: undefined }, { PING_LIMITER: broken }]) {
      const { env, sent } = ingestEnv(overrides);
      const token = await makeToken(SECRET);
      for (let i = 0; i < 100; i++) await handlePing(new Request(`https://ping.test/p/${token}`), env, T0 + i);
      expect(sent).toHaveLength(100);
    }
  });
});

describe('runaway loop alerts', () => {
  it('raises one "Runaway loop detected" alert, keeps the check alive, and closes quietly when the loop stops', async () => {
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await consume([msg(check.token, T0 + MIN, 'ok', { f: FLAG_THROTTLED })], T0 + MIN);
    await consume([msg(check.token, T0 + 2 * MIN, 'ok', { f: FLAG_THROTTLED })], T0 + 2 * MIN);
    await consume([msg(check.token, T0 + 3 * MIN, 'ok', { f: FLAG_THROTTLED })], T0 + 3 * MIN);

    const after = await reload(check.id);
    expect(after.state.status).toBe('up');
    expect(after.state.lastPingAt).toBe(T0 + 3 * MIN); // the marker counts as a heartbeat
    expect(after.runawayAt).toBe(T0 + 3 * MIN);
    const sent = await deliveries();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: 'runaway', subject: 'Runaway loop detected: "Orders → Sheet"' });
    expect(sent[0].body).toContain('more than 60 times a minute');

    await tick(T0 + 5 * MIN); // loop was active 2 minutes ago: still open
    expect(await count('incidents', "kind = 'runaway' AND resolved_at IS NULL")).toBe(1);
    await tick(T0 + 3 * MIN + RUNAWAY_QUIET_MS + 2 * MIN);
    expect(await count('incidents', "kind = 'runaway' AND resolved_at IS NULL")).toBe(0);
    expect(await count('alert_deliveries')).toBe(1); // no "recovered" noise for a loop

    // A new loop later is a new incident and a new alert.
    await consume([msg(check.token, T0 + HOUR, 'ok', { f: FLAG_THROTTLED })], T0 + HOUR);
    expect(await count('alert_deliveries', "event = 'runaway'")).toBe(2);
  });
});

// --- payload drift --------------------------------------------------------------------------------

describe('payload drift alerts', () => {
  const good = { email: 'jane@example.com', phone: '555-0100', total: 12 };

  it('learns the first payload, then alerts once when a field goes blank', async () => {
    const check = await newCheck(intervalCfg(), { driftEnabled: true });
    await consume([withPayload(check.token, T0, good)], T0);
    expect((await reload(check.id)).acceptedShape).toEqual(shapeOf(good).shape);
    await consume([withPayload(check.token, T0 + MIN, { ...good, email: 'someone@else.org', total: 99 })], T0 + MIN);
    expect(await count('incidents')).toBe(0); // different values, same shape

    await consume([withPayload(check.token, T0 + 2 * MIN, { ...good, email: '' })], T0 + 2 * MIN);
    await consume([withPayload(check.token, T0 + 3 * MIN, { ...good, email: '' })], T0 + 3 * MIN);
    await consume([withPayload(check.token, T0 + 4 * MIN, { ...good, email: '  ', phone: null })], T0 + 4 * MIN);

    const sent = await deliveries();
    expect(sent).toHaveLength(1); // one alert, however many drifting pings follow
    expect(sent[0]).toMatchObject({ event: 'drift', subject: 'Payload changed: "Orders → Sheet"', link: `${APP}/checks/${check.id}#drift` });
    expect(sent[0].body).toContain('Key "email" is now blank text');
    expect(sent[0].body).not.toContain('jane');
    const after = await reload(check.id);
    expect(after.state.status).toBe('up'); // drift is a warning, not an outage
    expect(after.pendingShape).toEqual(shapeOf({ ...good, email: '  ', phone: null }).shape);
  });

  it('"Accept new shape" resolves the alert and makes the new shape normal', async () => {
    const check = await newCheck(intervalCfg(), { driftEnabled: true });
    await consume([withPayload(check.token, T0, good)], T0);
    const changed = { email: 'jane@example.com', phone: '555-0100', total: 12, coupon: 'X' };
    await consume([withPayload(check.token, T0 + MIN, changed)], T0 + MIN);
    expect(await acceptDrift(db, await reload(check.id), T0 + 2 * MIN)).toBe(true);
    expect(await count('incidents', 'resolved_at IS NULL')).toBe(0);
    await consume([withPayload(check.token, T0 + 3 * MIN, changed)], T0 + 3 * MIN);
    expect(await count('alert_deliveries')).toBe(1);
    // Going back to the old shape is now the drift.
    await consume([withPayload(check.token, T0 + 4 * MIN, good)], T0 + 4 * MIN);
    expect(await count('alert_deliveries')).toBe(2);
  });

  it('"Mark as optional" stops alert fatigue for fields that come and go', async () => {
    const check = await newCheck(intervalCfg(), { driftEnabled: true });
    await consume([withPayload(check.token, T0, good)], T0);
    await consume([withPayload(check.token, T0 + MIN, { ...good, phone: '' })], T0 + MIN);
    expect(await markDriftOptional(db, await reload(check.id), T0 + 2 * MIN)).toBe(true);
    expect((await reload(check.id)).optionalPaths).toEqual(['phone']);
    expect(await count('incidents', 'resolved_at IS NULL')).toBe(0);

    for (const [i, phone] of ['', '555', null, '   '].entries()) {
      await consume([withPayload(check.token, T0 + (3 + i) * MIN, { ...good, phone })], T0 + (3 + i) * MIN);
    }
    await consume([withPayload(check.token, T0 + 8 * MIN, { email: good.email, total: 1 })], T0 + 8 * MIN); // phone missing entirely
    expect(await count('alert_deliveries')).toBe(1);
    // A required field going blank is still caught.
    await consume([withPayload(check.token, T0 + 9 * MIN, { ...good, email: '' })], T0 + 9 * MIN);
    expect(await count('alert_deliveries')).toBe(2);
  });

  it('does nothing unless drift detection is switched on, and stops when it is switched off', async () => {
    const check = await newCheck();
    await consume([withPayload(check.token, T0, good)], T0);
    await consume([withPayload(check.token, T0 + MIN, { other: true })], T0 + MIN);
    expect(await count('incidents')).toBe(0);

    const watched = await newCheck(intervalCfg(), { driftEnabled: true, name: 'Watched' });
    await consume([withPayload(watched.token, T0, good)], T0);
    await consume([withPayload(watched.token, T0 + MIN, { other: true })], T0 + MIN);
    expect(await count('incidents', 'resolved_at IS NULL')).toBe(1);
    const current = await reload(watched.id);
    await updateCheck(db, current, { name: current.name, cfg: current.cfg, driftEnabled: false }, T0 + 2 * MIN);
    expect(await count('incidents', 'resolved_at IS NULL')).toBe(0);
    expect((await reload(watched.id)).pendingShape).toBeNull();
  });
});

// --- volume baseline --------------------------------------------------------------------------------

describe('volume baseline, end to end', () => {
  const volumeCfg: CheckConfig = { mode: 'volume', intervalSeconds: null, cron: null, timezone: 'UTC', graceSeconds: 0, activeWindow: null, volumeThresholdPct: 50 };
  const first = at('2026-10-01 10:00'); // a Thursday; learning covers 2-15 Oct

  async function seedDay(checkId: string, day: string, total: number) {
    if (total === 0) return;
    await db.query(
      `INSERT INTO ping_hourly (check_id, hour, ok, fail) VALUES ($1, $2::timestamptz, $3, 0)
       ON CONFLICT (check_id, hour) DO UPDATE SET ok = excluded.ok`,
      [checkId, new Date(at(`${day} 10:00`)).toISOString(), total],
    );
  }
  async function learnedCheck() {
    const check = await newCheck(volumeCfg);
    await consume([msg(check.token, first)], first);
    for (let d = at('2026-10-02 00:00'); d < at('2026-10-16 00:00'); d += DAY) {
      const date = new Date(d);
      const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
      await seedDay(check.id, date.toISOString().slice(0, 10), weekend ? 0 : 40);
    }
    return check;
  }
  const evalAt = async (id: string, when: string) => evaluateVolume(db, await reload(id), at(when), APP);

  it('learns for 14 days, shows the baseline, and does not alert until the user switches it on', async () => {
    const check = await learnedCheck();
    let c = await reload(check.id);
    expect(c).toMatchObject({ baselineStatus: 'learning', firstPingAt: first });
    expect(c.state.status).toBe('up');
    expect(c.nextEvalAt).toBe(at('2026-10-16 00:05'));

    await evalAt(check.id, '2026-10-10 00:06'); // too early: still learning
    expect((await reload(check.id)).baselineStatus).toBe('learning');

    await evalAt(check.id, '2026-10-16 00:06');
    c = await reload(check.id);
    expect(c.baselineStatus).toBe('ready');
    expect(c.baseline).toMatchObject({ granularity: 'daily', days: 14, daily: { '1': 40, '5': 40, '6': 0, '7': 0 } });
    expect(c.nextEvalAt).toBeNull(); // nothing is judged until it is enabled

    // A terrible day before it is enabled raises nothing.
    await seedDay(check.id, '2026-10-16', 1);
    await evalAt(check.id, '2026-10-17 00:06');
    expect(await count('incidents')).toBe(0);
  });

  it('alerts when a day falls below the threshold, in plain English, and recovers on the next normal day', async () => {
    const check = await learnedCheck();
    await evalAt(check.id, '2026-10-16 00:06');
    expect(await enableBaseline(db, await reload(check.id), at('2026-10-16 00:10'))).toBe(true);
    expect((await reload(check.id)).nextEvalAt).toBe(at('2026-10-17 00:05'));

    await seedDay(check.id, '2026-10-16', 3); // Friday: usually 40
    expect(await evalAt(check.id, '2026-10-17 00:06')).toBe(true);
    expect((await reload(check.id)).state.status).toBe('down');
    let sent = await deliveries();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Down: "Orders → Sheet" volume has dropped');
    expect(sent[0].body).toContain('usually about 40 pings on a Friday');
    expect(sent[0].body).toContain('only 3 pings arrived Fri 16 Oct');

    // A single ping does not mean volume is back.
    await consume([msg(check.token, at('2026-10-17 09:00'))], at('2026-10-17 09:00'));
    expect((await reload(check.id)).state.status).toBe('down');

    // Saturday and Sunday are normally silent: not judged, no extra alerts, still down.
    await evalAt(check.id, '2026-10-18 00:06');
    await evalAt(check.id, '2026-10-19 00:06');
    expect((await reload(check.id)).state.status).toBe('down');
    expect(await count('alert_deliveries')).toBe(1);

    await seedDay(check.id, '2026-10-19', 37); // Monday back to normal
    expect(await evalAt(check.id, '2026-10-20 00:06')).toBe(true);
    expect((await reload(check.id)).state.status).toBe('up');
    sent = await deliveries();
    expect(sent.map((d) => d.event)).toEqual(['down', 'recovered']);
    expect(sent[1].subject).toBe('Recovered: "Orders → Sheet" volume is back to normal');
  });

  it('never alerts for a weekend dip, a day hit by a monitoring gap, or the same day twice', async () => {
    const check = await learnedCheck();
    await evalAt(check.id, '2026-10-16 00:06');
    await enableBaseline(db, await reload(check.id), at('2026-10-16 00:10'));
    await seedDay(check.id, '2026-10-16', 41);
    await evalAt(check.id, '2026-10-17 00:06'); // normal Friday
    await evalAt(check.id, '2026-10-18 00:06'); // Saturday: zero pings, zero expected
    await evalAt(check.id, '2026-10-19 00:06'); // Sunday
    expect(await count('incidents')).toBe(0);

    // Monday: we had an outage, and (as far as we can tell) no pings arrived.
    await recordGap(db, at('2026-10-19 11:00'), at('2026-10-19 12:30'), 'ingest_stalled');
    expect(await evalAt(check.id, '2026-10-20 00:06')).toBe(false);
    expect(await count('incidents')).toBe(0);
    expect((await reload(check.id)).state.status).toBe('up');

    // Tuesday really is low. Evaluating it twice still gives one incident.
    await seedDay(check.id, '2026-10-20', 2);
    await evalAt(check.id, '2026-10-21 00:06');
    await evalAt(check.id, '2026-10-21 00:07');
    expect(await count('incidents')).toBe(1);
    expect(await count('alert_deliveries')).toBe(1);
  });

  it('is picked up by the every-minute evaluator when due', async () => {
    const check = await learnedCheck();
    await evalAt(check.id, '2026-10-16 00:06');
    await enableBaseline(db, await reload(check.id), at('2026-10-16 00:10'));
    await seedDay(check.id, '2026-10-16', 0);
    const start = at('2026-10-17 00:00');
    for (let t = start; t <= start + 10 * MIN; t += MIN) await tick(t);
    expect((await reload(check.id)).state.status).toBe('down');
    expect(await count('incidents', "reason = 'low_volume'")).toBe(1);
  });
});

// --- channels ---------------------------------------------------------------------------------------

describe('alert channels', () => {
  const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdefSECRET';
  const alert: OutboundAlert = {
    event: 'down', subject: 'Down: "X" has stopped checking in', body: 'Body text', link: 'https://app.test/checks/1',
    checkId: '1', checkName: 'X', at: T0, idempotencyKey: 'd1',
  };

  it('validates webhook URLs per channel type', () => {
    expect(validateChannelUrl('slack', SLACK)).toBeNull();
    expect(validateChannelUrl('slack', 'https://example.com/hook')).toContain('hooks.slack.com');
    expect(validateChannelUrl('discord', 'https://discord.com/api/webhooks/1/abc')).toBeNull();
    expect(validateChannelUrl('discord', 'https://discord.com/channels/1')).not.toBeNull();
    expect(validateChannelUrl('webhook', 'https://example.com/hooks/stepcanary')).toBeNull();
    for (const bad of ['http://example.com/x', 'not a url', 'https://localhost/x', 'https://10.0.0.5/x', 'https://user:pw@example.com/x', 'https://printer.local/x']) {
      expect(validateChannelUrl('webhook', bad)).not.toBeNull();
    }
  });

  it('encrypts webhook URLs at rest and never lists them in full', async () => {
    await addChannel(db, accountId, 'slack', '#ops', SLACK, KEY);
    const stored = JSON.stringify((await db.query(`SELECT config FROM channels WHERE kind = 'slack'`))[0].config);
    expect(stored).not.toContain('abcdefSECRET');
    expect(stored).not.toContain('/services/');
    const listed = await listChannels(db, accountId);
    expect(listed.map((c) => [c.kind, c.name, c.target])).toEqual([
      ['email', 'Your email', 'owner@example.com'],
      ['slack', '#ops', 'hooks.slack.com/…'],
    ]);
    const enc = await encryptSecret(SLACK, KEY);
    expect(await decryptSecret(enc, KEY)).toBe(SLACK);
    expect(enc).not.toBe(await encryptSecret(SLACK, KEY)); // fresh IV every time
    await expect(decryptSecret(enc, 'wrong-key')).rejects.toThrow();
  });

  it('formats Slack, Discord and generic webhook messages', () => {
    const slack = JSON.parse(buildWebhookRequest('slack', SLACK, alert).init.body as string);
    expect(slack.text).toBe('*Down: "X" has stopped checking in*\nBody text\n<https://app.test/checks/1|Open this check>');
    const discord = JSON.parse(buildWebhookRequest('discord', 'https://discord.com/api/webhooks/1/a', { ...alert, body: 'x'.repeat(5000) }).init.body as string);
    expect(discord.content.length).toBeLessThanOrEqual(2000);
    expect(discord.content.endsWith(alert.link)).toBe(true);
    const generic = JSON.parse(buildWebhookRequest('webhook', 'https://example.com/h', alert).init.body as string);
    expect(generic).toEqual({
      event: 'down', check: { id: '1', name: 'X' }, subject: alert.subject, message: 'Body text',
      url: alert.link, sent_at: new Date(T0).toISOString(), delivery_id: 'd1',
    });
  });

  it('delivers one alert to every channel on the check, and reports webhook failures without leaking the URL', async () => {
    await addChannel(db, accountId, 'slack', '#ops', SLACK, KEY);
    const check = await newCheck();
    await consume([msg(check.token, T0)], T0);
    await consume([msg(check.token, T0 + MIN, 'fail')], T0 + MIN);
    expect(await count('alert_deliveries')).toBe(2);

    const calls: string[] = [];
    const fetchOk = (async (url: string) => { calls.push(String(url)); return new Response('ok'); }) as unknown as typeof fetch;
    const env = { EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.co', RESEND_API_KEY: 'k', CHANNEL_KEY: KEY };
    expect(await sendPendingAlerts(db, makeSender(env, fetchOk), T0 + 2 * MIN)).toEqual({ sent: 2, failed: 0 });
    expect(calls.sort()).toEqual(['https://api.resend.com/emails', SLACK]);

    await consume([msg(check.token, T0 + 3 * MIN)], T0 + 3 * MIN); // recovered -> 2 more deliveries
    const fetchFail = (async (url: string) => new Response('no', { status: String(url).includes('slack') ? 404 : 200 })) as unknown as typeof fetch;
    expect(await sendPendingAlerts(db, makeSender(env, fetchFail), T0 + 4 * MIN)).toEqual({ sent: 1, failed: 1 });
    const err = (await db.query(`SELECT last_error FROM alert_deliveries WHERE last_error IS NOT NULL`))[0].last_error;
    expect(err).toContain('slack webhook responded 404');
    expect(err).not.toContain('abcdefSECRET');
  });

  it('only emails on the Free plan, even if other channels exist from a previous plan', async () => {
    await addChannel(db, accountId, 'slack', '#ops', SLACK, KEY);
    const check = await newCheck();
    await db.query(`UPDATE accounts SET plan = 'free' WHERE id = $1`, [accountId]);
    await consume([msg(check.token, T0)], T0);
    await consume([msg(check.token, T0 + MIN, 'fail')], T0 + MIN);
    const rows = await db.query('SELECT ch.kind FROM alert_deliveries d JOIN channels ch ON ch.id = d.channel_id');
    expect(rows).toEqual([{ kind: 'email' }]);
  });
});

// --- weekly client summary ------------------------------------------------------------------------------

describe('weekly client health summary', () => {
  it('knows which week is due and when', () => {
    const w = summaryWeek(at('2026-11-10 12:00')); // a Tuesday
    expect(w.week).toBe('2026-W45');
    expect(new Date(w.periodStart).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(new Date(w.periodEnd).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(new Date(w.dueAt).toISOString()).toBe('2026-11-09T09:00:00.000Z');
  });

  it('composes a forwardable summary with totals, uptime and status per automation', () => {
    const periodStart = at('2026-11-02 00:00');
    const periodEnd = at('2026-11-09 00:00');
    const email = composeWeeklySummary({
      folderName: 'Acme Dental',
      periodStart,
      periodEnd,
      checks: [
        { name: 'New patient form', status: 'up', pings: 1240, downtimeMs: 0, incidents: 0, monitoredSince: periodStart - DAY },
        { name: 'Invoice sync', status: 'down', pings: 12, downtimeMs: 7 * DAY * 0.1, incidents: 2, monitoredSince: periodStart - DAY },
        { name: 'Not set up yet', status: 'new', pings: 0, downtimeMs: 0, incidents: 0, monitoredSince: null },
      ],
    });
    expect(email.subject).toBe('Weekly automation health: Acme Dental (2 Nov – 8 Nov 2026)');
    expect(email.text).toContain('3 automations monitored, 1,252 successful runs, 2 incidents.');
    expect(email.text).toContain('- New patient form: Healthy. 1,240 runs, uptime 100%, incidents 0.');
    expect(email.text).toContain('- Invoice sync: Down. 12 runs, uptime 90.0%, incidents 2.');
    expect(email.text).toContain('- Not set up yet: Waiting for first run. 0 runs, uptime not yet monitored');
    expect(email.html).toContain('<td');
    expect(composeWeeklySummary({ folderName: '<script>', periodStart, periodEnd, checks: [] }).html).not.toContain('<script>');
  });

  it('measures uptime only over the time a check was actually monitored', () => {
    const start = 0;
    const end = 7 * DAY;
    const c = { name: 'x', status: 'up', pings: 1, incidents: 1, downtimeMs: DAY };
    expect(uptimePercent({ ...c, monitoredSince: -DAY }, start, end)).toBeCloseTo(85.71, 1);
    expect(uptimePercent({ ...c, monitoredSince: 5 * DAY }, start, end)).toBeCloseTo(50, 5); // monitored for 2 days, down for 1
    expect(uptimePercent({ ...c, monitoredSince: null }, start, end)).toBeNull();
  });

  it('sends one summary per Agency folder per week, with real numbers, and not before Monday 09:00 UTC', async () => {
    const agency = await newAccount('agency@example.com', 'agency');
    const created = at('2026-11-01 00:00');
    const acme = await createFolder(db, agency, 'Acme Dental', created);
    await createFolder(db, agency, 'Empty client', created); // no checks: skipped
    const proFolder = await createFolder(db, accountId, 'Pro account folder', created); // not Agency: skipped
    await newCheck(intervalCfg(), { folderId: proFolder });
    const check = await newCheck(intervalCfg(), { name: 'New patient form', folderId: acme, account: agency });

    // Activity inside the reported week (2-8 Nov): 3 pings and a 2-hour outage.
    const wed = at('2026-11-04 10:00');
    await consume([msg(check.token, wed), msg(check.token, wed + MIN), msg(check.token, wed + 2 * MIN)], wed + 2 * MIN);
    await consume([msg(check.token, wed + HOUR, 'fail')], wed + HOUR);
    await consume([msg(check.token, wed + 3 * HOUR)], wed + 3 * HOUR);

    const sent: Email[] = [];
    const send = async (e: Email) => void sent.push(e);
    expect(await runWeeklySummaries(db, send, at('2026-11-09 08:59'))).toBe(0); // Monday, too early
    expect(await runWeeklySummaries(db, send, at('2026-11-09 09:00'))).toBe(1);
    expect(await runWeeklySummaries(db, send, at('2026-11-09 09:01'))).toBe(0); // already sent this week
    expect(await runWeeklySummaries(db, send, at('2026-11-12 15:00'))).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('agency@example.com');
    expect(sent[0].subject).toContain('Acme Dental');
    // Monitored from Wednesday 10:00 (110 hours of the week), down for 2 of them.
    expect(sent[0].text).toContain('- New patient form: Healthy. 4 runs, uptime 98.2%, incidents 1.');

    expect(await runWeeklySummaries(db, send, at('2026-11-16 09:00'))).toBe(1); // next week
  });

  it('retries a summary whose email failed to send', async () => {
    const agency = await newAccount('agency@example.com', 'agency');
    const folder = await createFolder(db, agency, 'Acme', at('2026-11-01 00:00'));
    await newCheck(intervalCfg(), { folderId: folder, account: agency });
    const failing = async () => { throw new Error('provider down'); };
    expect(await runWeeklySummaries(db, failing, at('2026-11-09 09:00'))).toBe(0);
    const sent: Email[] = [];
    expect(await runWeeklySummaries(db, async (e) => void sent.push(e), at('2026-11-09 09:01'))).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

// --- billing ------------------------------------------------------------------------------------------

describe('billing', () => {
  const env: BillingEnv = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_AGENCY: 'price_agency', APP_URL: APP };
  const sub = (status: string, price: string, extra: object = {}) => ({ id: 'sub_1', status, customer: 'cus_1', items: { data: [{ price: { id: price } }] }, metadata: {}, ...extra });

  async function sign(payload: string, secret: string, t: number): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
    return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  it('verifies Stripe webhook signatures', async () => {
    const payload = '{"id":"evt_1"}';
    const t = Math.floor(T0 / 1000);
    const header = await sign(payload, 'whsec_test', t);
    expect(await verifyStripeSignature(payload, header, 'whsec_test', T0)).toBe(true);
    expect(await verifyStripeSignature(payload + ' ', header, 'whsec_test', T0)).toBe(false); // body tampered
    expect(await verifyStripeSignature(payload, header, 'whsec_other', T0)).toBe(false);
    expect(await verifyStripeSignature(payload, header, 'whsec_test', T0 + 10 * MIN)).toBe(false); // replayed later
    expect(await verifyStripeSignature(payload, null, 'whsec_test', T0)).toBe(false);
    expect(await verifyStripeSignature(payload, 'garbage', 'whsec_test', T0)).toBe(false);
    expect(await verifyStripeSignature(payload, header, '', T0)).toBe(false);
  });

  it('maps a subscription to a plan', () => {
    expect(planFromSubscription(sub('active', 'price_pro'), env)).toBe('pro');
    expect(planFromSubscription(sub('trialing', 'price_agency'), env)).toBe('agency');
    expect(planFromSubscription(sub('past_due', 'price_pro'), env)).toBe('pro'); // Stripe is still retrying the card
    expect(planFromSubscription(sub('canceled', 'price_pro'), env)).toBe('free');
    expect(planFromSubscription(sub('unpaid', 'price_agency'), env)).toBe('free');
    expect(planFromSubscription(sub('active', 'price_unknown'), env)).toBe('free');
    expect(planFromSubscription(null, env)).toBe('free');
  });

  it('on downgrade, pauses checks that use paid features, then the least recently pinged over the limit; nothing is deleted', async () => {
    const schedule = await newCheck({ mode: 'schedule', intervalSeconds: null, cron: '0 9 * * *', timezone: 'UTC', graceSeconds: 600, activeWindow: null }, { name: 'schedule' });
    const names = ['oldest-ping', 'never-pinged', 'recent-1', 'recent-2', 'recent-3'];
    const checks = [];
    for (const name of names) checks.push(await newCheck(intervalCfg(), { name }));
    await consume([msg(schedule.token, T0)], T0);
    await consume([msg(checks[0].token, T0 - 5 * DAY)], T0 - 5 * DAY);
    for (const [i, c] of checks.slice(2).entries()) await consume([msg(c.token, T0 - i * MIN)], T0);

    await applyPlan(db, accountId, 'free', T0 + MIN);
    const rows = await db.query('SELECT name, status, paused_reason FROM checks ORDER BY name');
    expect(rows).toEqual([
      { name: 'never-pinged', status: 'paused', paused_reason: 'plan_limit' },
      { name: 'oldest-ping', status: 'paused', paused_reason: 'plan_limit' },
      { name: 'recent-1', status: 'up', paused_reason: null },
      { name: 'recent-2', status: 'up', paused_reason: null },
      { name: 'recent-3', status: 'up', paused_reason: null },
      { name: 'schedule', status: 'paused', paused_reason: 'plan_feature' },
    ]);
    expect(await count('checks')).toBe(6);

    // Upgrading again resumes what the downgrade paused.
    await applyPlan(db, accountId, 'pro', T0 + 2 * MIN);
    expect(await count('checks', "status = 'paused'")).toBe(0);
    expect((await db.query(`SELECT status FROM checks WHERE name = 'never-pinged'`))[0].status).toBe('new');
  });

  it('does not touch checks the user paused themselves', async () => {
    const mine = await newCheck(intervalCfg(), { name: 'mine' });
    await db.query(`UPDATE checks SET status = 'paused' WHERE id = $1`, [mine.id]);
    await applyPlan(db, accountId, 'free', T0);
    await applyPlan(db, accountId, 'pro', T0 + MIN);
    expect((await reload(mine.id)).state.status).toBe('paused');
  });

  it('applies the plan from Stripe on checkout and on later subscription changes, re-reading the subscription each time', async () => {
    let current: any = sub('active', 'price_pro', { metadata: { account_id: accountId } });
    const requested: string[] = [];
    const fakeFetch = (async (url: string) => { requested.push(String(url)); return new Response(JSON.stringify(current)); }) as unknown as typeof fetch;
    await db.query(`UPDATE accounts SET plan = 'free' WHERE id = $1`, [accountId]);
    const plan = async () => (await db.query('SELECT plan, stripe_customer_id, stripe_subscription_id FROM accounts WHERE id = $1', [accountId]))[0];

    const checkout = { type: 'checkout.session.completed', data: { object: { subscription: 'sub_1', customer: 'cus_1', client_reference_id: accountId } } };
    expect(await handleStripeEvent(db, env, checkout, T0, fakeFetch)).toBe('plan=pro');
    expect(await handleStripeEvent(db, env, checkout, T0, fakeFetch)).toBe('plan=pro'); // Stripe retries are harmless
    expect(await plan()).toEqual({ plan: 'pro', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' });
    expect(requested[0]).toBe('https://api.stripe.com/v1/subscriptions/sub_1');

    // The event says "active", but Stripe now says the plan changed to Agency: Stripe wins.
    current = sub('active', 'price_agency', { metadata: { account_id: accountId } });
    await handleStripeEvent(db, env, { type: 'customer.subscription.updated', data: { object: sub('active', 'price_pro') } }, T0, fakeFetch);
    expect((await plan()).plan).toBe('agency');

    current = sub('canceled', 'price_agency');
    await handleStripeEvent(db, env, { type: 'customer.subscription.deleted', data: { object: sub('canceled', 'price_agency') } }, T0, fakeFetch);
    expect(await plan()).toEqual({ plan: 'free', stripe_customer_id: 'cus_1', stripe_subscription_id: null });

    expect(await handleStripeEvent(db, env, { type: 'invoice.paid', data: { object: {} } }, T0, fakeFetch)).toBe('ignored');
    current = sub('active', 'price_pro', { customer: 'cus_stranger' });
    expect(await handleStripeEvent(db, env, { type: 'customer.subscription.updated', data: { object: { id: 'sub_9' } } }, T0, fakeFetch)).toBe('unknown_account');
  });

  it('ignores a late "cancelled" event for an old subscription after the customer resubscribed', async () => {
    await db.query(`UPDATE accounts SET plan = 'pro', stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_new' WHERE id = $1`, [accountId]);
    const old = { ...sub('canceled', 'price_pro'), id: 'sub_old' };
    const fakeFetch = (async () => new Response(JSON.stringify(old))) as unknown as typeof fetch;
    expect(await handleStripeEvent(db, env, { type: 'customer.subscription.deleted', data: { object: old } }, T0, fakeFetch)).toBe('stale_subscription');
    expect((await db.query('SELECT plan FROM accounts WHERE id = $1', [accountId]))[0].plan).toBe('pro');
  });
});

describe('weekly summary for a brand-new folder', () => {
  it('waits for the first full week after the folder was created', async () => {
    const agency = await newAccount('agency2@example.com', 'agency');
    const folder = await createFolder(db, agency, 'New client', at('2026-11-10 12:00')); // a Tuesday
    await newCheck(intervalCfg(), { folderId: folder, account: agency });
    const sent: Email[] = [];
    const send = async (e: Email) => void sent.push(e);
    expect(await runWeeklySummaries(db, send, at('2026-11-10 12:05'))).toBe(0); // last week predates the folder
    expect(await runWeeklySummaries(db, send, at('2026-11-16 09:00'))).toBe(1);
  });
});
