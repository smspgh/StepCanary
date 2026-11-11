// "What is a check?" is explained wherever the term is introduced, and the wording is American English.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLoginToken } from '../src/app/auth';
import type { Db } from '../src/app/db';
import { renderGuide } from '../src/app/guides';
import { createApp, type AppEnv } from '../src/app/routes';
import { EMAIL_FOOTER, makeSender } from '../src/app/sender';
import { testDb } from './helpers';

const APP = 'https://app.stepcanary.test';
const env: AppEnv = {
  HYPERDRIVE: { connectionString: '' },
  INGEST: { fetch: async () => new Response('ok') },
  TOKEN_SECRET: 'test-secret',
  APP_URL: APP,
  PING_URL: 'https://ping.stepcanary.test',
  EMAIL_PROVIDER: 'console',
  EMAIL_FROM: 'a@b.co',
  DEFAULT_PLAN: 'free',
};
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as any;

describe('the "What is a check?" page', () => {
  const page = renderGuide('checks', 'https://ping.stepcanary.test')!;

  it('explains what a check is, what it does, why it matters and what it never does', () => {
    expect(page.title).toBe('What is a check?');
    for (const heading of ['What a check does', 'Why you need one', 'What a check never does', 'Quick reference', 'What the statuses mean']) {
      expect(page.html).toContain(heading);
    }
    expect(page.html).toContain('watch on one of your automations');
    expect(page.html).toContain('It never stores your data.');
  });

  it('has a quick reference for every term and status the product uses', () => {
    for (const term of ['Check', 'Ping', 'Ping URL', 'Interval', 'Schedule', 'Volume', 'Grace period', 'Active window', 'Payload shape', 'Alert channel', 'Monitoring gap']) {
      expect(page.html, term).toContain(`<td><strong>${term}</strong></td>`);
    }
    for (const status of ['New', 'Up', 'Late', 'Down', 'Paused']) expect(page.html, status).toContain(`<td><strong>${status}</strong></td>`);
    for (const slug of ['zapier', 'make', 'n8n', 'pipedream']) expect(page.html).toContain(`href="/guides/${slug}"`);
  });

  it('is linked from the top of every platform guide', () => {
    for (const slug of ['zapier', 'make', 'n8n', 'pipedream']) {
      const html = renderGuide(slug, 'https://ping.stepcanary.test')!.html;
      expect(html, slug).toContain('<a href="/guides/checks">What is a check?</a>');
      expect(html.indexOf('What is a check?'), slug).toBeLessThan(html.indexOf('1. Create the check'));
    }
  });
});

describe('the term is explained where it is used', () => {
  let db: Db;
  let reset: () => Promise<void>;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  const get = async (path: string, withCookie = true) => (await app.request(`${APP}${path}`, { headers: withCookie ? { cookie } : {} }, env, ctx)).text();

  beforeAll(async () => {
    ({ db, reset, close } = await testDb());
    app = createApp(() => ({ db, close: async () => {} }));
  });
  afterAll(() => close());
  beforeEach(async () => {
    await reset();
    const token = (await createLoginToken(db, 'owner@example.com', Date.now()))!;
    const res = await app.request(
      `${APP}/auth/verify`,
      { method: 'POST', headers: { origin: APP, 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` },
      env,
      ctx,
    );
    cookie = res.headers.get('set-cookie')!.split(';')[0];
  });

  it('on the landing page, before the first instruction that mentions a check', async () => {
    const html = await get('/', false);
    expect(html).toContain('A check is our watch on that one automation');
    expect(html.indexOf('A check is our watch')).toBeLessThan(html.indexOf('Create a check'));
    expect(html).toContain('What is a check?'); // also answered in the questions section
    expect(html).toContain('href="/guides/checks"');
  });

  it('on an empty dashboard, with the three things a check does', async () => {
    const html = await get('/checks');
    expect(html).toContain('Start by creating your first check');
    expect(html).toContain('It gives you a private URL');
    expect(html).toContain('Your automation pings it');
    expect(html).toContain('It alerts you when that stops');
    expect(html).toContain('class="term" href="/guides/checks" title="A check is StepCanary');
  });

  it('on the new-check form, the check page, the plan page and the guides index', async () => {
    expect(await get('/checks/new')).toContain('A check watches one automation.');
    const form = 'name=Leads&mode=interval&interval_value=1&interval_unit=hours&grace_value=10&grace_unit=minutes&timezone=UTC';
    const created = await app.request(
      `${APP}/checks`,
      { method: 'POST', headers: { origin: APP, cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form },
      env,
      ctx,
    );
    const checkPage = await get(created.headers.get('location')!.split('?')[0]);
    expect(checkPage).toContain('is watching one automation.');
    expect(checkPage).toContain('title="New: waiting for the first ping.'); // status badges explain themselves
    expect(await get('/checks/' + created.headers.get('location')!.split('/').pop()!.split('?')[0] + '/edit')).not.toContain('A check watches one automation.'); // not when editing
    expect(await get('/billing')).toContain('paused checks don’t count');
    const guides = await get('/guides');
    expect(guides).toContain('Start here: What is a check?');
    expect(guides.indexOf('Start here: What is a check?')).toBeLessThan(guides.indexOf('href="/guides/zapier'));
    const concept = await get('/guides/checks', false);
    expect(concept).toContain('Quick reference');
    expect(concept).not.toContain('You need a StepCanary check to follow this guide');
  });

  it('in alert emails, so an alert months later still makes sense', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{}');
    }) as unknown as typeof fetch;
    const send = makeSender({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.co', RESEND_API_KEY: 'k' }, fetchImpl);
    await send(
      { kind: 'email', config: { email: 'owner@example.com' } },
      { event: 'down', subject: 'Down: "X" has stopped checking in', body: 'Body.', link: `${APP}/checks/1`, checkId: '1', checkName: 'X', at: 0, idempotencyKey: 'd' },
    );
    expect(EMAIL_FOOTER).toContain('a StepCanary check is watching this automation');
    expect(bodies[0].text).toContain(EMAIL_FOOTER);
    expect(bodies[0].html).toContain('A check listens for a signal each time the automation runs');
  });
});

describe('American English', () => {
  const BRITISH =
    /\b(authoris\w*|recognis\w*|personalis\w*|organis\w*|colour\w*|behaviour\w*|cancelled|cancelling|summaris\w*|whilst|licence\w*|favour\w*|centre\w*|catalogue\w*|analyse\w*|minimis\w*|optimis\w*|prioritis\w*|penalis\w*|customis\w*|normalis\w*|judgement\w*|learnt|grey|programme\w*|fulfil\b|labelled|modelling|travelling|towards|afterwards|amongst|untick\w*|ticked|straight away|working day|postcode\w*|fortnight\w*|autumn)\b/i;

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|md|sql|mjs|jsonc)$/.test(name) ? [path] : [];
    });
  }

  it('is used throughout the app, emails, guides and docs', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    for (const dir of ['src', 'docs', 'migrations', 'scripts']) {
      for (const file of files(join(root, dir))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const m = BRITISH.exec(line);
            if (m) offenders.push(`${file.slice(root.length + 1)}:${i + 1} "${m[0]}"`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('formats dates month-first and times on a 12-hour clock', async () => {
    const { composeAlert, describeExpectation, formatClock } = await import('../src/core/describe');
    expect(formatClock(0)).toBe('12:00 AM');
    expect(formatClock(9 * 60)).toBe('9:00 AM');
    expect(formatClock(12 * 60 + 5)).toBe('12:05 PM');
    expect(formatClock(18 * 60)).toBe('6:00 PM');
    const cfg = { mode: 'interval' as const, intervalSeconds: 3600, cron: null, timezone: 'America/New_York', graceSeconds: 600, activeWindow: { days: [1, 2, 3, 4, 5], start: 540, end: 1080 } };
    expect(describeExpectation(cfg)).toContain('Mon–Fri, 9:00 AM–6:00 PM (America/New_York)');
    const at = Date.UTC(2026, 10, 11, 0, 13); // Nov 10, 2026, 7:13 PM in New York
    const alert = composeAlert('down', { name: 'X', cfg, lastPingAt: at - 3_600_000, at, reason: 'missed', link: 'l' });
    expect(alert.body).toContain('Tue, Nov 10, 2026, 6:13 PM EST');
    expect(alert.body).not.toMatch(/\d{1,2} Nov 2026|\b1[3-9]:\d\d\b/);
  });
});
