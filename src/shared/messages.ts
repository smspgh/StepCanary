import type { Shape } from './fingerprint';

export type PingKind = 'ok' | 'fail' | 'start';

export const FLAG_MALFORMED = 1; // body claimed to be JSON but could not be parsed
export const FLAG_TOO_LARGE = 2; // body over the size cap; counted but not fingerprinted
export const FLAG_TRUNCATED = 4; // shape hit the depth/key caps

/** What the ingest Worker puts on the queue. Contains key names and types only, never values. */
export interface PingMessage {
  id: string;
  t: string; // token
  ts: number; // epoch ms, stamped at the edge on receipt
  k: PingKind;
  f: number; // flags
  shape?: Shape;
  sh?: string; // shape hash
}

export function isPingMessage(m: unknown): m is PingMessage {
  if (!m || typeof m !== 'object') return false;
  const x = m as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    typeof x.t === 'string' &&
    typeof x.ts === 'number' &&
    Number.isFinite(x.ts) &&
    (x.k === 'ok' || x.k === 'fail' || x.k === 'start') &&
    typeof x.f === 'number'
  );
}
