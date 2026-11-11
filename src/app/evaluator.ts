// The every-minute evaluator. Order of operations matters:
//   1. claim this minute (a second invocation for the same minute is a no-op)
//   2. send this minute's canary ping through the real ingestion pipeline
//   3. assess our own health; record monitoring gaps
//   4. only if healthy now AND on the previous run: evaluate due checks as of the canary watermark
//   5. mark the run finished (an unfinished run is itself treated as a gap by the next run)

import type { VolumeFacts } from '../core/describe';
import { evaluate } from '../core/evaluate';
import { assessHealth, type HealthResult } from '../core/health';
import {
  computeBaseline,
  countInBucket,
  judgeVolume,
  lastClosedBucket,
  learningPeriod,
  nextVolumeEvalAt,
  recentPeriod,
  learningReadyAt,
  type Baseline,
} from '../core/volume';
import { openIncident, resolveIncident } from './alerts';
import { CANARY_KEY, gapsOverlapping, getState, hourlyCounts, iso, latestGapEnd, ms, recordGap, toCheck, type Check, type Db } from './db';

export interface EvaluatorDeps {
  now: number;
  appUrl: string;
  /** Sends one canary ping through the ingest Worker. Failures are swallowed: a missing canary is the signal. */
  sendCanary: () => Promise<void>;
}

export interface RunSummary {
  ran: boolean;
  health: HealthResult | null;
  evaluated: number;
  transitions: number;
  errors: number;
}

const MAX_CHECKS_PER_RUN = 5000;
/** A runaway-loop incident closes quietly once the edge has not throttled the check for this long. */
export const RUNAWAY_QUIET_MS = 10 * 60_000;
/** A learned baseline needs this many usable days (days hit by a monitoring gap do not count). */
export const MIN_BASELINE_DAYS = 7;
const DAY_MS = 86_400_000;

export async function runEvaluator(db: Db, deps: EvaluatorDeps): Promise<RunSummary> {
  const { now } = deps;
  const minute = Math.floor(now / 60_000);

  const claimed = await db.query(
    `INSERT INTO evaluator_runs (minute, started_at) VALUES ($1, $2::timestamptz) ON CONFLICT (minute) DO NOTHING RETURNING minute`,
    [minute, iso(now)],
  );
  if (claimed.length === 0) return { ran: false, health: null, evaluated: 0, transitions: 0, errors: 0 };

  const prevRows = await db.query(
    `SELECT started_at, finished_at, healthy FROM evaluator_runs WHERE minute < $1 ORDER BY minute DESC LIMIT 1`,
    [minute],
  );
  const prevRun = prevRows[0]
    ? { startedAt: ms(prevRows[0].started_at)!, finishedAt: ms(prevRows[0].finished_at), healthy: prevRows[0].healthy === true }
    : null;
  const canaryRaw = await getState(db, CANARY_KEY);
  const canaryAt = canaryRaw ? Number(canaryRaw) : null;

  // Sent after reading the old canary value, so this run judges the pipeline on last minute's ping.
  await deps.sendCanary().catch((err) => console.error('canary_send_failed', String(err)));

  const health = assessHealth({ now, prevRun, canaryAt });
  for (const gap of health.gaps) await recordGap(db, gap.start, gap.end, gap.reason);

  let evaluated = 0;
  let transitions = 0;
  let errors = 0;

  if (health.canEvaluate && health.asOf != null) {
    const asOf = health.asOf;
    const gapEnd = await latestGapEnd(db);
    // "down" is included for volume checks, which are re-judged every period until volume recovers.
    const due = await db.query(
      `SELECT * FROM checks WHERE next_eval_at <= $1::timestamptz AND status IN ('up', 'late', 'down')
        ORDER BY next_eval_at LIMIT ${MAX_CHECKS_PER_RUN}`,
      [iso(asOf)],
    );
    for (const row of due) {
      try {
        const check = toCheck(row);
        const changed =
          check.cfg.mode === 'volume'
            ? await evaluateVolume(db, check, asOf, deps.appUrl)
            : await evaluateOne(db, check, asOf, gapEnd, deps.appUrl);
        if (changed) transitions++;
        evaluated++;
      } catch (err) {
        // One broken check must not stop the others, or the run.
        errors++;
        console.error('evaluate_check_failed', row.id, String(err));
      }
    }
  }

  // Runaway loops that have gone quiet are closed without a further alert.
  await db.query(
    `UPDATE incidents SET resolved_at = $1::timestamptz
      WHERE kind = 'runaway' AND resolved_at IS NULL AND last_event_at < $2::timestamptz`,
    [iso(now), iso(now - RUNAWAY_QUIET_MS)],
  );

  await db.query(
    `UPDATE evaluator_runs SET finished_at = now(), healthy = $2, evaluated = $3, transitions = $4, errors = $5, note = $6 WHERE minute = $1`,
    [minute, health.healthy, evaluated, transitions, errors, health.note],
  );
  return { ran: true, health, evaluated, transitions, errors };
}

/** Apply the pure decision for one interval/schedule check. Returns true if its status changed. */
async function evaluateOne(db: Db, check: Check, asOf: number, gapEnd: number | null, appUrl: string): Promise<boolean> {
  const decision = evaluate(check.cfg, check.state, asOf, gapEnd);
  if (!decision) return false;

  return db.tx(async (tx) => {
    // The last_ping_at guard makes this a no-op if a ping landed since we read the row.
    const updated = await tx.query(
      `UPDATE checks SET
         status = $2,
         next_eval_at = $3::timestamptz,
         status_changed_at = CASE WHEN status <> $2 THEN $4::timestamptz ELSE status_changed_at END
       WHERE id = $1 AND status IN ('up', 'late') AND last_ping_at IS NOT DISTINCT FROM $5::timestamptz
       RETURNING id`,
      [check.id, decision.status, iso(decision.nextEvalAt), iso(asOf), iso(check.state.lastPingAt)],
    );
    if (updated.length === 0) return false;
    if (decision.status === 'down') await openIncident(tx, check, { reason: 'missed', at: asOf, appUrl });
    return decision.status !== check.state.status;
  });
}

async function reschedule(db: Db, checkId: string, at: number | null, evaluatedUntil?: number): Promise<false> {
  await db.query(
    `UPDATE checks SET next_eval_at = $2::timestamptz,
            volume_evaluated_until = COALESCE($3::timestamptz, volume_evaluated_until)
      WHERE id = $1`,
    [checkId, iso(at), iso(evaluatedUntil ?? null)],
  );
  return false;
}

/** Learn a baseline from the first 14 days; if gaps spoiled too many of them, from the latest 14. */
export async function learnBaseline(db: Db, check: Check, asOf: number, opts: { recentOnly?: boolean } = {}): Promise<Baseline | null> {
  const { timezone, activeWindow: window } = check.cfg;
  if (check.firstPingAt == null) return null; // nothing to learn from yet
  const first = learningPeriod(check.firstPingAt, timezone);
  const recent = recentPeriod(asOf, timezone);
  // Days before the first ping are not "quiet days", they are days we were not connected.
  const candidates = [first, { start: Math.max(recent.start, first.start), end: recent.end }];
  for (const period of opts.recentOnly ? candidates.slice(1) : candidates) {
    if (period.end > asOf || period.end <= period.start) continue;
    const baseline = computeBaseline({
      counts: await hourlyCounts(db, check.id, period.start, period.end),
      period,
      timezone,
      window,
      gaps: await gapsOverlapping(db, period.start, period.end),
    });
    if (baseline.days >= MIN_BASELINE_DAYS) return baseline;
  }
  return null;
}

/**
 * Volume checks: finish learning when the 14 days are up, then judge each closed period (a local
 * day, or an hour for busy checks) against what is normal for it. Returns true on a status change.
 */
export async function evaluateVolume(db: Db, check: Check, asOf: number, appUrl: string): Promise<boolean> {
  const { timezone: tz, activeWindow: window } = check.cfg;

  if (check.baselineStatus === 'learning') {
    if (check.firstPingAt == null) return reschedule(db, check.id, null);
    const ready = learningReadyAt(check.firstPingAt, tz);
    if (asOf < ready) return reschedule(db, check.id, ready);
    const baseline = await learnBaseline(db, check, asOf);
    if (!baseline) return reschedule(db, check.id, asOf + DAY_MS); // not enough clean days yet
    // Learned, but not enforced until the user has looked at it and switched it on.
    await db.query(
      `UPDATE checks SET baseline = $2::text::jsonb, baseline_status = 'ready', next_eval_at = NULL
        WHERE id = $1 AND baseline_status = 'learning'`,
      [check.id, JSON.stringify(baseline)],
    );
    return false;
  }

  if (check.baselineStatus !== 'active' || !check.baseline) return reschedule(db, check.id, null);

  const pct = check.cfg.volumeThresholdPct ?? 50;
  const bucket = lastClosedBucket(check.baseline, tz, window, asOf);
  const next = nextVolumeEvalAt(check.baseline, tz, asOf);
  if (check.volumeEvaluatedUntil != null && check.volumeEvaluatedUntil >= bucket.end) return reschedule(db, check.id, next);

  // A period we were not watching properly cannot be judged either way.
  if ((await gapsOverlapping(db, bucket.start, bucket.end)).length) return reschedule(db, check.id, next, bucket.end);

  const actual = countInBucket(await hourlyCounts(db, check.id, bucket.start, bucket.end), bucket, window, tz);
  const verdict = judgeVolume(bucket.expected, actual, pct);
  if (!verdict.judged) return reschedule(db, check.id, next, bucket.end);

  const facts: VolumeFacts = { expected: bucket.expected!, actual, when: bucket.when, label: bucket.label, pct };
  const from = check.state.status;
  const to = verdict.low ? 'down' : 'up';

  return db.tx(async (tx) => {
    const updated = await tx.query(
      `UPDATE checks SET status = $2, next_eval_at = $3::timestamptz, volume_evaluated_until = $4::timestamptz,
              status_changed_at = CASE WHEN status <> $2 THEN $5::timestamptz ELSE status_changed_at END
        WHERE id = $1 AND status = $6 RETURNING id`,
      [check.id, to, iso(next), iso(bucket.end), iso(asOf), from],
    );
    if (updated.length === 0) return false; // paused or edited in the meantime
    if (to === 'down' && from !== 'down') {
      await openIncident(tx, check, { reason: 'low_volume', at: asOf, appUrl, details: { volume: facts } });
    }
    if (to === 'up' && from === 'down') await resolveIncident(tx, check, { at: asOf, appUrl, volume: facts });
    return from !== to;
  });
}
