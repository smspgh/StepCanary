// The every-minute evaluator. Order of operations matters:
//   1. claim this minute (a second invocation for the same minute is a no-op)
//   2. send this minute's canary ping through the real ingestion pipeline
//   3. assess our own health; record monitoring gaps
//   4. only if healthy now AND on the previous run: evaluate due checks as of the canary watermark
//   5. mark the run finished (an unfinished run is itself treated as a gap by the next run)

import { evaluate } from '../core/evaluate';
import { assessHealth, type HealthResult } from '../core/health';
import { openIncident } from './alerts';
import { CANARY_KEY, getState, iso, latestGapEnd, ms, recordGap, toCheck, type Check, type Db } from './db';

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
    const due = await db.query(
      `SELECT * FROM checks WHERE status IN ('up', 'late') AND next_eval_at <= $1::timestamptz ORDER BY next_eval_at LIMIT ${MAX_CHECKS_PER_RUN}`,
      [iso(asOf)],
    );
    for (const row of due) {
      try {
        if (await evaluateOne(db, toCheck(row), asOf, gapEnd, deps.appUrl)) transitions++;
        evaluated++;
      } catch (err) {
        // One broken check must not stop the others, or the run.
        errors++;
        console.error('evaluate_check_failed', row.id, String(err));
      }
    }
  }

  await db.query(
    `UPDATE evaluator_runs SET finished_at = now(), healthy = $2, evaluated = $3, transitions = $4, errors = $5, note = $6 WHERE minute = $1`,
    [minute, health.healthy, evaluated, transitions, errors, health.note],
  );
  return { ran: true, health, evaluated, transitions, errors };
}

/** Apply the pure decision for one check. Returns true if its status changed. */
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
    if (decision.status === 'down') await openIncident(tx, check, 'missed', asOf, appUrl);
    return decision.status !== check.state.status;
  });
}
