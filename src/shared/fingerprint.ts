// Payload "shape fingerprint": sorted key paths + value types. Values are never kept.
//
// Empty values are distinct types on purpose: in Zapier/Make a broken mapping usually arrives as ""
// rather than null or a missing key, so `string` -> `empty_string` must be visible as drift.

import { sha256Hex } from './token';

export type ValueType =
  | 'string'
  | 'empty_string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'object'
  | 'empty_object'
  | 'array'
  | 'empty_array';

/** path -> value types seen at that path, sorted and joined with "|". */
export type Shape = Record<string, string>;

export const MAX_DEPTH = 5;
export const MAX_KEYS = 200;
export const MAX_PATH_LENGTH = 256;
export const ROOT = '$';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;

/**
 * Dynamic keys (emails, ids, counters) are replaced with placeholders so that personal data
 * can't leak into stored key paths and so they don't cause a drift alert on every ping.
 */
export function normalizeKey(key: string): string {
  if (EMAIL.test(key)) return '<email>';
  if (UUID.test(key)) return '<uuid>';
  if (NUMERIC.test(key)) return '<number>';
  if (key.length > 64) return '<long_key>';
  return key;
}

export function typeOf(value: unknown): ValueType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value.trim() === '' ? 'empty_string' : 'string';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return value.length === 0 ? 'empty_array' : 'array';
  if (typeof value === 'object') return Object.keys(value as object).length === 0 ? 'empty_object' : 'object';
  return 'string';
}

export interface ShapeResult {
  shape: Shape;
  /** True when the depth, key-count or path-length cap cut the shape short. */
  truncated: boolean;
}

export function shapeOf(root: unknown): ShapeResult {
  const types = new Map<string, Set<ValueType>>();
  let truncated = false;

  const add = (path: string, t: ValueType): boolean => {
    let set = types.get(path);
    if (!set) {
      if (types.size >= MAX_KEYS || path.length > MAX_PATH_LENGTH) {
        truncated = true;
        return false;
      }
      set = new Set();
      types.set(path, set);
    }
    set.add(t);
    return true;
  };

  const visit = (value: unknown, path: string, depth: number): void => {
    const t = typeOf(value);
    if (!add(path, t)) return;
    if (t === 'object') {
      if (depth >= MAX_DEPTH) {
        truncated = true;
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj).sort()) {
        const k = normalizeKey(key);
        visit(obj[key], path === ROOT ? k : `${path}.${k}`, depth + 1);
      }
    } else if (t === 'array') {
      if (depth >= MAX_DEPTH) {
        truncated = true;
        return;
      }
      // All elements merge into one "[]" path, so list length never affects the shape.
      for (const el of value as unknown[]) visit(el, `${path}[]`, depth + 1);
    }
  };

  visit(root, ROOT, 0);

  const shape: Shape = {};
  for (const path of [...types.keys()].sort()) shape[path] = [...types.get(path)!].sort().join('|');
  return { shape, truncated };
}

/** Stable hash of a shape (key order independent because shapes are built sorted). */
export async function shapeHash(shape: Shape): Promise<string> {
  const canonical = JSON.stringify(Object.keys(shape).sort().map((k) => [k, shape[k]]));
  return (await sha256Hex(canonical)).slice(0, 32);
}

/** Key paths for display ("Detected keys"), without the root marker. */
export function shapeKeys(shape: Shape): string[] {
  return Object.keys(shape).filter((k) => k !== ROOT).sort();
}
