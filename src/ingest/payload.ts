// Forgiving payload reading. Nothing here can throw a ping away: whatever goes wrong while
// reading or parsing, the caller still records the ping's timestamp.

import { shapeOf, type Shape } from '../shared/fingerprint';
import { FLAG_MALFORMED, FLAG_TOO_LARGE, FLAG_TRUNCATED } from '../shared/messages';

export const MAX_BODY_BYTES = 256 * 1024;

export interface PayloadResult {
  shape?: Shape;
  flags: number;
}

/** Turn repeated form/query keys into arrays, single keys into strings. */
export function entriesToObject(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, raw] of entries) {
    // Uploaded files count as a populated value; their contents are never looked at.
    const value = typeof raw === 'string' ? raw : 'file';
    if (key in out) {
      const prev = out[key];
      if (Array.isArray(prev)) prev.push(value);
      else out[key] = [prev, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function finish(value: unknown, flags: number): PayloadResult {
  const { shape, truncated } = shapeOf(value);
  return { shape, flags: flags | (truncated ? FLAG_TRUNCATED : 0) };
}

/**
 * Decide the payload shape from the content type, the body text and the query string.
 * JSON, form-encoded bodies and query parameters are interchangeable; a body wins over the query.
 */
export function analyzePayload(contentType: string, bodyText: string | null, query: URLSearchParams): PayloadResult {
  const ct = contentType.toLowerCase();
  const body = bodyText?.trim() ?? '';
  let flags = 0;

  if (body !== '') {
    const isForm = ct.includes('application/x-www-form-urlencoded');
    const looksJson = body.startsWith('{') || body.startsWith('[');
    if (ct.includes('json') || (!isForm && looksJson)) {
      try {
        return finish(JSON.parse(body), flags);
      } catch {
        // Typical cause: an unescaped quote or newline in a mapped no-code field.
        flags |= FLAG_MALFORMED;
      }
    } else if (isForm) {
      return finish(entriesToObject(new URLSearchParams(body)), flags);
    } else {
      // Unlabelled body: accept JSON scalars quietly, ignore plain text.
      try {
        return finish(JSON.parse(body), flags);
      } catch {
        /* plain text: no shape, not an error */
      }
    }
  }

  if ([...query.keys()].length > 0) return finish(entriesToObject(query), flags);
  return { flags };
}

async function readCapped(req: Request, cap: number): Promise<{ bytes: Uint8Array; tooLarge: boolean }> {
  const empty = new Uint8Array(0);
  if (Number(req.headers.get('content-length') ?? 0) > cap) return { bytes: empty, tooLarge: true };
  if (!req.body) return { bytes: empty, tooLarge: false };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { bytes: empty, tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, tooLarge: false };
}

/** Read a request's payload shape. Never throws. The body is dropped as soon as this returns. */
export async function readPayload(req: Request, url: URL): Promise<PayloadResult> {
  try {
    const ct = req.headers.get('content-type') ?? '';
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    if (!hasBody) return analyzePayload(ct, null, url.searchParams);

    const { bytes, tooLarge } = await readCapped(req, MAX_BODY_BYTES);
    if (tooLarge) {
      const r = analyzePayload(ct, null, url.searchParams);
      return { ...r, flags: r.flags | FLAG_TOO_LARGE };
    }

    if (ct.toLowerCase().includes('multipart/form-data') && bytes.byteLength > 0) {
      try {
        const form = await new Response(bytes, { headers: { 'content-type': ct } }).formData();
        return finish(entriesToObject(form as unknown as Iterable<[string, unknown]>), 0);
      } catch {
        const r = analyzePayload('', null, url.searchParams);
        return { ...r, flags: r.flags | FLAG_MALFORMED };
      }
    }

    return analyzePayload(ct, new TextDecoder().decode(bytes), url.searchParams);
  } catch {
    return { flags: 0 };
  }
}
