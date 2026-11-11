// A cancelled or downgraded subscription keeps its paid plan until the period ends, and the
// Plan page says so.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLoginToken } from '../src/app/auth';
import { handleStripeEvent, pendingChange, type BillingEnv } from '../src/app/billing';
import type { Db } from '../src/app/db';
import { createApp, type AppEnv } from '../src/app/routes';
import { at, testDb } from './helpers';

const ORIGIN = 'http://localhost:8787';
const NOW = at('2026-11-11 02:00');
const PERIOD_END = at('2026-12-11 02:00');
const sec = (t: number) => Math.floor(t / 1000);
const env: BillingEnv = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_AGENCY: 'price_agency', APP_URL: ORIGIN };

/** A subscription in the shape newer Stripe API versions send: period end lives on the item. */
const sub = (price: string, extra: object = {}) => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  cancel_at_period_end: false,
  cancel_at: null,
  schedule: null,
  metadata: {},
  items: { data: [{ price: { id: price }, current_period_end: sec(PERIOD_END) }] },
  ...extra,
});

/** Answers Stripe GETs: /subscriptions/... with `subscription`, /subscription_schedules/... with `schedule`. */
function fakeStripe(state: { subscription: any; schedule?: any }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const body = String(url).includes('/subscription_schedules/') ? state.schedule : state.subscription;
    return body ? new Response(JSON.stringify(body)) : new Response('{"error":{"message":"not found"}}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('what Stripe has scheduled for a subscription', () => {
  it('nothing, for an ordinary active subscription', async () => {
    const { fetchImpl, calls } = fakeStripe({ subscription: null });
    expect(await pendingChange(env, sub('price_agency'), NOW, fetchImpl)).toEqual({ cancelAt: null, changeTo: null, changeAt: null });
    expect(calls).toEqual([]);
  });

  it('a cancellation at the end of the paid period', async () => {
    const { fetchImpl } = fakeStripe({ subscription: null });
    // Both ways Stripe expresses it, old and new.
    expect((await pendingChange(env, sub('price_agency', { cancel_at_period_end: true }), NOW, fetchImpl)).cancelAt).toBe(PERIOD_END);
    expect((await pendingChange(env, sub('price_agency', { cancel_at: sec(PERIOD_END) }), NOW, fetchImpl)).cancelAt).toBe(PERIOD_END);
    const legacy = { ...sub('price_pro', { cancel_at_period_end: true }), current_period_end: sec(PERIOD_END), items: { data: [{ price: { id: 'price_pro' } }] } };
    expect((await pendingChange(env, legacy, NOW, fetchImpl)).cancelAt).toBe(PERIOD_END);
  });

  it('a downgrade scheduled for the end of the paid period', async () => {
    const schedule = {
      id: 'sub_sched_1',
      phases: [
        { start_date: sec(NOW) - 86400, end_date: sec(PERIOD_END), items: [{ price: 'price_agency' }] },
        { start_date: sec(PERIOD_END), items: [{ price: 'price_pro' }] },
      ],
    };
    const { fetchImpl, calls } = fakeStripe({ subscription: null, schedule });
    expect(await pendingChange(env, sub('price_agency', { schedule: 'sub_sched_1' }), NOW, fetchImpl)).toEqual({
      cancelAt: null,
      changeTo: 'pro',
      changeAt: PERIOD_END,
    });
    expect(calls).toEqual(['https://api.stripe.com/v1/subscription_schedules/sub_sched_1']);
  });

  it('nothing if the schedule cannot be read or keeps the same plan, and nothing once cancelled', async () => {
    const missing = fakeStripe({ subscription: null });
    expect((await pendingChange(env, sub('price_agency', { schedule: 'sub_sched_x' }), NOW, missing.fetchImpl)).changeTo).toBeNull();
    const same = fakeStripe({ subscription: null, schedule: { phases: [{ start_date: sec(PERIOD_END), items: [{ price: 'price_agency' }] }] } });
    expect((await pendingChange(env, sub('price_agency', { schedule: 's' }), NOW, same.fetchImpl)).changeTo).toBeNull();
    expect(await pendingChange(env, sub('price_agency', { status: 'canceled', cancel_at: sec(NOW) }), NOW, missing.fetchImpl)).toEqual({
      cancelAt: null,
      changeTo: null,
      changeAt: null,
    });
  });
});

describe('the Plan page', () => {
  let db: Db;
  let reset: () => Promise<void>;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let accountId: string;
  const appEnv: AppEnv = {
    HYPERDRIVE: { connectionString: '' },
    INGEST: { fetch: async () => new Response('ok') },
    TOKEN_SECRET: 's',
    PING_URL: ORIGIN,
    EMAIL_PROVIDER: 'console',
    EMAIL_FROM: 'a@b.co',
    DEFAULT_PLAN: 'free',
    ...env,
  };
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as any;
  const billingPage = async () => (await app.request(`${ORIGIN}/billing`, { headers: { cookie } }, appEnv, ctx)).text();
  const event = (object: any) => ({ type: 'customer.subscription.updated', data: { object } });

  beforeAll(async () => {
    ({ db, reset, close } = await testDb());
    app = createApp(() => ({ db, close: async () => {} }));
  });
  afterAll(() => close());
  beforeEach(async () => {
    await reset();
    const token = (await createLoginToken(db, 'owner@example.com', Date.now()))!;
    const res = await app.request(
      `${ORIGIN}/auth/verify`,
      { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` },
      appEnv,
      ctx,
    );
    cookie = res.headers.get('set-cookie')!.split(';')[0];
    accountId = (await db.query('SELECT id FROM accounts'))[0].id;
  });

  it('keeps the paid plan after a cancellation and says when it ends; resuming clears the notice', async () => {
    const active = sub('price_agency', { metadata: { account_id: accountId } });
    const stripe = fakeStripe({ subscription: active });
    await handleStripeEvent(db, env, event(active), NOW, stripe.fetchImpl);
    let page = await billingPage();
    expect(page).toContain('You are on the <strong>Agency</strong> plan');
    expect(page).not.toContain('Your subscription is cancelled');

    // Customer cancels in the portal: still Agency, with an end date.
    stripe.calls.length = 0;
    const cancelled = { ...active, cancel_at_period_end: true, cancel_at: sec(PERIOD_END) };
    const cancelStripe = fakeStripe({ subscription: cancelled });
    expect(await handleStripeEvent(db, env, event(cancelled), NOW, cancelStripe.fetchImpl)).toBe('plan=agency cancels_later');
    page = await billingPage();
    expect(page).toContain('You are on the <strong>Agency</strong> plan');
    expect(page).toContain('Your subscription is cancelled');
    expect(page).toContain('December 11, 2026');
    expect(page).toContain('Manage billing');

    // Customer changes their mind and keeps the plan.
    await handleStripeEvent(db, env, event(active), NOW, fakeStripe({ subscription: active }).fetchImpl);
    expect(await billingPage()).not.toContain('Your subscription is cancelled');

    // The period ends: Stripe reports the subscription as cancelled, and the account is Free.
    const ended = { ...active, status: 'canceled' };
    await handleStripeEvent(db, env, { type: 'customer.subscription.deleted', data: { object: ended } }, PERIOD_END, fakeStripe({ subscription: ended }).fetchImpl);
    page = await billingPage();
    expect(page).toContain('You are on the <strong>Free</strong> plan');
    expect(page).not.toContain('Your subscription is cancelled');
    expect((await db.query('SELECT plan_cancel_at, plan_change_to FROM accounts'))[0]).toEqual({ plan_cancel_at: null, plan_change_to: null });
  });

  it('keeps the higher plan until a scheduled downgrade takes effect, and says what is coming', async () => {
    const scheduled = sub('price_agency', { metadata: { account_id: accountId }, schedule: 'sub_sched_1' });
    const schedule = { phases: [{ start_date: sec(NOW) - 60, items: [{ price: 'price_agency' }] }, { start_date: sec(PERIOD_END), items: [{ price: 'price_pro' }] }] };
    expect(await handleStripeEvent(db, env, event(scheduled), NOW, fakeStripe({ subscription: scheduled, schedule }).fetchImpl)).toBe('plan=agency then=pro');
    let page = await billingPage();
    expect(page).toContain('You are on the <strong>Agency</strong> plan');
    expect(page).toContain('A plan change is scheduled');
    expect(page).toContain('your plan changes to Pro');
    expect(page).toContain('December 11, 2026');

    // The new period starts: Stripe moves the subscription to Pro.
    const nowPro = sub('price_pro', { metadata: { account_id: accountId } });
    await handleStripeEvent(db, env, event(nowPro), PERIOD_END, fakeStripe({ subscription: nowPro }).fetchImpl);
    page = await billingPage();
    expect(page).toContain('You are on the <strong>Pro</strong> plan');
    expect(page).not.toContain('A plan change is scheduled');
  });
});
