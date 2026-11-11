// Stripe billing: Checkout to subscribe, Customer Portal to manage, one webhook to stay in sync.
//
// The webhook never trusts an event's payload for plan state. For any subscription event it
// re-reads the subscription from Stripe, so out-of-order or replayed events always converge on
// the truth, and handling an event twice is harmless.

import { featuresNotInPlan, limitsFor, type Plan, type PlanLimits } from '../core/plans';
import type { Account } from './auth';
import { pauseCheck, resumeCheck } from './checks';
import { toCheck, type Db } from './db';

export interface BillingEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_AGENCY?: string;
  APP_URL: string;
}

type FetchFn = typeof fetch;

export function billingConfigured(env: BillingEnv): boolean {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_PRO && env.STRIPE_PRICE_AGENCY);
}

async function stripe(env: BillingEnv, method: 'GET' | 'POST', path: string, params: Record<string, string> = {}, fetchImpl: FetchFn = fetch): Promise<any> {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  const res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? new URLSearchParams(params).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${method} ${path} failed (${res.status}): ${body?.error?.message ?? 'unknown error'}`);
  return body;
}

const appUrl = (env: BillingEnv) => env.APP_URL.replace(/\/$/, '');

/** Start a subscription checkout. Returns the Stripe-hosted page to send the user to. */
export async function createCheckoutUrl(
  env: BillingEnv,
  account: Account & { stripeCustomerId?: string | null },
  plan: 'pro' | 'agency',
  fetchImpl: FetchFn = fetch,
): Promise<string> {
  const price = plan === 'agency' ? env.STRIPE_PRICE_AGENCY : env.STRIPE_PRICE_PRO;
  if (!price) throw new Error(`No Stripe price configured for ${plan}`);
  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    client_reference_id: account.id,
    'subscription_data[metadata][account_id]': account.id,
    'metadata[account_id]': account.id,
    success_url: `${appUrl(env)}/billing?checkout=success`,
    cancel_url: `${appUrl(env)}/billing`,
    allow_promotion_codes: 'true',
  };
  if (account.stripeCustomerId) params.customer = account.stripeCustomerId;
  else params.customer_email = account.email;
  return (await stripe(env, 'POST', '/checkout/sessions', params, fetchImpl)).url;
}

/** Stripe's self-service page for changing plan, card or cancelling. */
export async function createPortalUrl(env: BillingEnv, stripeCustomerId: string, fetchImpl: FetchFn = fetch): Promise<string> {
  return (await stripe(env, 'POST', '/billing_portal/sessions', { customer: stripeCustomerId, return_url: `${appUrl(env)}/billing` }, fetchImpl)).url;
}

// --- webhook ------------------------------------------------------------------------------------

const enc = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a Stripe-Signature header ("t=...,v1=...") against the raw request body. */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string, now: number, toleranceSec = 300): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || signatures.length === 0 || !/^\d+$/.test(t)) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((s) => timingSafeEqual(s, expected));
}

/** Which plan a Stripe subscription entitles the account to right now. */
export function planFromSubscription(sub: any, env: BillingEnv): Plan {
  // past_due keeps access while Stripe retries the card; it becomes canceled/unpaid if that fails.
  if (!sub || !['active', 'trialing', 'past_due'].includes(sub.status)) return 'free';
  const prices: string[] = (sub.items?.data ?? []).map((i: any) => i?.price?.id).filter(Boolean);
  if (env.STRIPE_PRICE_AGENCY && prices.includes(env.STRIPE_PRICE_AGENCY)) return 'agency';
  if (env.STRIPE_PRICE_PRO && prices.includes(env.STRIPE_PRICE_PRO)) return 'pro';
  return 'free';
}

/**
 * Make an account's checks fit its plan.
 *  - Downgrade: pause checks that use features the plan lacks, then pause checks beyond the
 *    limit, least recently pinged first. Nothing is deleted.
 *  - Upgrade: resume checks that were paused by a previous downgrade, as far as the plan allows.
 */
export async function enforcePlanLimits(db: Db, accountId: string, limits: PlanLimits, now: number): Promise<{ paused: number; resumed: number }> {
  const checks = (await db.query('SELECT * FROM checks WHERE account_id = $1', [accountId])).map(toCheck);
  const allowed = (c: (typeof checks)[number]) =>
    featuresNotInPlan({ mode: c.cfg.mode, activeWindow: c.cfg.activeWindow, driftEnabled: c.driftEnabled }, limits).length === 0;
  let paused = 0;
  let resumed = 0;

  const active = checks.filter((c) => c.state.status !== 'paused');
  const keep: typeof checks = [];
  for (const c of active) {
    if (allowed(c)) keep.push(c);
    else {
      await pauseCheck(db, c, now, 'plan_feature');
      paused++;
    }
  }

  if (keep.length > limits.maxChecks) {
    // Least recently pinged first (never-pinged before everything), then oldest.
    const order = [...keep].sort(
      (a, b) => (a.state.lastPingAt ?? -1) - (b.state.lastPingAt ?? -1) || (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
    for (const c of order.slice(0, keep.length - limits.maxChecks)) {
      await pauseCheck(db, c, now, 'plan_limit');
      paused++;
    }
  } else {
    let room = limits.maxChecks - keep.length;
    const waiting = checks
      .filter((c) => c.state.status === 'paused' && c.pausedReason?.startsWith('plan_') && allowed(c))
      .sort((a, b) => (b.state.lastPingAt ?? -1) - (a.state.lastPingAt ?? -1));
    for (const c of waiting) {
      if (room-- <= 0) break;
      await resumeCheck(db, c, now);
      resumed++;
    }
  }
  return { paused, resumed };
}

export async function applyPlan(db: Db, accountId: string, plan: Plan, now: number): Promise<void> {
  await db.query('UPDATE accounts SET plan = $2 WHERE id = $1', [accountId, plan]);
  await enforcePlanLimits(db, accountId, limitsFor(plan), now);
}

async function accountIdFor(db: Db, metadataAccountId: string | undefined, customerId: string | undefined): Promise<string | null> {
  if (metadataAccountId) {
    const rows = await db.query('SELECT id FROM accounts WHERE id = $1', [metadataAccountId]);
    if (rows[0]) return rows[0].id;
  }
  if (customerId) {
    const rows = await db.query('SELECT id FROM accounts WHERE stripe_customer_id = $1', [customerId]);
    if (rows[0]) return rows[0].id;
  }
  return null;
}

/** Handle one verified Stripe event. Returns a short note for the logs. */
export async function handleStripeEvent(db: Db, env: BillingEnv, event: any, now: number, fetchImpl: FetchFn = fetch): Promise<string> {
  const obj = event?.data?.object ?? {};
  let subscriptionId: string | undefined;
  let accountHint: string | undefined;
  let customerId: string | undefined;

  if (event.type === 'checkout.session.completed') {
    subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
    accountHint = obj.client_reference_id ?? obj.metadata?.account_id;
    customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
  } else if (typeof event.type === 'string' && event.type.startsWith('customer.subscription.')) {
    subscriptionId = obj.id;
    accountHint = obj.metadata?.account_id;
    customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
  } else {
    return 'ignored';
  }
  if (!subscriptionId) return 'no_subscription';

  const sub = await stripe(env, 'GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {}, fetchImpl);
  customerId = (typeof sub.customer === 'string' ? sub.customer : sub.customer?.id) ?? customerId;
  const accountId = await accountIdFor(db, sub.metadata?.account_id ?? accountHint, customerId);
  if (!accountId) return 'unknown_account';

  // An older, cancelled subscription must not overwrite a newer active one.
  const current = (await db.query('SELECT stripe_subscription_id FROM accounts WHERE id = $1', [accountId]))[0]?.stripe_subscription_id;
  const plan = planFromSubscription(sub, env);
  if (plan === 'free' && current && current !== sub.id) return 'stale_subscription';

  await db.query('UPDATE accounts SET stripe_customer_id = COALESCE($2, stripe_customer_id), stripe_subscription_id = $3 WHERE id = $1', [
    accountId,
    customerId ?? null,
    plan === 'free' ? null : sub.id,
  ]);
  await applyPlan(db, accountId, plan, now);
  return `plan=${plan}`;
}
