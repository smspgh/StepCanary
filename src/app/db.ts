// Minimal database seam: plain parameterised SQL behind a two-method interface, so the same
// queries run on postgres.js in production and on PGlite (in-process Postgres) in tests.
//
// Conventions that keep the two drivers interchangeable:
//  - timestamps go in as ISO strings with an explicit ::timestamptz cast, and come out via ms()
//  - JSON goes in as a string with ::text::jsonb (a bare ::jsonb makes postgres.js JSON-encode the
//    string a second time), and comes out via asJson()
//  - ids are text; counts are cast to int

import type { CheckConfig, CheckState, CheckStatus } from '../core/evaluate';
import type { Baseline } from '../core/volume';
import type { Shape } from '../shared/fingerprint';

export type Row = Record<string, any>;

export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export function ms(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? t : null;
}

export function iso(t: number | null | undefined): string | null {
  return t == null || !Number.isFinite(t) ? null : new Date(t).toISOString();
}

export function asJson<T>(v: unknown): T | null {
  if (v == null) return null;
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

export interface Check {
  id: string;
  accountId: string;
  name: string;
  token: string;
  cfg: CheckConfig;
  state: CheckState;
  statusChangedAt: number | null;
  nextEvalAt: number | null;
  lastShape: Shape | null;
  payloadWarning: string | null;
  createdAt: number | null;
  folderId: string | null;
  firstPingAt: number | null;
  pausedReason: string | null;
  baselineStatus: 'learning' | 'ready' | 'active' | null;
  baseline: Baseline | null;
  volumeEvaluatedUntil: number | null;
  driftEnabled: boolean;
  acceptedShape: Shape | null;
  optionalPaths: string[];
  pendingShape: Shape | null;
  runawayAt: number | null;
}

export function toCheck(r: Row): Check {
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    token: r.token,
    cfg: {
      mode: r.mode,
      intervalSeconds: r.interval_seconds,
      cron: r.cron,
      timezone: r.timezone,
      graceSeconds: r.grace_seconds,
      activeWindow: asJson(r.active_window),
      volumeThresholdPct: r.volume_threshold_pct ?? null,
    },
    state: {
      status: r.status as CheckStatus,
      lastPingAt: ms(r.last_ping_at),
      lastStartAt: ms(r.last_start_at),
      lastFailAt: ms(r.last_fail_at),
      clockResetAt: ms(r.clock_reset_at),
    },
    statusChangedAt: ms(r.status_changed_at),
    nextEvalAt: ms(r.next_eval_at),
    lastShape: asJson<Shape>(r.last_shape),
    payloadWarning: r.payload_warning,
    createdAt: ms(r.created_at),
    folderId: r.folder_id ?? null,
    firstPingAt: ms(r.first_ping_at),
    pausedReason: r.paused_reason ?? null,
    baselineStatus: r.baseline_status ?? null,
    baseline: asJson<Baseline>(r.baseline),
    volumeEvaluatedUntil: ms(r.volume_evaluated_until),
    driftEnabled: r.drift_enabled === true,
    acceptedShape: asJson<Shape>(r.accepted_shape),
    optionalPaths: asJson<string[]>(r.optional_paths) ?? [],
    pendingShape: asJson<Shape>(r.pending_shape),
    runawayAt: ms(r.runaway_at),
  };
}

// --- system_state -----------------------------------------------------------------------------

export const CANARY_KEY = 'canary_last_ping_at';

export async function getState(db: Db, key: string): Promise<string | null> {
  const rows = await db.query<{ value: string }>('SELECT value FROM system_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setState(db: Db, key: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

// --- monitoring gaps --------------------------------------------------------------------------

/** Record a monitoring gap, merging it into an adjacent/overlapping one if there is one. */
export async function recordGap(db: Db, start: number, end: number, reason: string): Promise<void> {
  const merged = await db.query(
    `UPDATE monitoring_gaps
        SET started_at = LEAST(started_at, $1::timestamptz), ended_at = GREATEST(ended_at, $2::timestamptz)
      WHERE id = (SELECT id FROM monitoring_gaps
                   WHERE ended_at >= $1::timestamptz - interval '150 seconds' AND started_at <= $2::timestamptz
                   ORDER BY ended_at DESC LIMIT 1)
      RETURNING id`,
    [iso(start), iso(end)],
  );
  if (merged.length) return;
  await db.query(
    `INSERT INTO monitoring_gaps (id, started_at, ended_at, reason)
     VALUES (gen_random_uuid()::text, $1::timestamptz, $2::timestamptz, $3)`,
    [iso(start), iso(end), reason],
  );
}

export async function latestGapEnd(db: Db): Promise<number | null> {
  const rows = await db.query('SELECT max(ended_at) AS ended_at FROM monitoring_gaps');
  return ms(rows[0]?.ended_at);
}

export interface GapRow {
  startedAt: number;
  endedAt: number;
  reason: string;
}

export async function gapsSince(db: Db, since: number): Promise<GapRow[]> {
  const rows = await db.query(
    'SELECT started_at, ended_at, reason FROM monitoring_gaps WHERE ended_at >= $1::timestamptz ORDER BY started_at DESC LIMIT 20',
    [iso(since)],
  );
  return rows.map((r) => ({ startedAt: ms(r.started_at)!, endedAt: ms(r.ended_at)!, reason: r.reason }));
}

export async function gapsOverlapping(db: Db, start: number, end: number): Promise<{ start: number; end: number }[]> {
  const rows = await db.query(
    'SELECT started_at, ended_at FROM monitoring_gaps WHERE started_at < $2::timestamptz AND ended_at > $1::timestamptz',
    [iso(start), iso(end)],
  );
  return rows.map((r) => ({ start: ms(r.started_at)!, end: ms(r.ended_at)! }));
}

/** Successful-ping counts per UTC hour for one check. */
export async function hourlyCounts(db: Db, checkId: string, start: number, end: number): Promise<{ hour: number; ok: number }[]> {
  const rows = await db.query(
    'SELECT hour, ok FROM ping_hourly WHERE check_id = $1 AND hour >= $2::timestamptz AND hour < $3::timestamptz',
    [checkId, iso(Math.floor(start / 3_600_000) * 3_600_000), iso(end)],
  );
  return rows.map((r) => ({ hour: ms(r.hour)!, ok: r.ok }));
}
