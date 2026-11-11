// The one-time "your volume baseline is ready to review" email.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLoginToken, redeemLoginToken } from '../src/app/auth';
import { createCheck, enableBaseline, getCheck, proposeBaseline, updateCheck } from '../src/app/checks';
import { consumeBatch } from '../src/app/consumer';
import type { Db } from '../src/app/db';
import type { Email } from '../src/app/email';
import { evaluateVolume } from '../src/app/evaluator';
import { sendBaselineReadyNotices } from '../src/app/notices';
import type { CheckConfig } from '../src/core/evaluate';
import { at, intervalCfg, testDb } from './helpers';

const APP = 'https://app.test';
const DAY = 86_400_000;
const first = at('2026-10-01 10:00', 'America/Chicago');
const volumeCfg: CheckConfig = { mode: 'volume', intervalSeconds: null, cron: null, timezone: 'America/Chicago', graceSeconds: 0, activeWindow: null, volumeThresholdPct: 50 };

let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let accountId: string;
let sent: Email[];
const send = async (e: Email) => void sent.push(e);

beforeAll(async () => {
  ({ db, reset, close } = await testDb());
});
afterAll(() => close());
beforeEach(async () => {
  await reset();
  sent = [];
  const token = (await createLoginToken(db, 'owner@example.com', first))!;
  await redeemLoginToken(db, token, first, 'pro');
  accountId = (await db.query('SELECT id FROM accounts'))[0].id;
});

async function learningCheck(name = 'Orders → Sheet') {
  const id = await createCheck(db, accountId, { name, cfg: volumeCfg }, 'secret');
  const check = (await getCheck(db, accountId, id))!;
  await consumeBatch(db, [{ id: `m-${id}`, t: check.token, ts: first, k: 'ok', f: 0 }], first, 'canary', APP);
  for (let d = 1; d <= 14; d++) {
    await db.query(`INSERT INTO ping_hourly (check_id, hour, ok, fail) VALUES ($1, $2::timestamptz, 30, 0)`, [
      id,
      new Date(at('2026-10-01 15:00', 'America/Chicago') + d * DAY).toISOString(),
    ]);
  }
  return id;
}
const reload = async (id: string) => (await getCheck(db, accountId, id))!;
const morning = at('2026-10-16 08:01', 'America/Chicago');

describe('baseline-ready email', () => {
  it('is sent once, at the start of the workday, when learning finishes', async () => {
    const id = await learningCheck();
    expect((await reload(id)).nextEvalAt).toBe(at('2026-10-16 08:00', 'America/Chicago')); // not midnight

    expect(await sendBaselineReadyNotices(db, send, morning - DAY, APP)).toBe(0); // still learning
    await evaluateVolume(db, await reload(id), morning, APP);
    expect((await reload(id)).baselineStatus).toBe('ready');

    expect(await sendBaselineReadyNotices(db, send, morning, APP)).toBe(1);
    expect(await sendBaselineReadyNotices(db, send, morning + 60_000, APP)).toBe(0);
    expect(await sendBaselineReadyNotices(db, send, morning + DAY, APP)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@example.com');
    expect(sent[0].subject).toBe('Your 14-day volume baseline for "Orders → Sheet" is ready to review');
    expect(sent[0].text).toContain(`${APP}/checks/${id}`);
    expect(sent[0].text).toContain('Volume alerts are not on yet');
  });

  it('is sent once even when two evaluator runs overlap', async () => {
    const id = await learningCheck();
    await evaluateVolume(db, await reload(id), morning, APP);
    const results = await Promise.all([1, 2, 3].map(() => sendBaselineReadyNotices(db, send, morning, APP)));
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('is retried if the email could not be sent', async () => {
    const id = await learningCheck();
    await evaluateVolume(db, await reload(id), morning, APP);
    const failing = async () => { throw new Error('provider down'); };
    expect(await sendBaselineReadyNotices(db, failing, morning, APP)).toBe(0);
    expect(await sendBaselineReadyNotices(db, send, morning + 60_000, APP)).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('is not sent for a relearn the user asked for, nor again after they enable alerts', async () => {
    const id = await learningCheck();
    await evaluateVolume(db, await reload(id), morning, APP);
    await sendBaselineReadyNotices(db, send, morning, APP);
    await enableBaseline(db, await reload(id), morning + 1000);
    const check = await reload(id);
    await proposeBaseline(db, check, check.baseline, morning + 2000); // "Relearn" button
    expect((await reload(id)).baselineStatus).toBe('ready');
    expect(await sendBaselineReadyNotices(db, send, morning + 3000, APP)).toBe(0);
    expect(sent).toHaveLength(1);

    // A second check that the user relearns before any email went out stays quiet too.
    const other = await learningCheck('Other');
    const o = await reload(other);
    await proposeBaseline(db, o, check.baseline, morning);
    expect(await sendBaselineReadyNotices(db, send, morning + 4000, APP)).toBe(0);
  });

  it('is sent again after a check is switched away from volume mode and back', async () => {
    const id = await learningCheck();
    await evaluateVolume(db, await reload(id), morning, APP);
    await sendBaselineReadyNotices(db, send, morning, APP);
    let check = await reload(id);
    await updateCheck(db, check, { name: check.name, cfg: intervalCfg() }, morning + 1000);
    check = await reload(id);
    await updateCheck(db, check, { name: check.name, cfg: volumeCfg }, morning + 2000);
    check = await reload(id);
    expect(check.baselineStatus).toBe('learning');
    await evaluateVolume(db, check, morning + 3000, APP); // 14 days of history already exist
    expect((await reload(id)).baselineStatus).toBe('ready');
    expect(await sendBaselineReadyNotices(db, send, morning + 4000, APP)).toBe(1);
    expect(sent).toHaveLength(2);
  });
});
