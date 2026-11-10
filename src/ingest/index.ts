// Ingest Worker: GET/POST /p/{token}, /p/{token}/fail, /p/{token}/start.
//
// Rules: answer 200 fast for any genuine ping URL, never touch the database, never keep the body.
// All evaluation happens later in the app Worker, off the queue.

import { shapeHash } from '../shared/fingerprint';
import type { PingKind, PingMessage } from '../shared/messages';
import { TOKEN_PATTERN, verifyToken } from '../shared/token';
import { readPayload } from './payload';

export interface IngestEnv {
  PINGS: Queue<PingMessage>;
  TOKEN_SECRET: string;
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
  const payload = await readPayload(req, url);

  const msg: PingMessage = { id: crypto.randomUUID(), t: token, ts: now, k: kind, f: payload.flags };
  if (payload.shape) {
    msg.shape = payload.shape;
    msg.sh = await shapeHash(payload.shape);
  }

  let queued = true;
  try {
    await env.PINGS.send(msg);
  } catch {
    try {
      await env.PINGS.send(msg);
    } catch (err) {
      // Still 200: we never break a customer's workflow step. A systemic queue failure also stops
      // the canary, which makes the evaluator declare a monitoring gap instead of alerting.
      queued = false;
      console.error('queue_send_failed', String(err));
    }
  }

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
