import { describe, expect, it } from 'vitest';
import { assessDrift } from '../src/app/consumer';
import { acceptShape, describeChanges, diffShape, markOptional } from '../src/core/drift';
import { shapeOf } from '../src/shared/fingerprint';

const shape = (v: unknown) => shapeOf(v).shape;
const base = shape({ email: 'a@b.co', phone: '555', order: { id: 1, items: [{ sku: 'x' }] } });

describe('payload drift detection', () => {
  it('reports nothing when the shape is the same, whatever the values', () => {
    expect(diffShape(base, shape({ email: 'z@y.co', phone: '999', order: { id: 42, items: [{ sku: 'q' }, { sku: 'r' }] } }))).toEqual([]);
  });

  it('reports added, removed and retyped keys', () => {
    const now = shape({ email: 'a@b.co', order: { id: 'A-1', items: [{ sku: 'x' }] }, coupon: 'SAVE' });
    expect(diffShape(base, now)).toEqual([
      { kind: 'added', path: 'coupon', types: ['string'] },
      { kind: 'removed', path: 'phone', was: ['string'] },
      { kind: 'type', path: 'order.id', was: ['number'], now: ['string'] },
    ]);
  });

  it('catches a mapped field silently going blank, null or empty', () => {
    expect(diffShape(base, shape({ email: '', phone: '555', order: { id: 1, items: [{ sku: 'x' }] } }))).toEqual([
      { kind: 'type', path: 'email', was: ['string'], now: ['empty_string'] },
    ]);
    expect(diffShape(base, shape({ email: '   ', phone: '555', order: { id: 1, items: [{ sku: 'x' }] } }))[0]).toMatchObject({ now: ['empty_string'] });
    expect(diffShape(base, shape({ email: null, phone: '555', order: { id: 1, items: [{ sku: 'x' }] } }))[0]).toMatchObject({ now: ['null'] });
    // The list emptied: one change, not a second one for the children that vanished with it.
    expect(diffShape(base, shape({ email: 'a@b.co', phone: '555', order: { id: 1, items: [] } }))).toEqual([
      { kind: 'type', path: 'order.items', was: ['array'], now: ['empty_array'] },
    ]);
  });

  it('reports a removed parent once, not once per child', () => {
    expect(diffShape(base, shape({ email: 'a@b.co', phone: '555' }))).toEqual([{ kind: 'removed', path: 'order', was: ['object'] }]);
  });

  it('lets optional keys be missing or blank, but still flags a real type change', () => {
    const optional = ['phone'];
    expect(diffShape(base, shape({ email: 'a@b.co', order: { id: 1, items: [{ sku: 'x' }] } }), optional)).toEqual([]);
    expect(diffShape(base, shape({ email: 'a@b.co', phone: '', order: { id: 1, items: [{ sku: 'x' }] } }), optional)).toEqual([]);
    expect(diffShape(base, shape({ email: 'a@b.co', phone: null, order: { id: 1, items: [{ sku: 'x' }] } }), optional)).toEqual([]);
    expect(diffShape(base, shape({ email: 'a@b.co', phone: 5551234, order: { id: 1, items: [{ sku: 'x' }] } }), optional)).toHaveLength(1);
    // An optional group may disappear along with everything inside it.
    expect(diffShape(base, shape({ email: 'a@b.co', phone: '555' }), ['order'])).toEqual([]);
  });

  it('"Accept new shape" makes the new payload the normal one', () => {
    const changed = shape({ email: 'a@b.co', coupon: 'X' });
    const accepted = acceptShape(changed);
    expect(diffShape(accepted, changed)).toEqual([]);
    expect(diffShape(accepted, base).length).toBeGreaterThan(0); // the old shape would now be the drift
  });

  it('"Mark as optional" stops alerts for those keys in both directions', () => {
    const withCoupon = shape({ email: 'a@b.co', phone: '', order: { id: 1, items: [{ sku: 'x' }] }, coupon: 'SAVE' });
    const next = markOptional(base, withCoupon, []);
    expect(next.optional).toEqual(['coupon', 'phone']);
    expect(diffShape(next.accepted, withCoupon, next.optional)).toEqual([]);
    expect(diffShape(next.accepted, base, next.optional)).toEqual([]); // coupon absent again: fine
    expect(diffShape(next.accepted, shape({ email: 'a@b.co', phone: null, order: { id: 1, items: [{ sku: 'x' }] } }), next.optional)).toEqual([]);
    // A required key going blank is still caught.
    expect(diffShape(next.accepted, shape({ email: '', phone: '555', order: { id: 1, items: [{ sku: 'x' }] } }), next.optional)).toHaveLength(1);
  });

  it('describes changes in plain English using key names only', () => {
    const lines = describeChanges(
      diffShape(base, shape({ email: '', order: { id: 'A', items: [{ sku: 'x' }] }, coupon: 'SECRET-VALUE' })),
    );
    expect(lines).toEqual([
      'New key "coupon" appeared (text).',
      'Key "email" is now blank text (it used to be text). A mapped field may have stopped filling in.',
      'Key "phone" is missing (it used to be text).',
      'Key "order.id" changed from a number to text.',
    ]);
    expect(lines.join(' ')).not.toContain('SECRET-VALUE');
  });

  it('caps a long list of changes', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 30; i++) many[`f${i}`] = i;
    const lines = describeChanges(diffShape(shape({ a: 1 }), shape({ a: 1, ...many })));
    expect(lines).toHaveLength(13);
    expect(lines[12]).toBe('…and 18 more.');
  });
});

describe('drift across a batch of pings', () => {
  const off = { driftEnabled: false, acceptedShape: null, optionalPaths: [] };
  const fresh = { driftEnabled: true, acceptedShape: null, optionalPaths: [] };

  it('does nothing when drift detection is off', () => {
    expect(assessDrift(off, [base, shape({ other: 1 })])).toEqual({ accepted: null, pending: null, changes: [] });
  });

  it('treats the first payload it sees as normal', () => {
    const r = assessDrift(fresh, [base, base]);
    expect(r.accepted).toEqual(base);
    expect(r.pending).toBeNull();
  });

  it('flags a later payload that differs, keeping the accepted shape unchanged', () => {
    const blank = shape({ email: '', phone: '555', order: { id: 1, items: [{ sku: 'x' }] } });
    const r = assessDrift({ driftEnabled: true, acceptedShape: base, optionalPaths: [] }, [base, blank]);
    expect(r.accepted).toEqual(base);
    expect(r.pending).toEqual(blank);
    expect(r.changes[0]).toContain('"email" is now blank text');
  });
});
