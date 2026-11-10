import { describe, expect, it } from 'vitest';
import { handlePing, type IngestEnv } from '../src/ingest/index';
import { MAX_BODY_BYTES } from '../src/ingest/payload';
import { FLAG_MALFORMED, FLAG_TOO_LARGE, isPingMessage, type PingMessage } from '../src/shared/messages';
import { canaryToken, makeToken, verifyToken } from '../src/shared/token';

const SECRET = 'test-secret';

function fakeEnv(failSends = 0): { env: IngestEnv; sent: PingMessage[] } {
  const sent: PingMessage[] = [];
  let failures = failSends;
  const queue = {
    send: async (m: PingMessage) => {
      if (failures-- > 0) throw new Error('queue down');
      sent.push(m);
    },
  };
  return { env: { PINGS: queue as unknown as IngestEnv['PINGS'], TOKEN_SECRET: SECRET }, sent };
}

const post = (url: string, body: string, contentType = 'application/json') =>
  new Request(url, { method: 'POST', body, headers: { 'content-type': contentType } });

describe('ping tokens', () => {
  it('verifies tokens it issued and rejects everything else', async () => {
    const token = await makeToken(SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]{30}$/);
    expect(await verifyToken(token, SECRET)).toBe(true);
    expect(await verifyToken(token, 'other-secret')).toBe(false);
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    expect(await verifyToken(tampered, SECRET)).toBe(false);
    expect(await verifyToken('short', SECRET)).toBe(false);
    expect(await verifyToken('x'.repeat(30), SECRET)).toBe(false);
  });

  it('issues unique tokens and a stable canary token', async () => {
    const tokens = new Set(await Promise.all(Array.from({ length: 50 }, () => makeToken(SECRET))));
    expect(tokens.size).toBe(50);
    expect(await canaryToken(SECRET)).toBe(await canaryToken(SECRET));
    expect(await verifyToken(await canaryToken(SECRET), SECRET)).toBe(true);
  });
});

describe('ping endpoint', () => {
  it('accepts GET and POST and queues a message stamped with the receive time', async () => {
    const { env, sent } = fakeEnv();
    const token = await makeToken(SECRET);
    const a = await handlePing(new Request(`https://ping.test/p/${token}`), env, 1111);
    const b = await handlePing(post(`https://ping.test/p/${token}`, '{"a":1}'), env, 2222);
    expect(a.status).toBe(200);
    expect(await b.json()).toEqual({ ok: true });
    expect(sent.map((m) => [m.t, m.ts, m.k])).toEqual([[token, 1111, 'ok'], [token, 2222, 'ok']]);
    expect(sent.every(isPingMessage)).toBe(true);
    expect(sent[0].id).not.toBe(sent[1].id);
  });

  it('routes /fail and /start', async () => {
    const { env, sent } = fakeEnv();
    const token = await makeToken(SECRET);
    await handlePing(new Request(`https://ping.test/p/${token}/fail`, { method: 'POST' }), env);
    await handlePing(new Request(`https://ping.test/p/${token}/start`), env);
    await handlePing(new Request(`https://ping.test/p/${token}/`), env);
    expect(sent.map((m) => m.k)).toEqual(['fail', 'start', 'ok']);
  });

  it('returns 404 for URLs it never issued, without queueing', async () => {
    const { env, sent } = fakeEnv();
    const res = await handlePing(new Request(`https://ping.test/p/${'a'.repeat(30)}`), env);
    expect(res.status).toBe(404);
    expect((await handlePing(new Request('https://ping.test/p/nope'), env)).status).toBe(404);
    expect((await handlePing(new Request('https://ping.test/other'), env)).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it('never puts payload values on the queue, only key names and types', async () => {
    const { env, sent } = fakeEnv();
    const token = await makeToken(SECRET);
    await handlePing(post(`https://ping.test/p/${token}?src=zap-SECRETQUERY`, '{"email":"jane@secret.example","card":"4111111111111111","note":""}'), env);
    const wire = JSON.stringify(sent[0]);
    expect(wire).not.toContain('jane');
    expect(wire).not.toContain('4111');
    expect(wire).not.toContain('SECRETQUERY');
    expect(sent[0].shape).toEqual({ $: 'object', card: 'string', email: 'string', note: 'empty_string' });
    expect(sent[0].sh).toMatch(/^[0-9a-f]{32}$/);
  });

  it('still records the ping when the JSON body is malformed', async () => {
    const { env, sent } = fakeEnv();
    const token = await makeToken(SECRET);
    const res = await handlePing(post(`https://ping.test/p/${token}`, '{"name": "O"Brien"}'), env, 5000);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].ts).toBe(5000);
    expect(sent[0].f & FLAG_MALFORMED).toBe(FLAG_MALFORMED);
    expect(sent[0].shape).toBeUndefined();
  });

  it('reads form-encoded and multipart bodies', async () => {
    const { env, sent } = fakeEnv();
    const token = await makeToken(SECRET);
    await handlePing(post(`https://ping.test/p/${token}`, 'email=a%40b.co&phone=', 'application/x-www-form-urlencoded'), env);
    const form = new FormData();
    form.set('email', 'a@b.co');
    form.set('phone', '');
    await handlePing(new Request(`https://ping.test/p/${token}`, { method: 'POST', body: form }), env);
    expect(sent[0].shape).toEqual({ $: 'object', email: 'string', phone: 'empty_string' });
    expect(sent[1].shape).toEqual(sent[0].shape);
  });

  it('counts oversized bodies as pings without fingerprinting them', async () => {
    const { env, sent } = fakeEnv();
    const token = await makeToken(SECRET);
    const big = JSON.stringify({ blob: 'x'.repeat(MAX_BODY_BYTES + 10) });
    const res = await handlePing(post(`https://ping.test/p/${token}`, big), env);
    expect(res.status).toBe(200);
    expect(sent[0].f & FLAG_TOO_LARGE).toBe(FLAG_TOO_LARGE);
    expect(sent[0].shape).toBeUndefined();
  });

  it('fails loudly instead of accepting pings when TOKEN_SECRET is missing', async () => {
    const { env, sent } = fakeEnv();
    const broken = { ...env, TOKEN_SECRET: undefined as unknown as string };
    expect((await handlePing(new Request('https://ping.test/healthz'), broken)).status).toBe(503);
    expect((await handlePing(new Request(`https://ping.test/p/${await makeToken(SECRET)}`), broken)).status).toBe(503);
    expect(sent).toEqual([]);
  });

  it('retries the queue once, and still answers 200 if the queue is down', async () => {
    const token = await makeToken(SECRET);
    const flaky = fakeEnv(1);
    expect(await (await handlePing(new Request(`https://ping.test/p/${token}`), flaky.env)).json()).toEqual({ ok: true });
    expect(flaky.sent).toHaveLength(1);

    const down = fakeEnv(5);
    const res = await handlePing(new Request(`https://ping.test/p/${token}`), down.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: false });
  });
});
