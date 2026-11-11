// AES-GCM encryption for the few customer secrets we hold (alert webhook URLs).
// The key comes from the CHANNEL_KEY secret; any sufficiently random string works because it is
// hashed to 256 bits. Stored format: "v1.<iv>.<ciphertext>", base64url.

import { toBase64Url } from './token';

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function aesKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle
      .digest('SHA-256', enc.encode(`stepcanary:channel-key:${secret}`))
      .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
    keys.set(secret, k);
  }
  return k;
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  if (!secret) throw new Error('CHANNEL_KEY is not set');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

export async function decryptSecret(stored: string, secret: string): Promise<string> {
  if (!secret) throw new Error('CHANNEL_KEY is not set');
  const [version, iv, ct] = stored.split('.');
  if (version !== 'v1' || !iv || !ct) throw new Error('unrecognised encrypted value');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv) }, await aesKey(secret), fromBase64Url(ct));
  return new TextDecoder().decode(plain);
}
