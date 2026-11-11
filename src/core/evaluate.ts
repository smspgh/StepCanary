// Pure evaluation logic: no I/O, no clock reads. Everything takes explicit instants (epoch ms),
// which is what makes timezone, DST, active-window and monitoring-gap behavior unit-testable.

import { Cron } from 'croner';
import type { PingKind } from '../shared/messages';
import { addMonitored, type ActiveWindow } from './window';

export type CheckStatus = 'new' | 'up' | 'late' | 'down' | 'paused';
export type CheckMode = 'interval' | 'schedule' | 'volume';

export interface CheckConfig {
  mode: CheckMode;
  intervalSeconds: number | null;
  cron: string | null;
  timezone: string;
  graceSeconds: number;
  /** Interval and volume modes. */
  activeWindow: ActiveWindow | null;
  /** Volume mode: alert when a period's count is below this percentage of normal. */
  volumeThresholdPct?: number | null;
}

export interface CheckState {
  status: CheckStatus;
  lastPingAt: number | null;
  lastStartAt: number | null;
  lastFailAt: number | null;
  clockResetAt: number | null;
}

export interface Deadlines {
  /** The ping is overdue from this instant (status "late"). */
  lateAt: number;
  /** The grace period has also run out from this instant (status "down"). */
  downAt: number;
}

/** A ping up to this much before a scheduled time counts for that scheduled time. */
export const EARLY_TOLERANCE_MS = 60_000;

/**
 * Where the evaluation clock starts: the latest of the last ping, the last manual reset, and the
 * end of the latest monitoring gap. A gap restarts the clock because a ping may have been lost
 * while we could not vouch for our own ingestion.
 */
export function anchorOf(state: Pick<CheckState, 'lastPingAt' | 'clockResetAt'>, latestGapEnd: number | null): number | null {
  const candidates = [state.lastPingAt, state.clockResetAt].filter((x): x is number => x != null);
  if (candidates.length === 0) return null;
  if (latestGapEnd != null) candidates.push(latestGapEnd);
  return Math.max(...candidates);
}

export function nextScheduled(cron: string, timezone: string, after: number): number {
  const next = new Cron(cron, { timezone }).nextRun(new Date(after));
  return next ? next.getTime() : Infinity;
}

export function computeDeadlines(cfg: CheckConfig, anchor: number): Deadlines {
  const grace = cfg.graceSeconds * 1000;
  if (cfg.mode === 'schedule') {
    const lateAt = nextScheduled(cfg.cron!, cfg.timezone, anchor + EARLY_TOLERANCE_MS);
    return { lateAt, downAt: lateAt + grace };
  }
  const interval = cfg.intervalSeconds! * 1000;
  return {
    lateAt: addMonitored(anchor, interval, cfg.activeWindow, cfg.timezone),
    downAt: addMonitored(anchor, interval + grace, cfg.activeWindow, cfg.timezone),
  };
}

export function statusAt(d: Deadlines, asOf: number): 'up' | 'late' | 'down' {
  if (asOf >= d.downAt) return 'down';
  if (asOf >= d.lateAt) return 'late';
  return 'up';
}

function finite(t: number): number | null {
  return Number.isFinite(t) ? t : null;
}

export interface Decision {
  status: 'up' | 'late' | 'down';
  nextEvalAt: number | null;
  deadlines: Deadlines;
  anchor: number;
  /** True when a monitoring gap, not a ping, is what the clock is currently counting from. */
  gapAffected: boolean;
}

/**
 * What a check's status should be as of `asOf`. Returns null for checks the evaluator must leave
 * alone: `new` (never alert before the first ping), `paused`, and `down` (only a ping recovers it).
 */
export function evaluate(cfg: CheckConfig, state: CheckState, asOf: number, latestGapEnd: number | null): Decision | null {
  if (cfg.mode === 'volume') return null; // judged by counts per period, see core/volume.ts
  if (state.status !== 'up' && state.status !== 'late') return null;
  const anchor = anchorOf(state, latestGapEnd);
  if (anchor == null) return null;
  const deadlines = computeDeadlines(cfg, anchor);
  const status = statusAt(deadlines, asOf);
  const own = Math.max(state.lastPingAt ?? -Infinity, state.clockResetAt ?? -Infinity);
  return {
    status,
    nextEvalAt: status === 'up' ? finite(deadlines.lateAt) : status === 'late' ? finite(deadlines.downAt) : null,
    deadlines,
    anchor,
    gapAffected: latestGapEnd != null && latestGapEnd > own,
  };
}

/** When the evaluator should next look at a check that is currently `up` or `late`. */
export function scheduleNextEval(cfg: CheckConfig, state: CheckState, latestGapEnd: number | null): number | null {
  if (cfg.mode === 'volume') return null;
  if (state.status !== 'up' && state.status !== 'late') return null;
  const anchor = anchorOf(state, latestGapEnd);
  if (anchor == null) return null;
  const d = computeDeadlines(cfg, anchor);
  return finite(state.status === 'up' ? d.lateAt : d.downAt);
}

export interface PingEvent {
  ts: number;
  kind: PingKind;
}

export type Effect = { type: 'open'; at: number; reason: 'reported_failure' } | { type: 'resolve'; at: number };

export interface ApplyResult {
  state: CheckState;
  /** undefined = leave the stored value alone (volume checks keep their own timetable). */
  nextEvalAt: number | null | undefined;
  effects: Effect[];
}

/**
 * Fold newly received pings into a check's state.
 *  - ok:    proves the automation is alive -> `up` (recovering it if it was down).
 *  - fail:  the automation told us it failed -> `down` immediately.
 *  - start: recorded only (v1 has no duration alerts).
 * Paused checks keep recording timestamps but never change status or raise alerts.
 * Out-of-order delivery is tolerated: an older `ok` cannot undo a newer `fail`, and vice versa.
 *
 * Volume checks differ: once past `new`, pings are only counted. A single ping does not prove
 * volume is back to normal, so going down and recovering is left to the per-period evaluation.
 */
export function applyEvents(cfg: CheckConfig, initial: CheckState, events: PingEvent[], latestGapEnd: number | null): ApplyResult {
  const s: CheckState = { ...initial };
  const effects: Effect[] = [];
  const max = (a: number | null, b: number) => (a == null || b > a ? b : a);
  const volume = cfg.mode === 'volume';

  for (const ev of [...events].sort((a, b) => a.ts - b.ts)) {
    if (ev.kind === 'start') {
      s.lastStartAt = max(s.lastStartAt, ev.ts);
    } else if (ev.kind === 'ok') {
      const newerThanFail = s.lastFailAt == null || ev.ts > s.lastFailAt;
      s.lastPingAt = max(s.lastPingAt, ev.ts);
      if (s.status !== 'paused' && newerThanFail && s.status !== 'up' && !(volume && s.status !== 'new')) {
        if (s.status === 'down') effects.push({ type: 'resolve', at: ev.ts });
        s.status = 'up';
      }
    } else {
      const newerThanPing = s.lastPingAt == null || ev.ts > s.lastPingAt;
      s.lastFailAt = max(s.lastFailAt, ev.ts);
      if (s.status !== 'paused' && newerThanPing && s.status !== 'down' && !volume) {
        s.status = 'down';
        effects.push({ type: 'open', at: ev.ts, reason: 'reported_failure' });
      }
    }
  }

  return { state: s, nextEvalAt: volume ? undefined : scheduleNextEval(cfg, s, latestGapEnd), effects };
}
