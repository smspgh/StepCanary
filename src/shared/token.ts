// Ping tokens are self-validating: 16 random bytes + a 6-byte HMAC tag, base64url-encoded (30 chars).
// The ingest Worker can therefore reject made-up URLs without a database lookup.

const RAND_LEN = 22; // base64url length of 16 bytes
const TAG_LEN = 8; // base64url length of 6 bytes
export const TOKEN_LENGTH = RAND_LEN + TAG_LEN;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{30}$/;

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, k);
  }
  return k;
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}

async function tagFor(secret: string, rand: string): Promise<string> {
  return toBase64Url((await hmac(secret, `ping-token:${rand}`)).slice(0, 6));
}

export async function makeToken(secret: string): Promise<string> {
  const rand = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  return rand + (await tagFor(secret, rand));
}

export async function verifyToken(token: string, secret: string): Promise<boolean> {
  if (!TOKEN_PATTERN.test(token)) return false;
  const expected = await tagFor(secret, token.slice(0, RAND_LEN));
  const actual = token.slice(RAND_LEN);
  let diff = 0;
  for (let i = 0; i < TAG_LEN; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

/** The internal canary's token, derived from the secret so both Workers agree with no extra config. */
export async function canaryToken(secret: string): Promise<string> {
  const rand = toBase64Url((await hmac(secret, 'stepcanary:canary')).slice(0, 16));
  return rand + (await tagFor(secret, rand));
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function randomSecret(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
