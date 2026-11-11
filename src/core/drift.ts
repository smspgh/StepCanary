// Payload drift: compare an observed shape with the accepted one. Pure functions.
// Everything here deals in key paths and type names only; payload values never get this far.

import { ROOT, type Shape } from '../shared/fingerprint';

export type DriftChange =
  | { kind: 'added'; path: string; types: string[] }
  | { kind: 'removed'; path: string; was: string[] }
  | { kind: 'type'; path: string; was: string[]; now: string[] };

/** Types that mean "nothing here": what a broken no-code mapping usually produces. */
export const EMPTY_TYPES = new Set(['null', 'empty_string', 'empty_array', 'empty_object']);

const split = (types: string | undefined): string[] => (types ? types.split('|') : []);
const label = (path: string): string => (path === ROOT ? '(whole payload)' : path);

function parentOf(path: string): string | null {
  if (path === ROOT) return null;
  if (path.endsWith('[]')) return path.slice(0, -2);
  const dot = path.lastIndexOf('.');
  const bracket = path.lastIndexOf('[]');
  if (dot === -1) return ROOT;
  // "a[].b" -> "a[]"; "a.b" -> "a"
  return bracket > dot ? path.slice(0, bracket + 2) : path.slice(0, dot);
}

/**
 * Differences between the accepted shape and an observed one.
 *  - Optional paths may be missing, or hold an empty value, without counting as drift.
 *  - When a parent changes, its children are not listed separately (one line per real change).
 */
export function diffShape(accepted: Shape, observed: Shape, optional: readonly string[] = []): DriftChange[] {
  const opt = new Set(optional);
  const changes: DriftChange[] = [];
  const changed = new Set<string>();
  const underChanged = (path: string): boolean => {
    for (let p = parentOf(path); p != null; p = parentOf(p)) if (changed.has(p)) return true;
    return false;
  };

  const paths = [...new Set([...Object.keys(accepted), ...Object.keys(observed)])].sort(
    (a, b) => a.split(/\.|\[\]/).length - b.split(/\.|\[\]/).length || a.localeCompare(b),
  );

  for (const path of paths) {
    if (underChanged(path)) continue;
    const was = split(accepted[path]);
    const now = split(observed[path]);
    if (was.length && !now.length) {
      if (opt.has(path)) {
        changed.add(path); // children of a missing optional key are not drift either
        continue;
      }
      changes.push({ kind: 'removed', path, was });
      changed.add(path);
    } else if (!was.length && now.length) {
      changes.push({ kind: 'added', path, types: now });
      changed.add(path);
    } else {
      const fresh = now.filter((t) => !was.includes(t) && !(opt.has(path) && EMPTY_TYPES.has(t)));
      if (fresh.length) {
        changes.push({ kind: 'type', path, was, now });
        changed.add(path);
      } else if (now.some((t) => !was.includes(t))) {
        changed.add(path); // optional key went empty: fine, and so is losing its children
      }
    }
  }
  return changes;
}

/** "Accept new shape": the observed shape becomes the new normal. */
export function acceptShape(observed: Shape): Shape {
  return { ...observed };
}

/**
 * "Mark key as optional": every changed key becomes optional, and any new types or keys seen are
 * added to what is accepted. Afterwards the same payload no longer counts as drift.
 */
export function markOptional(accepted: Shape, observed: Shape, optional: readonly string[]): { accepted: Shape; optional: string[] } {
  const changes = diffShape(accepted, observed, optional);
  const nextOptional = new Set(optional);
  const next: Shape = { ...accepted };
  for (const c of changes) nextOptional.add(c.path);
  // Union in everything observed so newly seen children and types are known from now on.
  for (const [path, types] of Object.entries(observed)) {
    next[path] = [...new Set([...split(next[path]), ...split(types)])].sort().join('|');
  }
  // Keys that only exist in the new payload are optional too, including their children.
  for (const path of Object.keys(observed)) if (!(path in accepted)) nextOptional.add(path);
  return { accepted: next, optional: [...nextOptional].sort() };
}

const TYPE_WORDS: Record<string, string> = {
  string: 'text',
  empty_string: 'blank text',
  number: 'a number',
  boolean: 'true/false',
  null: 'null (no value)',
  object: 'a group of fields',
  empty_object: 'an empty group',
  array: 'a list',
  empty_array: 'an empty list',
};
const words = (types: string[]): string => types.map((t) => TYPE_WORDS[t] ?? t).join(' or ');

/** One plain-English line per change. Key names only. */
export function describeChanges(changes: DriftChange[], limit = 12): string[] {
  const lines = changes.slice(0, limit).map((c) => {
    if (c.kind === 'added') return `New key "${label(c.path)}" appeared (${words(c.types)}).`;
    if (c.kind === 'removed') return `Key "${label(c.path)}" is missing (it used to be ${words(c.was)}).`;
    const wentBlank = c.now.some((t) => EMPTY_TYPES.has(t)) && !c.was.some((t) => EMPTY_TYPES.has(t));
    return wentBlank
      ? `Key "${label(c.path)}" is now ${words(c.now.filter((t) => !c.was.includes(t)))} (it used to be ${words(c.was)}). A mapped field may have stopped filling in.`
      : `Key "${label(c.path)}" changed from ${words(c.was)} to ${words(c.now)}.`;
  });
  if (changes.length > limit) lines.push(`…and ${changes.length - limit} more.`);
  return lines;
}
