// Guides in the app, the Markdown renderer behind them, and the public marketing site.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLoginToken } from '../src/app/auth';
import type { Db } from '../src/app/db';
import { GUIDES, renderGuide } from '../src/app/guides';
import { GUIDE_MARKDOWN } from '../src/app/guides-content';
import { createApp, type AppEnv } from '../src/app/routes';
import { renderMarkdown, titleOf } from '../src/core/markdown';
// @ts-expect-error plain .mjs build script
import { generate } from '../scripts/build-guides.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testDb } from './helpers';

describe('markdown renderer', () => {
  it('renders headings, paragraphs, bold, code and links, escaping HTML', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and `code <b>` text\nacross lines. [Go](/guides) <script>x</script>\n\n## Step one');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>Some <strong>bold</strong> and <code>code &lt;b&gt;</code> text across lines. <a href="/guides">Go</a> &lt;script&gt;x&lt;/script&gt;</p>');
    expect(html).toContain('<h2 id="step-one">Step one</h2>');
    expect(titleOf('intro\n# The Title\n')).toBe('The Title');
  });

  it('does not turn unsafe links into anchors', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
  });

  it('renders tables', () => {
    const html = renderMarkdown('| Field | Value |\n|---|---|\n| **URL** | `https://x` |\n| Method | POST |\n\nAfter.');
    expect(html).toContain('<thead><tr><th>Field</th><th>Value</th></tr></thead>');
    expect(html).toContain('<tr><td><strong>URL</strong></td><td><code>https://x</code></td></tr>');
    expect(html).toContain('<p>After.</p>');
  });

  it('renders ordered and unordered lists, with wrapped lines and nested blocks kept inside the item', () => {
    const md = [
      '1. First step that',
      '   wraps onto a second line.',
      '2. Second step:',
      '',
      '   ```json',
      '   {"a": 1}',
      '   ```',
      '',
      '   - nested one',
      '   - nested two',
      '3. Third.',
      '',
      '- loose bullet',
    ].join('\n');
    const html = renderMarkdown(md);
    expect(html.match(/<ol>/g)).toHaveLength(1);
    expect(html).toContain('<li>First step that wraps onto a second line.</li>');
    expect(html).toContain('<pre><code>{&quot;a&quot;: 1}</code></pre>');
    expect(html).toContain('<ul><li>nested one</li><li>nested two</li></ul></li><li>Third.</li></ol>');
    expect(html).toContain('<ul><li>loose bullet</li></ul>');
  });

  it('renders fenced code verbatim and screenshot placeholders as boxes', () => {
    const html = renderMarkdown('```javascript\nconst a = "<b>"; // **not bold**\n```\n\n`[ Screenshot: the editor ]`\n`[ Screenshot: the result ]`');
    expect(html).toContain('<pre><code>const a = &quot;&lt;b&gt;&quot;; // **not bold**</code></pre>');
    expect(html).toContain('<div class="shot">Screenshot: the editor</div>\n<div class="shot">Screenshot: the result</div>');
  });
});

describe('guide content', () => {
  it('is in step with docs/guides (run `npm run build:guides` after editing a guide)', () => {
    const onDisk = readFileSync(join(__dirname, '..', 'src', 'app', 'guides-content.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(generate());
  });

  it('renders all four guides completely', () => {
    expect(['checks', ...GUIDES.map((g) => g.slug)]).toEqual(Object.keys(GUIDE_MARKDOWN));
    for (const g of GUIDES) {
      const guide = renderGuide(g.slug, 'https://ping.stepcanary.com')!;
      expect(guide.title).toContain(g.platform === 'Zapier' ? 'Zap' : g.platform);
      for (const section of ['1. Create the check', '4. Test it', 'Which settings should I pick?', 'Troubleshooting']) {
        expect(guide.html, `${g.slug}: ${section}`).toContain(section);
      }
      expect(guide.html).toContain('<table>');
      expect(guide.html).toContain('class="shot"');
      expect(guide.html).not.toMatch(/\*\*|```|^\|/m); // no Markdown left unrendered
    }
    expect(renderGuide('nope', 'https://ping.stepcanary.com')).toBeNull();
  });

  it('fills in a real ping URL, including the /fail address', () => {
    const token = 'abcDEF123_-abcDEF123_-abcDEF12';
    for (const g of GUIDES) {
      const html = renderGuide(g.slug, 'https://ping.example.test/', token)!.html;
      expect(html, g.slug).toContain(`https://ping.example.test/p/${token}`);
      expect(html, g.slug).toContain(`https://ping.example.test/p/${token}/fail`);
      expect(html, g.slug).not.toContain('your-token');
      expect(html, g.slug).not.toContain('YOUR-TOKEN');
      expect(html, g.slug).not.toContain('ping.stepcanary.com');
    }
  });
});

describe('guide pages and the marketing site', () => {
  const APP = 'https://app.stepcanary.test';
  let db: Db;
  let reset: () => Promise<void>;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
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

  it('shows guides to anyone, without a sign-in', async () => {
    const index = await (await get(`${APP}/guides`)).text();
    for (const name of ['Zapier', 'Make', 'n8n', 'Pipedream']) expect(index).toContain(name);
    const page = await get(`${APP}/guides/make`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Monitor a Make scenario with StepCanary');
    expect(html).toContain('https://ping.stepcanary.test/p/…');
    expect(html).toContain('Create one free');
    expect((await get(`${APP}/guides/unknown`)).status).toBe(404);
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

    const checkPage = await (await get(`${APP}${checkPath}`, alice)).text();
    expect(checkPage).toContain(`/guides/zapier?check=${checkId}`);

    const mine = await (await get(`${APP}/guides/zapier?check=${checkId}`, alice)).text();
    expect(mine).toContain(`https://ping.stepcanary.test/p/${token}`);
    expect(mine).toContain('the real one for your check');

    const bob = await signIn('bob@example.com');
    const theirs = await (await get(`${APP}/guides/zapier?check=${checkId}`, bob)).text();
    expect(theirs).not.toContain(token);
    const anonymous = await (await get(`${APP}/guides/zapier?check=${checkId}`)).text();
    expect(anonymous).not.toContain(token);
  });

  it('serves the landing page and guides on the marketing hostname, and sends everything else to the app', async () => {
    const landing = await get('https://stepcanary.test/');
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain('Know the moment an automation stops');
    expect(html).toContain('<meta name="description"');
    expect(html).toContain('$15/month');
    expect(html).toContain('$49/month');
    expect(html).toContain('href="/guides/zapier"');
    expect((await get('https://www.stepcanary.test/guides/n8n')).status).toBe(200);

    for (const path of ['/login', '/checks', '/billing', '/auth/verify?token=abc']) {
      const res = await get(`https://stepcanary.test${path}`);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toBe(`${APP}${path}`);
    }
    // On the app hostname those pages are served normally.
    expect((await get(`${APP}/login`)).status).toBe(200);
  });

  it('sends a signed-in visitor from the app home page to their checks, but shows the landing page when signed out', async () => {
    expect((await get(`${APP}/`)).status).toBe(200);
    const cookie = await signIn('owner@example.com');
    expect((await get(`${APP}/`, cookie)).headers.get('location')).toBe('/checks');
  });
});
