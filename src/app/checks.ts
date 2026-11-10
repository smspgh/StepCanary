// Check CRUD used by the dashboard routes.

import { scheduleNextEval, type CheckState } from '../core/evaluate';
import type { ValidatedCheck } from '../core/validate';
import { makeToken, randomId } from '../shared/token';
import { iso, latestGapEnd, ms, toCheck, type Check, type Db } from './db';

export async function listChecks(db: Db, accountId: string): Promise<Check[]> {
  return (await db.query('SELECT * FROM checks WHERE account_id = $1 ORDER BY created_at, id', [accountId])).map(toCheck);
}

export async function getCheck(db: Db, accountId: string, id: string): Promise<Check | null> {
  const rows = await db.query('SELECT * FROM checks WHERE id = $1 AND account_id = $2', [id, accountId]);
  return rows[0] ? toCheck(rows[0]) : null;
}

export async function countChecks(db: Db, accountId: string): Promise<number> {
  return (await db.query('SELECT count(*)::int AS n FROM checks WHERE account_id = $1', [accountId]))[0].n;
}

export async function createCheck(db: Db, accountId: string, v: ValidatedCheck, tokenSecret: string): Promise<string> {
  const id = randomId();
  const token = await makeToken(tokenSecret);
  await db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO checks (id, account_id, name, token, mode, interval_seconds, cron, timezone, grace_seconds, active_window)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text::jsonb)`,
      [id, accountId, v.name, token, v.cfg.mode, v.cfg.intervalSeconds, v.cfg.cron, v.cfg.timezone, v.cfg.graceSeconds,
        v.cfg.activeWindow ? JSON.stringify(v.cfg.activeWindow) : null],
    );
    // New checks alert on every channel the account has (just its email address in the MVP).
    await tx.query(
      `INSERT INTO check_channels (check_id, channel_id) SELECT $1::text, id FROM channels WHERE account_id = $2`,
      [id, accountId],
    );
  });
  return id;
}

/** Save new settings. A running check gets a fresh clock so old timings can't cause an instant alert. */
export async function updateCheck(db: Db, check: Check, v: ValidatedCheck, now: number): Promise<void> {
  const running = check.state.status === 'up' || check.state.status === 'late';
  const state: CheckState = running ? { ...check.state, status: 'up', clockResetAt: now } : check.state;
  const nextEval = running ? scheduleNextEval(v.cfg, state, await latestGapEnd(db)) : check.nextEvalAt;
  await db.query(
    `UPDATE checks SET name = $2, mode = $3, interval_seconds = $4, cron = $5, timezone = $6, grace_seconds = $7,
            active_window = $8::text::jsonb, status = $9, clock_reset_at = $10::timestamptz, next_eval_at = $11::timestamptz
      WHERE id = $1`,
    [check.id, v.name, v.cfg.mode, v.cfg.intervalSeconds, v.cfg.cron, v.cfg.timezone, v.cfg.graceSeconds,
      v.cfg.activeWindow ? JSON.stringify(v.cfg.activeWindow) : null, state.status, iso(state.clockResetAt), iso(nextEval)],
  );
}

export async function pauseCheck(db: Db, check: Check, now: number): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE checks SET status = 'paused', next_eval_at = NULL, status_changed_at = $2::timestamptz WHERE id = $1`,
      [check.id, iso(now)],
    );
    // Pausing closes any open incident quietly: the user already knows.
    await tx.query(
      `UPDATE incidents SET resolved_at = $2::timestamptz WHERE check_id = $1 AND resolved_at IS NULL`,
      [check.id, iso(now)],
    );
  });
}

export async function resumeCheck(db: Db, check: Check, now: number): Promise<void> {
  if (check.state.status !== 'paused') return;
  const state: CheckState = { ...check.state, status: check.state.lastPingAt == null ? 'new' : 'up', clockResetAt: now };
  const nextEval = scheduleNextEval(check.cfg, state, await latestGapEnd(db));
  await db.query(
    `UPDATE checks SET status = $2, clock_reset_at = $3::timestamptz, next_eval_at = $4::timestamptz, status_changed_at = $3::timestamptz
      WHERE id = $1 AND status = 'paused'`,
    [check.id, state.status, iso(now), iso(nextEval)],
  );
}

export async function deleteCheck(db: Db, check: Check): Promise<void> {
  await db.query('DELETE FROM checks WHERE id = $1', [check.id]);
}

export const SPARK_HOURS = 7 * 24;

/** Hourly ping counts for the last 7 days, oldest first, for every check in the account. */
export async function sparklines(db: Db, accountId: string, now: number): Promise<Map<string, number[]>> {
  const hourMs = 3_600_000;
  const end = Math.floor(now / hourMs) * hourMs;
  const start = end - (SPARK_HOURS - 1) * hourMs;
  const rows = await db.query(
    `SELECT h.check_id, h.hour, h.ok FROM ping_hourly h JOIN checks c ON c.id = h.check_id
      WHERE c.account_id = $1 AND h.hour >= $2::timestamptz`,
    [accountId, iso(start)],
  );
  const out = new Map<string, number[]>();
  for (const r of rows) {
    let series = out.get(r.check_id);
    if (!series) out.set(r.check_id, (series = new Array(SPARK_HOURS).fill(0)));
    const idx = Math.round((ms(r.hour)! - start) / hourMs);
    if (idx >= 0 && idx < SPARK_HOURS) series[idx] = r.ok;
  }
  return out;
}

export interface PingRow {
  at: number;
  kind: string;
  flags: number;
}

export async function recentPings(db: Db, checkId: string, limit = 20): Promise<PingRow[]> {
  const rows = await db.query(
    `SELECT received_at, kind, flags FROM pings WHERE check_id = $1 ORDER BY received_at DESC LIMIT ${Math.floor(limit)}`,
    [checkId],
  );
  return rows.map((r) => ({ at: ms(r.received_at)!, kind: r.kind, flags: r.flags }));
}

export interface IncidentRow {
  reason: string;
  openedAt: number;
  resolvedAt: number | null;
}

export async function recentIncidents(db: Db, checkId: string, limit = 10): Promise<IncidentRow[]> {
  const rows = await db.query(
    `SELECT reason, opened_at, resolved_at FROM incidents WHERE check_id = $1 ORDER BY opened_at DESC LIMIT ${Math.floor(limit)}`,
    [checkId],
  );
  return rows.map((r) => ({ reason: r.reason, openedAt: ms(r.opened_at)!, resolvedAt: ms(r.resolved_at) }));
}
