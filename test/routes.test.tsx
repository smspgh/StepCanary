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

const env = (plan = 'free'): AppEnv => ({
  HYPERDRIVE: { connectionString: '' },
  INGEST: { fetch: async () => new Response('ok') },
  TOKEN_SECRET: 'test-secret',
  APP_URL: ORIGIN,
  PING_URL: 'http://localhost:8788',
  EMAIL_PROVIDER: 'console',
  EMAIL_FROM: 'StepCanary <alerts@example.com>',
  DEFAULT_PLAN: plan,
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
beforeEach(() => reset());

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
    expect(await (await call(path, { cookie })).text()).toContain('Mon–Fri, 09:00–18:00 (Europe/London)');
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
