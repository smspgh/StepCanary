// Ingest Worker: GET/POST /p/{token}, /p/{token}/fail, /p/{token}/start.
//
// Rules: answer 200 fast for any genuine ping URL, never touch the database, never keep the body.
// All evaluation happens later in the app Worker, off the queue.

import { shapeHash } from '../shared/fingerprint';
import { FLAG_THROTTLED, type PingKind, type PingMessage } from '../shared/messages';
import { TOKEN_PATTERN, verifyToken } from '../shared/token';
import { readPayload } from './payload';

export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface IngestEnv {
  PINGS: Queue<PingMessage>;
  TOKEN_SECRET: string;
  /** Per-token ceiling (60 pings/minute). Above it, pings are acknowledged but not queued. */
  PING_LIMITER?: Limiter;
  /** 1/minute per token: how often a throttled check may send its 'still looping' marker. */
  MARKER_LIMITER?: Limiter;
}

/** True if the limiter lets this through. Fails open: a limiter outage must never drop pings. */
async function allowed(limiter: Limiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

async function enqueue(env: IngestEnv, msg: PingMessage): Promise<boolean> {
  try {
    await env.PINGS.send(msg);
    return true;
  } catch {
    try {
      await env.PINGS.send(msg);
      return true;
    } catch (err) {
      // Still 200 to the caller: we never break a customer's workflow step. A systemic queue
      // failure also stops the canary, so the evaluator declares a monitoring gap, not an outage.
      console.error('queue_send_failed', String(err));
      return false;
    }
  }
}

const HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

const ROUTE = /^\/p\/([^/]+)(?:\/(fail|start))?\/?$/;

export async function handlePing(req: Request, env: IngestEnv, now: number = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  // A missing secret is a deployment mistake. Fail loudly (so uptime monitoring catches it)
  // rather than accept pings we cannot validate.
  if (!env.TOKEN_SECRET) {
    console.error('config_error TOKEN_SECRET is not set on the ingest Worker');
    return json({ ok: false, error: 'service_misconfigured' }, 503);
  }
  if (url.pathname === '/' || url.pathname === '/healthz') return json({ ok: true, service: 'stepcanary-ingest' });

  const match = ROUTE.exec(url.pathname);
  if (!match) return json({ ok: false, error: 'not_found' }, 404);

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...HEADERS, 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' },
    });
  }

  const token = match[1];
  if (!TOKEN_PATTERN.test(token) || !(await verifyToken(token, env.TOKEN_SECRET))) {
    return json({ ok: false, error: 'unknown_ping_url', hint: 'Copy the ping URL again from your StepCanary check.' }, 404);
  }

  const kind: PingKind = match[2] === 'fail' ? 'fail' : match[2] === 'start' ? 'start' : 'ok';

  // Runaway-loop protection, before the body is even read. A looping automation still gets its
  // 200s, but costs us one small queue message a minute instead of thousands. That marker keeps
  // the check alive and raises the 'Runaway loop detected' alert.
  if (!(await allowed(env.PING_LIMITER, token))) {
    if (await allowed(env.MARKER_LIMITER, `m:${token}`)) {
      await enqueue(env, { id: crypto.randomUUID(), t: token, ts: now, k: 'ok', f: FLAG_THROTTLED });
    }
    return json({ ok: true, throttled: true });
  }

  const payload = await readPayload(req, url);

  const msg: PingMessage = { id: crypto.randomUUID(), t: token, ts: now, k: kind, f: payload.flags };
  if (payload.shape) {
    msg.shape = payload.shape;
    msg.sh = await shapeHash(payload.shape);
  }

  const queued = await enqueue(env, msg);
  return json(queued ? { ok: true } : { ok: true, queued: false });
}

export default {
  async fetch(req: Request, env: IngestEnv): Promise<Response> {
    try {
      return await handlePing(req, env);
    } catch (err) {
      console.error('ingest_unhandled', String(err));
      return json({ ok: true, queued: false });
    }
  },
} satisfies ExportedHandler<IngestEnv>;
