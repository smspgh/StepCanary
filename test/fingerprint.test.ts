import { describe, expect, it } from 'vitest';
import { analyzePayload } from '../src/ingest/payload';
import { MAX_KEYS, normalizeKey, shapeHash, shapeKeys, shapeOf, typeOf } from '../src/shared/fingerprint';
import { FLAG_MALFORMED, FLAG_TRUNCATED } from '../src/shared/messages';

const q = (s = '') => new URLSearchParams(s);

describe('value types', () => {
  it('distinguishes empty values from populated ones', () => {
    expect(typeOf('hello')).toBe('string');
    expect(typeOf('')).toBe('empty_string');
    expect(typeOf('   \n\t')).toBe('empty_string'); // whitespace-only counts as empty
    expect(typeOf(null)).toBe('null');
    expect(typeOf([1])).toBe('array');
    expect(typeOf([])).toBe('empty_array');
    expect(typeOf({ a: 1 })).toBe('object');
    expect(typeOf({})).toBe('empty_object');
    expect(typeOf(0)).toBe('number');
    expect(typeOf(false)).toBe('boolean');
  });
});

describe('shape fingerprint', () => {
  it('records sorted key paths and types, never values', () => {
    const { shape } = shapeOf({ email: 'jane@example.com', amount: 42, tags: ['a', 'b'], customer: { id: 7, vip: true } });
    expect(shape).toEqual({
      $: 'object',
      amount: 'number',
      customer: 'object',
      'customer.id': 'number',
      'customer.vip': 'boolean',
      email: 'string',
      tags: 'array',
      'tags[]': 'string',
    });
    expect(JSON.stringify(shape)).not.toContain('jane');
    expect(JSON.stringify(shape)).not.toContain('42');
  });

  it('is the same for different values and different key order', async () => {
    const a = shapeOf({ name: 'Ann', total: 10 }).shape;
    const b = shapeOf({ total: 99999, name: 'Bob' }).shape;
    expect(await shapeHash(a)).toBe(await shapeHash(b));
  });

  it('changes when a mapped field silently goes blank (the Zapier/Make failure mode)', async () => {
    const good = shapeOf({ email: 'jane@example.com', phone: '555-0100', items: [1] }).shape;
    const blank = shapeOf({ email: '', phone: '555-0100', items: [1] }).shape;
    const spaces = shapeOf({ email: '  ', phone: '555-0100', items: [1] }).shape;
    const isNull = shapeOf({ email: null, phone: '555-0100', items: [1] }).shape;
    const emptyList = shapeOf({ email: 'jane@example.com', phone: '555-0100', items: [] }).shape;

    expect(blank.email).toBe('empty_string');
    expect(spaces.email).toBe('empty_string');
    expect(isNull.email).toBe('null');
    expect(emptyList.items).toBe('empty_array');

    const hashes = await Promise.all([good, blank, isNull, emptyList].map(shapeHash));
    expect(new Set(hashes).size).toBe(4); // all four are different shapes
    expect(await shapeHash(blank)).toBe(await shapeHash(spaces));
  });

  it('changes when keys are added, removed or change type', async () => {
    const base = await shapeHash(shapeOf({ a: 1, b: 'x' }).shape);
    expect(await shapeHash(shapeOf({ a: 1, b: 'x', c: true }).shape)).not.toBe(base);
    expect(await shapeHash(shapeOf({ a: 1 }).shape)).not.toBe(base);
    expect(await shapeHash(shapeOf({ a: '1', b: 'x' }).shape)).not.toBe(base);
  });

  it('merges array elements so list length does not matter', async () => {
    const one = shapeOf({ rows: [{ id: 1 }] }).shape;
    const many = shapeOf({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }).shape;
    expect(await shapeHash(one)).toBe(await shapeHash(many));
    expect(shapeOf({ rows: [{ id: 1 }, { id: 'x' }, null] }).shape).toMatchObject({ 'rows[]': 'null|object', 'rows[].id': 'number|string' });
  });

  it('handles top-level arrays and scalars', () => {
    expect(shapeOf([{ a: 1 }]).shape).toEqual({ $: 'array', '$[]': 'object', '$[].a': 'number' });
    expect(shapeOf('just text').shape).toEqual({ $: 'string' });
    expect(shapeKeys(shapeOf({ a: 1 }).shape)).toEqual(['a']);
  });

  it('replaces dynamic keys with placeholders so personal data cannot leak into key names', async () => {
    expect(normalizeKey('jane.doe@example.com')).toBe('<email>');
    expect(normalizeKey('3f2b8c1e-7a4d-4e9b-9c1a-2b3c4d5e6f70')).toBe('<uuid>');
    expect(normalizeKey('12345')).toBe('<number>');
    expect(normalizeKey('x'.repeat(65))).toBe('<long_key>');
    expect(normalizeKey('x'.repeat(64))).toBe('x'.repeat(64));
    expect(normalizeKey('order_id')).toBe('order_id');

    const a = shapeOf({ users: { 'jane@example.com': { plan: 'pro' } }, byId: { '3f2b8c1e-7a4d-4e9b-9c1a-2b3c4d5e6f70': 1 } }).shape;
    const b = shapeOf({ users: { 'bob@example.org': { plan: 'free' } }, byId: { '11111111-2222-4333-8444-555555555555': 2 } }).shape;
    expect(Object.keys(a)).toContain('users.<email>.plan');
    expect(Object.keys(a)).toContain('byId.<uuid>');
    expect(JSON.stringify(a)).not.toContain('jane');
    expect(await shapeHash(a)).toBe(await shapeHash(b)); // no drift alert for a different customer
  });

  it('caps depth at 5 and flags the shape as truncated', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'too deep' } } } } } } };
    const { shape, truncated } = shapeOf(deep);
    expect(truncated).toBe(true);
    expect(shape['l1.l2.l3.l4.l5']).toBe('object');
    expect(shape['l1.l2.l3.l4.l5.l6']).toBeUndefined();
    expect(shapeOf({ a: { b: 1 } }).truncated).toBe(false);
  });

  it('caps the number of keys at 200', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 500; i++) wide[`field_${i}`] = i;
    const { shape, truncated } = shapeOf(wide);
    expect(truncated).toBe(true);
    expect(Object.keys(shape).length).toBe(MAX_KEYS);
  });
});

describe('forgiving payload parsing', () => {
  it('treats JSON, form-encoded bodies and query parameters interchangeably', async () => {
    const json = analyzePayload('application/json', '{"email":"a@b.co","name":"Ann"}', q());
    const form = analyzePayload('application/x-www-form-urlencoded', 'email=a%40b.co&name=Ann', q());
    const query = analyzePayload('', null, q('email=a@b.co&name=Ann'));
    expect(json.flags).toBe(0);
    expect(json.shape).toEqual({ $: 'object', email: 'string', name: 'string' });
    expect(form.shape).toEqual(json.shape);
    expect(query.shape).toEqual(json.shape);
  });

  it('detects blank form and query fields', () => {
    expect(analyzePayload('application/x-www-form-urlencoded', 'email=&name=Ann', q()).shape!.email).toBe('empty_string');
    expect(analyzePayload('', null, q('email=%20&name=Ann')).shape!.email).toBe('empty_string');
  });

  it('turns repeated form keys into an array', () => {
    expect(analyzePayload('application/x-www-form-urlencoded', 'tag=a&tag=b', q()).shape).toEqual({ $: 'object', tag: 'array', 'tag[]': 'string' });
  });

  it('flags malformed JSON instead of failing (unescaped quote from a mapped field)', () => {
    const r = analyzePayload('application/json', '{"note": "she said "hi"", "id": 1}', q());
    expect(r.flags & FLAG_MALFORMED).toBe(FLAG_MALFORMED);
    expect(r.shape).toBeUndefined();
  });

  it('falls back to query parameters when the JSON body is malformed', () => {
    const r = analyzePayload('application/json', '{"broken": ', q('source=zapier'));
    expect(r.flags & FLAG_MALFORMED).toBe(FLAG_MALFORMED);
    expect(r.shape).toEqual({ $: 'object', source: 'string' });
  });

  it('parses JSON even when the content type is missing or wrong', () => {
    expect(analyzePayload('', '{"a":1}', q()).shape).toEqual({ $: 'object', a: 'number' });
    expect(analyzePayload('text/plain', ' [1,2] ', q()).shape).toEqual({ $: 'array', '$[]': 'number' });
    const broken = analyzePayload('text/plain', '{"a":', q());
    expect(broken.flags & FLAG_MALFORMED).toBe(FLAG_MALFORMED);
  });

  it('ignores plain text bodies without complaint', () => {
    expect(analyzePayload('text/plain', 'all good', q())).toEqual({ flags: 0 });
    expect(analyzePayload('', '', q())).toEqual({ flags: 0 });
    expect(analyzePayload('application/json', '   ', q())).toEqual({ flags: 0 });
  });

  it('passes the truncated flag through', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 300; i++) wide[`f${i}x`] = i;
    expect(analyzePayload('application/json', JSON.stringify(wide), q()).flags & FLAG_TRUNCATED).toBe(FLAG_TRUNCATED);
  });
});
