// Check CRUD used by the dashboard routes.

import { acceptShape, markOptional } from '../core/drift';
import { scheduleNextEval, type CheckState } from '../core/evaluate';
import type { ValidatedCheck } from '../core/validate';
import { learningPeriod, nextVolumeEvalAt, SETTLE_MS } from '../core/volume';
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

/** Checks that count against the plan limit right now (everything that is not paused). */
export async function countActiveChecks(db: Db, accountId: string): Promise<number> {
  return (await db.query(`SELECT count(*)::int AS n FROM checks WHERE account_id = $1 AND status <> 'paused'`, [accountId]))[0].n;
}

async function linkChannels(tx: Db, accountId: string, checkId: string, channelIds: string[] | null): Promise<void> {
  await tx.query('DELETE FROM check_channels WHERE check_id = $1', [checkId]);
  if (channelIds == null) {
    // Default: alert on every channel the account has.
    await tx.query('INSERT INTO check_channels (check_id, channel_id) SELECT $1::text, id FROM channels WHERE account_id = $2', [checkId, accountId]);
  } else {
    await tx.query(
      `INSERT INTO check_channels (check_id, channel_id)
       SELECT $1::text, id FROM channels WHERE account_id = $2 AND id IN (SELECT jsonb_array_elements_text($3::text::jsonb))`,
      [checkId, accountId, JSON.stringify(channelIds)],
    );
  }
}

export async function createCheck(db: Db, accountId: string, v: ValidatedCheck, tokenSecret: string): Promise<string> {
  const id = randomId();
  const token = await makeToken(tokenSecret);
  await db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO checks (id, account_id, name, token, mode, interval_seconds, cron, timezone, grace_seconds, active_window,
                           volume_threshold_pct, baseline_status, drift_enabled, folder_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text::jsonb, $11, $12, $13, $14)`,
      [id, accountId, v.name, token, v.cfg.mode, v.cfg.intervalSeconds, v.cfg.cron, v.cfg.timezone, v.cfg.graceSeconds,
        v.cfg.activeWindow ? JSON.stringify(v.cfg.activeWindow) : null,
        v.cfg.volumeThresholdPct ?? null, v.cfg.mode === 'volume' ? 'learning' : null, v.driftEnabled === true, v.folderId ?? null],
    );
    await linkChannels(tx, accountId, id, v.channelIds ?? null);
  });
  return id;
}

/** Save new settings. A running check gets a fresh clock so old timings can't cause an instant alert. */
export async function updateCheck(db: Db, check: Check, v: ValidatedCheck, now: number): Promise<void> {
  const running = check.state.status === 'up' || check.state.status === 'late';
  const state: CheckState = running ? { ...check.state, status: 'up', clockResetAt: now } : check.state;
  const volume = v.cfg.mode === 'volume';
  const wasVolume = check.cfg.mode === 'volume';

  // Switching into volume mode starts learning; staying in it keeps what was learned.
  const baselineStatus = volume ? (wasVolume ? check.baselineStatus ?? 'learning' : 'learning') : null;
  const baseline = volume && wasVolume ? check.baseline : null;

  let nextEval: number | null = check.nextEvalAt;
  if (volume) {
    if (check.state.status === 'paused' || check.state.status === 'new') nextEval = null;
    else if (baselineStatus === 'active' && baseline) nextEval = nextVolumeEvalAt(baseline, v.cfg.timezone, now);
    else if (baselineStatus === 'learning' && check.firstPingAt != null) nextEval = learningPeriod(check.firstPingAt, v.cfg.timezone).end + SETTLE_MS;
    else nextEval = null;
  } else if (running) {
    nextEval = scheduleNextEval(v.cfg, state, await latestGapEnd(db));
  } else if (wasVolume) {
    nextEval = null;
  }

  const driftTurnedOn = v.driftEnabled === true && !check.driftEnabled;
  const driftTurnedOff = v.driftEnabled !== true && check.driftEnabled;

  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE checks SET name = $2, mode = $3, interval_seconds = $4, cron = $5, timezone = $6, grace_seconds = $7,
              active_window = $8::text::jsonb, status = $9, clock_reset_at = $10::timestamptz, next_eval_at = $11::timestamptz,
              volume_threshold_pct = $12, baseline_status = $13, baseline = $14::text::jsonb,
              drift_enabled = $15, folder_id = $16,
              accepted_shape = CASE WHEN $17::boolean THEN NULL ELSE accepted_shape END,
              optional_paths = CASE WHEN $17::boolean THEN NULL ELSE optional_paths END,
              pending_shape = CASE WHEN $17::boolean THEN NULL ELSE pending_shape END
        WHERE id = $1`,
      [check.id, v.name, v.cfg.mode, v.cfg.intervalSeconds, v.cfg.cron, v.cfg.timezone, v.cfg.graceSeconds,
        v.cfg.activeWindow ? JSON.stringify(v.cfg.activeWindow) : null, state.status, iso(state.clockResetAt), iso(nextEval),
        v.cfg.volumeThresholdPct ?? null, baselineStatus, baseline ? JSON.stringify(baseline) : null,
        v.driftEnabled === true, v.folderId ?? null, driftTurnedOn || driftTurnedOff],
    );
    if (driftTurnedOff) {
      await tx.query(`UPDATE incidents SET resolved_at = $2::timestamptz WHERE check_id = $1 AND kind = 'drift' AND resolved_at IS NULL`, [check.id, iso(now)]);
    }
    if (v.channelIds !== undefined) await linkChannels(tx, check.accountId, check.id, v.channelIds);
  });
}

export async function pauseCheck(db: Db, check: Pick<Check, 'id'>, now: number, reason: string | null = null): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE checks SET status = 'paused', next_eval_at = NULL, status_changed_at = $2::timestamptz, paused_reason = $3 WHERE id = $1`,
      [check.id, iso(now), reason],
    );
    // Pausing closes any open incident quietly: the user already knows.
    await tx.query(`UPDATE incidents SET resolved_at = $2::timestamptz WHERE check_id = $1 AND resolved_at IS NULL`, [check.id, iso(now)]);
  });
}

export async function resumeCheck(db: Db, check: Check, now: number): Promise<void> {
  if (check.state.status !== 'paused') return;
  const state: CheckState = { ...check.state, status: check.state.lastPingAt == null ? 'new' : 'up', clockResetAt: now };
  let nextEval: number | null;
  if (check.cfg.mode !== 'volume') nextEval = scheduleNextEval(check.cfg, state, await latestGapEnd(db));
  else if (state.status === 'new') nextEval = null;
  else if (check.baselineStatus === 'active' && check.baseline) nextEval = nextVolumeEvalAt(check.baseline, check.cfg.timezone, now);
  else if (check.baselineStatus === 'learning' && check.firstPingAt != null) nextEval = learningPeriod(check.firstPingAt, check.cfg.timezone).end + SETTLE_MS;
  else nextEval = null;
  await db.query(
    `UPDATE checks SET status = $2, clock_reset_at = $3::timestamptz, next_eval_at = $4::timestamptz, status_changed_at = $3::timestamptz,
            paused_reason = NULL, volume_evaluated_until = $3::timestamptz
      WHERE id = $1 AND status = 'paused'`,
    [check.id, state.status, iso(now), iso(nextEval)],
  );
}

export async function deleteCheck(db: Db, check: Check): Promise<void> {
  await db.query('DELETE FROM checks WHERE id = $1', [check.id]);
}

// --- volume baseline ----------------------------------------------------------------------------

/** The user has reviewed the learned baseline and switched volume alerts on. */
export async function enableBaseline(db: Db, check: Check, now: number): Promise<boolean> {
  if (check.cfg.mode !== 'volume' || check.baselineStatus !== 'ready' || !check.baseline) return false;
  const next = check.state.status === 'paused' || check.state.status === 'new' ? null : nextVolumeEvalAt(check.baseline, check.cfg.timezone, now);
  await db.query(
    `UPDATE checks SET baseline_status = 'active', volume_evaluated_until = $2::timestamptz, next_eval_at = $3::timestamptz
      WHERE id = $1 AND baseline_status = 'ready'`,
    [check.id, iso(now), iso(next)],
  );
  return true;
}

/** Replace the baseline with a freshly learned one, to be reviewed again before it is enforced. */
export async function proposeBaseline(db: Db, check: Check, baseline: unknown, now: number): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE checks SET baseline = $2::text::jsonb, baseline_status = 'ready', next_eval_at = NULL,
              status = CASE WHEN status = 'down' THEN 'up' ELSE status END
        WHERE id = $1 AND mode = 'volume'`,
      [check.id, JSON.stringify(baseline)],
    );
    await tx.query(`UPDATE incidents SET resolved_at = $2::timestamptz WHERE check_id = $1 AND kind = 'down' AND resolved_at IS NULL`, [check.id, iso(now)]);
  });
}

// --- payload drift ------------------------------------------------------------------------------

async function closeDrift(tx: Db, checkId: string, now: number): Promise<void> {
  await tx.query(`UPDATE incidents SET resolved_at = $2::timestamptz WHERE check_id = $1 AND kind = 'drift' AND resolved_at IS NULL`, [checkId, iso(now)]);
}

/** "Accept new shape": the changed payload becomes the new normal. */
export async function acceptDrift(db: Db, check: Check, now: number): Promise<boolean> {
  if (!check.pendingShape) return false;
  await db.tx(async (tx) => {
    await tx.query(`UPDATE checks SET accepted_shape = $2::text::jsonb, pending_shape = NULL WHERE id = $1`, [
      check.id,
      JSON.stringify(acceptShape(check.pendingShape!)),
    ]);
    await closeDrift(tx, check.id, now);
  });
  return true;
}

/** "Mark as optional": the changed keys may come and go (or be blank) without alerting again. */
export async function markDriftOptional(db: Db, check: Check, now: number): Promise<boolean> {
  if (!check.pendingShape || !check.acceptedShape) return false;
  const next = markOptional(check.acceptedShape, check.pendingShape, check.optionalPaths);
  await db.tx(async (tx) => {
    await tx.query(
      `UPDATE checks SET accepted_shape = $2::text::jsonb, optional_paths = $3::text::jsonb, pending_shape = NULL WHERE id = $1`,
      [check.id, JSON.stringify(next.accepted), JSON.stringify(next.optional)],
    );
    await closeDrift(tx, check.id, now);
  });
  return true;
}

// --- dashboard data -----------------------------------------------------------------------------

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
  kind: string;
  reason: string;
  openedAt: number;
  resolvedAt: number | null;
}

export async function recentIncidents(db: Db, checkId: string, limit = 10): Promise<IncidentRow[]> {
  const rows = await db.query(
    `SELECT kind, reason, opened_at, resolved_at FROM incidents WHERE check_id = $1 ORDER BY opened_at DESC LIMIT ${Math.floor(limit)}`,
    [checkId],
  );
  return rows.map((r) => ({ kind: r.kind, reason: r.reason, openedAt: ms(r.opened_at)!, resolvedAt: ms(r.resolved_at) }));
}

/** A short fingerprint of everything the dashboard shows, so open pages know when to refresh. */
export async function accountSignature(db: Db, accountId: string): Promise<string> {
  const rows = await db.query(
    `SELECT md5(COALESCE(string_agg(c.id || c.status || COALESCE(c.last_ping_at::text, '') || COALESCE(c.baseline_status, '')
                   || COALESCE(c.payload_warning, '') || (c.pending_shape IS NOT NULL)::text
                   || (SELECT count(*)::text FROM incidents i WHERE i.check_id = c.id AND i.resolved_at IS NULL), ',' ORDER BY c.id), '')) AS sig
       FROM checks c WHERE c.account_id = $1`,
    [accountId],
  );
  return rows[0]?.sig ?? '';
}
