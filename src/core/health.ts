// Self-health: decides, each minute, whether we are entitled to call anything "down".
//
// Two independent signals:
//  1. Evaluator continuity - did the previous run happen recently and finish cleanly?
//  2. Ingestion canary - a ping the evaluator sends through the real pipeline every minute
//     (ingest Worker -> queue -> consumer -> database). If it stops arriving, customer pings
//     may be stuck or lost too.
//
// If either fails we record a monitoring gap and send no "down" alerts. Evaluation resumes only
// after two consecutive healthy runs, and judges checks as of the canary's arrival time (the
// watermark), so a queue backlog can never look like silence.

export const MAX_RUN_SPACING_MS = 150_000; // tolerates one missed minute
export const MAX_CANARY_AGE_MS = 150_000; // tolerates one lost canary

export interface PrevRun {
  startedAt: number;
  finishedAt: number | null;
  healthy: boolean;
}

export interface HealthInput {
  now: number;
  prevRun: PrevRun | null;
  canaryAt: number | null;
}

export type GapReason = 'evaluator_missed' | 'evaluator_error' | 'ingest_stalled' | 'ingest_delay';

export interface Gap {
  start: number;
  end: number;
  reason: GapReason;
}

export interface HealthResult {
  /** This run saw a fully working system. */
  healthy: boolean;
  /** Healthy now AND on the previous run: only then may checks be evaluated. */
  canEvaluate: boolean;
  /** Judge checks as of this instant. Null when not evaluating. */
  asOf: number | null;
  gaps: Gap[];
  note: string;
}

export function assessHealth({ now, prevRun, canaryAt }: HealthInput): HealthResult {
  if (!prevRun) {
    // First run ever (fresh deployment): nothing to compare against, nothing to alert on.
    return { healthy: false, canEvaluate: false, asOf: null, gaps: [], note: 'first_run' };
  }

  const gaps: Gap[] = [];
  const notes: string[] = [];

  if (now - prevRun.startedAt > MAX_RUN_SPACING_MS) {
    gaps.push({ start: prevRun.startedAt, end: now, reason: 'evaluator_missed' });
    notes.push('evaluator_missed');
  } else if (prevRun.finishedAt == null) {
    gaps.push({ start: prevRun.startedAt, end: now, reason: 'evaluator_error' });
    notes.push('evaluator_error');
  }

  if (canaryAt == null || now - canaryAt > MAX_CANARY_AGE_MS) {
    gaps.push({ start: canaryAt ?? prevRun.startedAt, end: now, reason: 'ingest_stalled' });
    notes.push('ingest_stalled');
  }

  const healthy = gaps.length === 0;
  const canEvaluate = healthy && prevRun.healthy;
  if (healthy && !prevRun.healthy) notes.push('warming_up');
  return {
    healthy,
    canEvaluate,
    asOf: canEvaluate ? Math.min(now, canaryAt!) : null,
    gaps,
    note: notes.join(',') || 'ok',
  };
}
