// Queue consumer: turns a batch of ping messages into rows and state changes, in one transaction.
// If anything fails the whole batch is retried by the queue; redelivered messages are no-ops
// because pings are keyed by the ingest message id.

import { describeChanges, diffShape } from '../core/drift';
import { applyEvents, type PingEvent } from '../core/evaluate';
import { learningPeriod, SETTLE_MS } from '../core/volume';
import type { Shape } from '../shared/fingerprint';
import { FLAG_MALFORMED, FLAG_THROTTLED, FLAG_TOO_LARGE, isPingMessage, type PingMessage } from '../shared/messages';
import { openIncident, resolveIncident } from './alerts';
import { CANARY_KEY, getState, iso, latestGapEnd, recordGap, setState, toCheck, type Check, type Db } from './db';

/** A batch landing this long after the edge received it means ingestion was not keeping up. */
export const LATE_BATCH_MS = 120_000;

export interface ConsumeResult {
  pings: number;
  alertsQueued: boolean;
}

const NOTHING: ConsumeResult = { pings: 0, alertsQueued: false };

export async function consumeBatch(db: Db, bodies: unknown[], now: number, canaryToken: string, appUrl: string): Promise<ConsumeResult> {
  const msgs = bodies.filter(isPingMessage);
  if (msgs.length === 0) return NOTHING;

  const oldest = Math.min(...msgs.map((m) => m.ts));
  if (now - oldest > LATE_BATCH_MS) await recordGap(db, oldest, now, 'ingest_delay');

  const canary = msgs.filter((m) => m.t === canaryToken);
  if (canary.length) {
    const newest = Math.max(...canary.map((m) => m.ts));
    const current = Number((await getState(db, CANARY_KEY)) ?? 0);
    if (newest > current) await setState(db, CANARY_KEY, String(newest));
  }

  const pings = msgs.filter((m) => m.t !== canaryToken);
  if (pings.length === 0) return NOTHING;

  return db.tx(async (tx) => {
    const tokens = [...new Set(pings.map((m) => m.t))];
    // Lock in a stable order so concurrent batches for the same checks cannot deadlock.
    const rows = await tx.query(
      `SELECT * FROM checks WHERE token IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR UPDATE`,
      [JSON.stringify(tokens)],
    );
    const byToken = new Map(rows.map((r) => [r.token as string, toCheck(r)]));
    const msgById = new Map<string, PingMessage>();
    const records = [];
    for (const m of pings) {
      const check = byToken.get(m.t);
      if (!check) continue; // deleted check, or a token we never issued: drop silently
      msgById.set(m.id, m);
      records.push({ check_id: check.id, received_at: iso(m.ts), id: m.id, kind: m.k, flags: m.f, shape_hash: m.sh ?? null });
    }
    if (records.length === 0) return NOTHING;

    // Only rows that are actually new count from here on (redelivery-safe).
    const inserted = await tx.query(
      `INSERT INTO pings (check_id, received_at, id, kind, flags, shape_hash)
       SELECT x.check_id, x.received_at, x.id, x.kind, x.flags, x.shape_hash
         FROM jsonb_to_recordset($1::text::jsonb)
              AS x(check_id text, received_at timestamptz, id text, kind text, flags int, shape_hash text)
       ON CONFLICT DO NOTHING
       RETURNING check_id, id`,
      [JSON.stringify(records)],
    );
    if (inserted.length === 0) return NOTHING;

    const hourly = new Map<string, { check_id: string; hour: string; ok: number; fail: number }>();
    const perCheck = new Map<string, PingMessage[]>();
    for (const row of inserted) {
      const m = msgById.get(row.id)!;
      let list = perCheck.get(row.check_id);
      if (!list) perCheck.set(row.check_id, (list = []));
      list.push(m);
      if (m.k === 'start') continue;
      const hour = iso(Math.floor(m.ts / 3_600_000) * 3_600_000)!;
      const key = `${row.check_id}|${hour}`;
      let h = hourly.get(key);
      if (!h) hourly.set(key, (h = { check_id: row.check_id, hour, ok: 0, fail: 0 }));
      if (m.k === 'ok') h.ok++;
      else h.fail++;
    }
    if (hourly.size) {
      await tx.query(
        `INSERT INTO ping_hourly (check_id, hour, ok, fail)
         SELECT x.check_id, x.hour, x.ok, x.fail
           FROM jsonb_to_recordset($1::text::jsonb) AS x(check_id text, hour timestamptz, ok int, fail int)
         ON CONFLICT (check_id, hour) DO UPDATE
           SET ok = ping_hourly.ok + excluded.ok, fail = ping_hourly.fail + excluded.fail`,
        [JSON.stringify([...hourly.values()])],
      );
    }

    const gapEnd = await latestGapEnd(tx);
    const checksById = new Map([...byToken.values()].map((c) => [c.id, c]));
    let alertsQueued = false;
    for (const [checkId, list] of perCheck) {
      alertsQueued = (await applyToCheck(tx, checksById.get(checkId)!, list, gapEnd, now, appUrl)) || alertsQueued;
    }
    return { pings: inserted.length, alertsQueued };
  });
}

/** What a batch of pings means for payload drift on one check. Pure. */
export function assessDrift(
  check: Pick<Check, 'driftEnabled' | 'acceptedShape' | 'optionalPaths'>,
  shapes: Shape[],
): { accepted: Shape | null; pending: Shape | null; changes: string[] } {
  let accepted = check.acceptedShape;
  let pending: Shape | null = null;
  let changes: string[] = [];
  if (!check.driftEnabled) return { accepted, pending, changes };
  for (const shape of shapes) {
    if (!accepted) {
      accepted = shape; // the first payload we see defines "normal"
      continue;
    }
    const diff = diffShape(accepted, shape, check.optionalPaths);
    if (diff.length) {
      pending = shape;
      changes = describeChanges(diff);
    }
  }
  return { accepted, pending, changes };
}

async function applyToCheck(tx: Db, check: Check, list: PingMessage[], gapEnd: number | null, now: number, appUrl: string): Promise<boolean> {
  const ordered = [...list].sort((a, b) => a.ts - b.ts);
  const events: PingEvent[] = ordered.map((m) => ({ ts: m.ts, kind: m.k }));
  const result = applyEvents(check.cfg, check.state, events, gapEnd);
  const s = result.state;
  const paused = check.state.status === 'paused';

  // Payload notes come from the newest non-start, non-marker ping in the batch.
  const real = ordered.filter((m) => m.k !== 'start' && !(m.f & FLAG_THROTTLED));
  const latest = real[real.length - 1];
  const withShape = ordered.filter((m) => m.shape);
  const lastShape = withShape[withShape.length - 1];
  let warning = check.payloadWarning;
  let warningAt: number | null | undefined; // undefined = leave as is
  if (latest) {
    const next = latest.f & FLAG_MALFORMED ? 'malformed' : latest.f & FLAG_TOO_LARGE ? 'too_large' : null;
    if (next !== warning) {
      warning = next;
      warningAt = next ? latest.ts : null;
    }
  }

  const firstPingAt = check.firstPingAt ?? ordered[0].ts;
  let nextEvalAt = result.nextEvalAt;
  // A volume check starts its 14-day learning period with its first ping.
  if (check.cfg.mode === 'volume' && check.firstPingAt == null && check.baselineStatus === 'learning' && s.status === 'up') {
    nextEvalAt = learningPeriod(firstPingAt, check.cfg.timezone).end + SETTLE_MS;
  }

  const throttled = ordered.filter((m) => m.f & FLAG_THROTTLED);
  const runawayAt = throttled.length ? throttled[throttled.length - 1].ts : check.runawayAt;

  const drift = paused ? { accepted: check.acceptedShape, pending: null, changes: [] } : assessDrift(check, withShape.map((m) => m.shape!));

  await tx.query(
    `UPDATE checks SET
       status = $2,
       status_changed_at = CASE WHEN status <> $2 THEN $3::timestamptz ELSE status_changed_at END,
       last_ping_at = $4::timestamptz,
       last_start_at = $5::timestamptz,
       last_fail_at = $6::timestamptz,
       next_eval_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE next_eval_at END,
       last_shape = COALESCE($9::text::jsonb, last_shape),
       last_shape_hash = COALESCE($10::text, last_shape_hash),
       payload_warning = $11,
       payload_warning_at = CASE WHEN $12::boolean THEN $13::timestamptz ELSE payload_warning_at END,
       first_ping_at = $14::timestamptz,
       runaway_at = $15::timestamptz,
       accepted_shape = COALESCE($16::text::jsonb, accepted_shape),
       pending_shape = COALESCE($17::text::jsonb, pending_shape)
     WHERE id = $1`,
    [
      check.id,
      s.status,
      iso(now),
      iso(s.lastPingAt),
      iso(s.lastStartAt),
      iso(s.lastFailAt),
      nextEvalAt !== undefined,
      iso(nextEvalAt ?? null),
      lastShape ? JSON.stringify(lastShape.shape) : null,
      lastShape?.sh ?? null,
      warning,
      warningAt !== undefined,
      iso(warningAt ?? null),
      iso(firstPingAt),
      iso(runawayAt),
      drift.accepted && drift.accepted !== check.acceptedShape ? JSON.stringify(drift.accepted) : null,
      drift.pending ? JSON.stringify(drift.pending) : null,
    ],
  );

  const after: Check = { ...check, state: s };
  let alertsQueued = false;
  for (const effect of result.effects) {
    if (effect.type === 'open') {
      alertsQueued = (await openIncident(tx, after, { reason: 'reported_failure', at: effect.at, appUrl })) || alertsQueued;
    } else {
      alertsQueued = (await resolveIncident(tx, after, { at: effect.at, appUrl })) || alertsQueued;
    }
  }

  if (throttled.length && !paused) {
    const opened = await openIncident(tx, after, { kind: 'runaway', reason: 'runaway', at: throttled[0].ts, appUrl });
    if (!opened) {
      // Already alerted: just note that the loop is still going, so it is not auto-resolved yet.
      await tx.query(
        `UPDATE incidents SET last_event_at = $2::timestamptz WHERE check_id = $1 AND kind = 'runaway' AND resolved_at IS NULL`,
        [check.id, iso(runawayAt)],
      );
    }
    alertsQueued = opened || alertsQueued;
  }

  if (drift.pending) {
    const at = withShape[withShape.length - 1].ts;
    alertsQueued =
      (await openIncident(tx, after, { kind: 'drift', reason: 'drift', at, appUrl, details: { changes: drift.changes } })) || alertsQueued;
  }

  return alertsQueued;
}
