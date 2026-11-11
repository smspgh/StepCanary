// Importable n8n workflow templates: valid, safe by default, and pre-filled for a signed-in customer.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLoginToken } from '../src/app/auth';
import type { Db } from '../src/app/db';
import { renderGuide, renderTemplate } from '../src/app/guides';
import { TEMPLATE_FILES } from '../src/app/guides-content';
import { createApp, type AppEnv } from '../src/app/routes';
import { testDb } from './helpers';

const dir = join(__dirname, '..', 'templates', 'n8n');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

describe('n8n workflow templates', () => {
  it('ships the three templates the guide links to', () => {
    expect(files.sort()).toEqual(['stepcanary-failure-reporter.json', 'stepcanary-heartbeat-with-fields.json', 'stepcanary-heartbeat.json']);
    expect(Object.keys(TEMPLATE_FILES).sort()).toEqual(files.map((f) => `n8n/${f}`).sort());
    const guide = renderGuide('n8n', 'https://ping.stepcanary.com')!.html;
    for (const f of files) expect(guide, f).toContain(`href="/templates/n8n/${f}"`);
  });

  it('are well-formed n8n workflows', () => {
    for (const f of files) {
      const wf = load(f);
      expect(Object.keys(wf).sort(), f).toEqual(['connections', 'name', 'nodes', 'settings']);
      const names = wf.nodes.map((n: any) => n.name);
      expect(new Set(names).size, f).toBe(names.length); // connections are keyed by node name
      expect(new Set(wf.nodes.map((n: any) => n.id)).size, f).toBe(wf.nodes.length);
      for (const n of wf.nodes) {
        expect(n.type, f).toMatch(/^n8n-nodes-base\.(httpRequest|manualTrigger|errorTrigger|stickyNote)$/);
        expect(typeof n.typeVersion, f).toBe('number');
        expect(n.position, f).toHaveLength(2);
      }
      // Every connection starts and ends at a node that exists.
      for (const [from, outputs] of Object.entries<any>(wf.connections)) {
        expect(names, f).toContain(from);
        for (const target of outputs.main.flat()) expect(names, f).toContain(target.node);
      }
    }
  });

  it('configure the ping so it can never stop the customer’s workflow', () => {
    for (const f of files) {
      const http = load(f).nodes.filter((n: any) => n.type === 'n8n-nodes-base.httpRequest');
      expect(http, f).toHaveLength(1);
      expect(http[0].onError, f).toBe('continueRegularOutput');
      expect(http[0].retryOnFail, f).toBe(true);
      expect(http[0].parameters.method, f).toBe('POST');
      expect(http[0].parameters.url, f).toMatch(/^https:\/\/ping\.stepcanary\.com\/p\/YOUR-TOKEN(\/fail)?$/);
    }
    expect(load('stepcanary-failure-reporter.json').nodes.some((n: any) => n.type === 'n8n-nodes-base.errorTrigger')).toBe(true);
    expect(load('stepcanary-failure-reporter.json').nodes.find((n: any) => n.type.endsWith('httpRequest')).parameters.url).toMatch(/\/fail$/);
    expect(load('stepcanary-heartbeat-with-fields.json').nodes.find((n: any) => n.type.endsWith('httpRequest')).parameters.bodyParameters.parameters[0]).toEqual({
      name: 'email',
      value: '={{ $json.email }}',
    });
  });

  it('are filled in with a real ping URL on request, and stay valid JSON', () => {
    const token = 'abcDEF123_-abcDEF123_-abcDEF12';
    const plain = renderTemplate('n8n/stepcanary-heartbeat.json', 'https://ping.example.test/')!;
    expect(JSON.parse(plain).nodes[2].parameters.url).toBe('https://ping.example.test/p/YOUR-TOKEN');
    const filled = JSON.parse(renderTemplate('n8n/stepcanary-failure-reporter.json', 'https://ping.example.test', token)!);
    expect(filled.nodes.find((n: any) => n.type.endsWith('httpRequest')).parameters.url).toBe(`https://ping.example.test/p/${token}/fail`);
    expect(renderTemplate('n8n/nope.json', 'https://ping.example.test')).toBeNull();
    expect(renderTemplate('../package.json', 'https://ping.example.test')).toBeNull();
  });
});

describe('template downloads', () => {
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
  let db: Db;
  let reset: () => Promise<void>;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  const get = (url: string, cookie?: string) => app.request(url, { headers: cookie ? { cookie } : {} }, env, ctx);

  beforeAll(async () => {
    ({ db, reset, close } = await testDb());
    app = createApp(() => ({ db, close: async () => {} }));
  });
  afterAll(() => close());
  beforeEach(() => reset());

  async function signIn(email: string): Promise<string> {
    const token = (await createLoginToken(db, email, Date.now()))!;
    const res = await app.request(
      `${APP}/auth/verify`,
      { method: 'POST', headers: { origin: APP, 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` },
      env,
      ctx,
    );
    return res.headers.get('set-cookie')!.split(';')[0];
  }

  it('serves a template to anyone as a file download, on the app and the public site', async () => {
    for (const host of [APP, 'https://stepcanary.test']) {
      const res = await get(`${host}/templates/n8n/stepcanary-heartbeat.json`);
      expect(res.status, host).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="stepcanary-heartbeat.json"');
      expect(res.headers.get('content-type')).toContain('application/json');
      expect((await res.json() as any).nodes[2].parameters.url).toBe('https://ping.stepcanary.test/p/YOUR-TOKEN');
    }
    expect((await get(`${APP}/templates/n8n/missing.json`)).status).toBe(404);
    expect((await get(`${APP}/templates/make/anything.json`)).status).toBe(404);
  });

  it('fills in your own check’s ping URL, and never someone else’s', async () => {
    const alice = await signIn('alice@example.com');
    const form = 'name=Leads&mode=interval&interval_value=1&interval_unit=hours&grace_value=10&grace_unit=minutes&timezone=UTC';
    const created = await app.request(
      `${APP}/checks`,
      { method: 'POST', headers: { origin: APP, cookie: alice, 'content-type': 'application/x-www-form-urlencoded' }, body: form },
      env,
      ctx,
    );
    const checkPath = created.headers.get('location')!.split('?')[0];
    const checkId = checkPath.split('/').pop()!;
    const token = (await db.query('SELECT token FROM checks'))[0].token;
    const url = `${APP}/templates/n8n/stepcanary-heartbeat.json?check=${checkId}`;

    expect(await (await get(`${APP}${checkPath}`, alice)).text()).toContain(`/templates/n8n/stepcanary-heartbeat.json?check=${checkId}`);
    const guide = await (await get(`${APP}/guides/n8n?check=${checkId}`, alice)).text();
    expect(guide).toContain(`/templates/n8n/stepcanary-failure-reporter.json?check=${checkId}`);

    expect(((await (await get(url, alice)).json()) as any).nodes[2].parameters.url).toBe(`https://ping.stepcanary.test/p/${token}`);
    const bob = await signIn('bob@example.com');
    expect(await (await get(url, bob)).text()).not.toContain(token);
    expect(await (await get(url)).text()).not.toContain(token);
  });
});
