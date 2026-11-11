// Dashboard smoke tests: real routes and views against PGlite.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLoginToken } from '../src/app/auth';
import { consumeBatch } from '../src/app/consumer';
import type { Db } from '../src/app/db';
import { createApp, type AppEnv } from '../src/app/routes';
import { verifyToken } from '../src/shared/token';
import { testDb } from './helpers';

const ORIGIN = 'http://localhost:8787';
let db: Db;
let reset: () => Promise<void>;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;

const extraEnv: Partial<AppEnv> = {};
const env = (plan = 'free'): AppEnv => ({
  HYPERDRIVE: { connectionString: '' },
  INGEST: { fetch: async () => new Response('ok') },
  TOKEN_SECRET: 'test-secret',
  APP_URL: ORIGIN,
  PING_URL: 'http://localhost:8788',
  EMAIL_PROVIDER: 'console',
  EMAIL_FROM: 'StepCanary <alerts@example.com>',
  DEFAULT_PLAN: plan,
  ...extraEnv,
});
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as any;

function call(path: string, opts: { method?: string; form?: Record<string, string | string[]>; cookie?: string; plan?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined;
  if (opts.form) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
    body = p.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  return app.request(`${ORIGIN}${path}`, { method: opts.method ?? (opts.form ? 'POST' : 'GET'), headers, body }, env(opts.plan), ctx);
}

async function signIn(email = 'owner@example.com', plan = 'free'): Promise<string> {
  const token = (await createLoginToken(db, email, Date.now()))!;
  const res = await call('/auth/verify', { form: { token }, plan });
  expect(res.status).toBe(302);
  return res.headers.get('set-cookie')!.split(';')[0];
}

const checkForm = { name: 'Lead form → CRM', mode: 'interval', interval_value: '1', interval_unit: 'hours', grace_value: '10', grace_unit: 'minutes', timezone: 'Europe/London' };

beforeAll(async () => {
  ({ db, reset, close } = await testDb());
  app = createApp(() => ({ db, close: async () => {} }));
});
afterAll(() => close());
beforeEach(async () => {
  for (const k of Object.keys(extraEnv)) delete (extraEnv as Record<string, unknown>)[k];
  await reset();
});

describe('magic-link login', () => {
  it('requests a link without revealing anything, and creates one login token', async () => {
    const res = await call('/login', { form: { email: ' Owner@Example.com ' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Check your email');
    expect(await db.query('SELECT email FROM login_tokens')).toEqual([{ email: 'owner@example.com' }]);
  });

  it('rejects invalid addresses and rate-limits link requests', async () => {
    expect((await call('/login', { form: { email: 'nope' } })).status).toBe(400);
    for (let i = 0; i < 8; i++) await call('/login', { form: { email: 'a@example.com' } });
    expect((await db.query('SELECT count(*)::int AS n FROM login_tokens'))[0].n).toBe(5);
  });

  it('a link works once; GET alone does not consume it', async () => {
    const token = (await createLoginToken(db, 'owner@example.com', Date.now()))!;
    const preview = await call(`/auth/verify?token=${token}`);
    expect(await preview.text()).toContain('Sign in to StepCanary');
    expect((await call('/auth/verify', { form: { token } })).status).toBe(302);
    expect((await call('/auth/verify', { form: { token } })).status).toBe(400);
    expect((await db.query('SELECT count(*)::int AS n FROM accounts'))[0].n).toBe(1);
    expect((await db.query('SELECT kind FROM channels'))[0].kind).toBe('email');
  });

  it('rejects expired links and cross-site form posts', async () => {
    const token = (await createLoginToken(db, 'owner@example.com', Date.now() - 16 * 60_000))!;
    expect((await call('/auth/verify', { form: { token } })).status).toBe(400);
    const res = await app.request(`${ORIGIN}/login`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a@example.com',
    }, env(), ctx);
    expect(res.status).toBe(403);
  });

  it('redirects signed-out visitors to the login page and signs out cleanly', async () => {
    expect((await call('/checks')).headers.get('location')).toBe('/login');
    expect((await call('/checks/new')).headers.get('location')).toBe('/login');
    const cookie = await signIn();
    expect((await call('/checks', { cookie })).status).toBe(200);
    await call('/logout', { method: 'POST', cookie });
    expect((await call('/checks', { cookie })).status).toBe(302);
  });
});

describe('checks', () => {
  it('creates a check, shows its ping URL and platform settings, and listens for the first ping', async () => {
    const cookie = await signIn();
    const created = await call('/checks', { form: checkForm, cookie });
    expect(created.status).toBe(302);
    const path = created.headers.get('location')!.split('?')[0];

    const row = (await db.query('SELECT token, status FROM checks'))[0];
    expect(row.status).toBe('new');
    expect(await verifyToken(row.token, 'test-secret')).toBe(true);

    const html = await (await call(path, { cookie })).text();
    expect(html).toContain(`http://localhost:8788/p/${row.token}`);
    expect(html).toContain('Listening for your first ping');
    for (const platform of ['Zapier', 'Make', 'n8n', 'Pipedream']) expect(html).toContain(platform);

    expect(await (await call(`${path}/listen`, { cookie })).json()).toEqual({ connected: false, at: null, keys: [] });
    const now = Date.now();
    await consumeBatch(db, [{ id: 'm1', t: row.token, ts: now, k: 'ok', f: 0, shape: { $: 'object', email: 'string', 'order.total': 'number' }, sh: 'h' }], now, 'canary', ORIGIN);
    expect(await (await call(`${path}/listen`, { cookie })).json()).toEqual({ connected: true, at: now, keys: ['email', 'order.total'] });

    const after = await (await call(path, { cookie })).text();
    expect(after).toContain('Connected.');
    expect(after).not.toContain('Listening for your first ping');

    const list = await (await call('/checks', { cookie })).text();
    expect(list).toContain('Lead form → CRM');
    expect(list).toContain('badge up');
    expect(list).toContain('<svg');
  });

  it('enforces the Free plan: 3 checks, interval mode only', async () => {
    const cookie = await signIn();
    for (let i = 0; i < 3; i++) expect((await call('/checks', { form: { ...checkForm, name: `c${i}` }, cookie })).status).toBe(302);
    const fourth = await call('/checks', { form: checkForm, cookie });
    expect(fourth.status).toBe(400);
    expect(await fourth.text()).toContain('includes 3 checks');

    await db.query('DELETE FROM checks');
    const sched = await call('/checks', { form: { ...checkForm, mode: 'schedule', cron: '0 9 * * 1-5' }, cookie });
    expect(sched.status).toBe(400);
    expect(await sched.text()).toContain('Pro plan');
  });

  it('lets Pro accounts use schedules and active windows, and edit, pause, resume and delete', async () => {
    const cookie = await signIn('pro@example.com', 'pro');
    const form = { ...checkForm, window_enabled: '1', window_days: ['1', '2', '3', '4', '5'], window_start: '09:00', window_end: '18:00' };
    const path = (await call('/checks', { form, cookie, plan: 'pro' })).headers.get('location')!.split('?')[0];
    expect(await (await call(path, { cookie })).text()).toContain('Mon–Fri, 9:00 AM–6:00 PM (Europe/London)');
    expect((await call(`${path}/edit`, { cookie })).status).toBe(200);

    expect((await call(path, { form: { ...checkForm, name: 'Renamed', mode: 'schedule', cron: '0 9 * * 1-5' }, cookie })).status).toBe(302);
    expect((await db.query('SELECT name, mode, cron, active_window FROM checks'))[0]).toEqual({ name: 'Renamed', mode: 'schedule', cron: '0 9 * * 1-5', active_window: null });

    await call(`${path}/pause`, { method: 'POST', cookie });
    expect((await db.query('SELECT status FROM checks'))[0].status).toBe('paused');
    await call(`${path}/resume`, { method: 'POST', cookie });
    expect((await db.query('SELECT status FROM checks'))[0].status).toBe('new');
    await call(`${path}/delete`, { method: 'POST', cookie });
    expect(await db.query('SELECT id FROM checks')).toEqual([]);
  });

  it('never shows one account another account’s check', async () => {
    const alice = await signIn('alice@example.com');
    const path = (await call('/checks', { form: checkForm, cookie: alice })).headers.get('location')!.split('?')[0];
    const bob = await signIn('bob@example.com');
    expect((await call(path, { cookie: bob })).status).toBe(404);
    expect((await call(`${path}/listen`, { cookie: bob })).status).toBe(404);
    expect((await call(`${path}/delete`, { method: 'POST', cookie: bob })).status).toBe(404);
    expect((await db.query('SELECT count(*)::int AS n FROM checks'))[0].n).toBe(1);
  });
});

describe('step 3 screens', () => {
  const SLACK = 'https://hooks.slack.com/services/T0/B0/secretpart';

  it('keeps open pages current: the signature changes when a check changes', async () => {
    const cookie = await signIn();
    expect((await call('/sig')).status).toBe(302); // signed out
    const path = (await call('/checks', { form: checkForm, cookie })).headers.get('location')!.split('?')[0];
    const before = (await (await call('/sig', { cookie })).json()) as { sig: string };
    expect(await (await call(path, { cookie })).text()).toContain(`<meta name="sc-sig" content="${before.sig}"`);
    const token = (await db.query('SELECT token FROM checks'))[0].token;
    await consumeBatch(db, [{ id: 'm1', t: token, ts: Date.now(), k: 'ok', f: 0 }], Date.now(), 'canary', ORIGIN);
    const after = (await (await call('/sig', { cookie })).json()) as { sig: string };
    expect(after.sig).not.toBe(before.sig);
  });

  it('adds, lists and removes a Slack channel on Pro; refuses on Free', async () => {
    Object.assign(extraEnv, { CHANNEL_KEY: 'k' });
    const free = await signIn('free@example.com', 'free');
    const refused = await call('/channels', { form: { kind: 'slack', name: '#ops', url: SLACK }, cookie: free });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Pro plan');

    const cookie = await signIn('pro@example.com', 'pro');
    expect((await call('/channels', { form: { kind: 'slack', name: '#ops', url: 'https://example.com/x' }, cookie })).status).toBe(400);
    expect((await call('/channels', { form: { kind: 'slack', name: '#ops', url: SLACK }, cookie })).status).toBe(302);
    const page = await (await call('/channels', { cookie })).text();
    expect(page).toContain('#ops');
    expect(page).toContain('hooks.slack.com/…');
    expect(page).not.toContain('secretpart');

    // The check form offers the channel, and a new check uses the ones that were ticked.
    const form = await (await call('/checks/new', { cookie })).text();
    expect(form).toContain('Slack: #ops');
    const channels = await db.query(`SELECT c.id, c.kind FROM channels c JOIN accounts a ON a.id = c.account_id WHERE a.email = 'pro@example.com'`);
    const emailOnly = channels.find((c) => c.kind === 'email')!.id;
    await call('/checks', { form: { ...checkForm, channels_shown: '1', channel_ids: [emailOnly] }, cookie });
    expect((await db.query('SELECT ch.kind FROM check_channels cc JOIN channels ch ON ch.id = cc.channel_id')).map((r) => r.kind)).toEqual(['email']);
    expect((await call('/checks', { form: { ...checkForm, channels_shown: '1' }, cookie })).status).toBe(400); // none ticked

    const slackId = channels.find((c) => c.kind === 'slack')!.id;
    await call(`/channels/${slackId}/delete`, { method: 'POST', cookie });
    await call(`/channels/${emailOnly}/delete`, { method: 'POST', cookie }); // the email channel cannot be removed
    expect((await db.query(`SELECT kind FROM channels WHERE account_id = (SELECT id FROM accounts WHERE email = 'pro@example.com')`)).map((r) => r.kind)).toEqual(['email']);
  });

  it('shows the drift panel and resolves it with one click', async () => {
    const cookie = await signIn('pro@example.com', 'pro');
    const path = (await call('/checks', { form: { ...checkForm, drift_enabled: '1' }, cookie })).headers.get('location')!.split('?')[0];
    const token = (await db.query('SELECT token FROM checks'))[0].token;
    const now = Date.now();
    await consumeBatch(db, [{ id: 'a', t: token, ts: now, k: 'ok', f: 0, shape: { $: 'object', email: 'string' }, sh: '1' }], now, 'canary', ORIGIN);
    expect(await (await call(path, { cookie })).text()).toContain('Watching 1 field');
    await consumeBatch(db, [{ id: 'b', t: token, ts: now + 1, k: 'ok', f: 0, shape: { $: 'object', email: 'empty_string' }, sh: '2' }], now + 1, 'canary', ORIGIN);

    const page = await (await call(path, { cookie })).text();
    expect(page).toContain('The payload has changed shape');
    expect(page).toContain('is now blank text');
    expect(page).toContain('Accept new shape');
    expect(page).toContain('Mark as optional');
    expect(await (await call('/checks', { cookie })).text()).toContain('payload changed');

    const done = await call(`${path}/drift/optional`, { method: 'POST', cookie });
    expect(done.headers.get('location')).toContain('notice=drift_optional');
    const after = await (await call(path, { cookie })).text();
    expect(after).not.toContain('The payload has changed shape');
    expect(after).toContain('email (optional)');
  });

  it('shows the volume baseline for review and switches alerts on', async () => {
    const cookie = await signIn('pro@example.com', 'pro');
    const path = (await call('/checks', { form: { name: 'Orders', mode: 'volume', volume_pct: '50', timezone: 'UTC' }, cookie })).headers.get('location')!.split('?')[0];
    expect(await (await call(path, { cookie })).text()).toContain('Learning starts with the first ping');
    const baseline = { granularity: 'daily', daily: { '1': 40, '2': 40, '6': 0 }, hourly: {}, days: 14, from: 0, to: 1 };
    await db.query(`UPDATE checks SET status = 'up', last_ping_at = now(), first_ping_at = now(), baseline_status = 'ready', baseline = $1::text::jsonb`, [JSON.stringify(baseline)]);
    const review = await (await call(path, { cookie })).text();
    expect(review).toContain('ready for you to review');
    expect(review).toContain('about 40');
    expect(review).toContain('normally quiet');
    expect((await call(`${path}/baseline/enable`, { method: 'POST', cookie })).headers.get('location')).toContain('baseline_on');
    const row = (await db.query('SELECT baseline_status, next_eval_at FROM checks'))[0];
    expect(row.baseline_status).toBe('active');
    expect(row.next_eval_at).not.toBeNull();
    expect((await call(`${path}/baseline/relearn`, { method: 'POST', cookie })).headers.get('location')).toContain('baseline_short');
  });

  it('offers client folders only on Agency, and groups checks by client', async () => {
    const pro = await signIn('pro@example.com', 'pro');
    expect(await (await call('/folders', { cookie: pro })).text()).toContain('Agency plan');
    await call('/folders', { form: { name: 'Sneaky' }, cookie: pro });
    expect(await db.query('SELECT id FROM folders')).toEqual([]);

    const cookie = await signIn('agency@example.com', 'agency');
    expect((await call('/folders', { form: { name: '  Acme   Dental ' }, cookie })).status).toBe(302);
    const folder = (await db.query('SELECT id, name FROM folders'))[0];
    expect(folder.name).toBe('Acme Dental');
    await call('/checks', { form: { ...checkForm, folder_id: folder.id }, cookie });
    await call('/checks', { form: { ...checkForm, name: 'Unfiled one' }, cookie });
    const list = await (await call('/checks', { cookie })).text();
    expect(list.indexOf('Acme Dental')).toBeGreaterThan(0);
    expect(list.indexOf('Acme Dental')).toBeLessThan(list.indexOf('No client folder'));
    await call(`/folders/${folder.id}/delete`, { method: 'POST', cookie });
    expect((await db.query('SELECT count(*)::int AS n FROM checks'))[0].n).toBe(2); // checks survive
  });

  it('shows plans, and rejects unsigned or forged Stripe webhooks', async () => {
    const cookie = await signIn();
    const page = await (await call('/billing', { cookie })).text();
    expect(page).toContain('$15/month');
    expect(page).toContain('$49/month');
    expect(page).toContain('Paid plans are not available yet'); // Stripe not configured in this test
    expect((await call('/billing/checkout', { form: { plan: 'pro' }, cookie })).status).toBe(400);

    Object.assign(extraEnv, { STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_SECRET_KEY: 'sk', STRIPE_PRICE_PRO: 'p', STRIPE_PRICE_AGENCY: 'a' });
    const post = (headers: Record<string, string>) =>
      app.request(`${ORIGIN}/webhooks/stripe`, { method: 'POST', headers, body: '{"type":"customer.subscription.updated"}' }, env(), ctx);
    expect((await post({})).status).toBe(400);
    expect((await post({ 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` })).status).toBe(400);
    expect((await db.query('SELECT plan FROM accounts'))[0].plan).toBe('free');
  });

  it('will not resume a check the plan no longer allows', async () => {
    const cookie = await signIn('pro@example.com', 'pro');
    const path = (await call('/checks', { form: { ...checkForm, mode: 'schedule', cron: '0 9 * * *' }, cookie, plan: 'pro' })).headers.get('location')!.split('?')[0];
    await db.query(`UPDATE accounts SET plan = 'free'`);
    await db.query(`UPDATE checks SET status = 'paused', paused_reason = 'plan_feature'`);
    expect(await (await call(path, { cookie })).text()).toContain('not in your current plan');
    expect((await call(`${path}/resume`, { method: 'POST', cookie })).headers.get('location')).toContain('resume_limit');
    expect((await db.query('SELECT status FROM checks'))[0].status).toBe('paused');
  });
});
