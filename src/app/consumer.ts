// Queue consumer: turns a batch of ping messages into rows and state changes, in one transaction.
// If anything fails the whole batch is retried by the queue; redelivered messages are no-ops
// because pings are keyed by the ingest message id.

import { applyEvents, type PingEvent } from '../core/evaluate';
import { FLAG_MALFORMED, FLAG_TOO_LARGE, isPingMessage, type PingMessage } from '../shared/messages';
import { openIncident, resolveIncident } from './alerts';
import { CANARY_KEY, iso, latestGapEnd, recordGap, setState, getState, toCheck, type Db } from './db';

/** A batch landing this long after the edge received it means ingestion was not keeping up. */
export const LATE_BATCH_MS = 120_000;

export interface ConsumeResult {
  pings: number;
  alertsQueued: boolean;
}

export async function consumeBatch(db: Db, bodies: unknown[], now: number, canaryToken: string, appUrl: string): Promise<ConsumeResult> {
  const msgs = bodies.filter(isPingMessage);
  if (msgs.length === 0) return { pings: 0, alertsQueued: false };

  const oldest = Math.min(...msgs.map((m) => m.ts));
  if (now - oldest > LATE_BATCH_MS) await recordGap(db, oldest, now, 'ingest_delay');

  const canary = msgs.filter((m) => m.t === canaryToken);
  if (canary.length) {
    const newest = Math.max(...canary.map((m) => m.ts));
    const current = Number((await getState(db, CANARY_KEY)) ?? 0);
    if (newest > current) await setState(db, CANARY_KEY, String(newest));
  }

  const pings = msgs.filter((m) => m.t !== canaryToken);
  if (pings.length === 0) return { pings: 0, alertsQueued: false };

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
    if (records.length === 0) return { pings: 0, alertsQueued: false };

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
    if (inserted.length === 0) return { pings: 0, alertsQueued: false };

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
    let alertsQueued = false;
    const checksById = new Map([...byToken.values()].map((c) => [c.id, c]));

    for (const [checkId, list] of perCheck) {
      const check = checksById.get(checkId)!;
      const events: PingEvent[] = list.map((m) => ({ ts: m.ts, kind: m.k }));
      const result = applyEvents(check.cfg, check.state, events, gapEnd);
      const s = result.state;

      // Payload notes come from the newest non-start ping in the batch.
      const latest = list.filter((m) => m.k !== 'start').sort((a, b) => b.ts - a.ts)[0];
      const withShape = list.filter((m) => m.shape).sort((a, b) => b.ts - a.ts)[0];
      let warning = check.payloadWarning;
      let warningAt: number | null | undefined; // undefined = leave as is
      if (latest) {
        const next = latest.f & FLAG_MALFORMED ? 'malformed' : latest.f & FLAG_TOO_LARGE ? 'too_large' : null;
        if (next !== warning) {
          warning = next;
          warningAt = next ? latest.ts : null;
        }
      }

      await tx.query(
        `UPDATE checks SET
           status = $2,
           status_changed_at = CASE WHEN status <> $2 THEN $3::timestamptz ELSE status_changed_at END,
           last_ping_at = $4::timestamptz,
           last_start_at = $5::timestamptz,
           last_fail_at = $6::timestamptz,
           next_eval_at = $7::timestamptz,
           last_shape = COALESCE($8::text::jsonb, last_shape),
           last_shape_hash = COALESCE($9::text, last_shape_hash),
           payload_warning = $10,
           payload_warning_at = CASE WHEN $11::boolean THEN $12::timestamptz ELSE payload_warning_at END
         WHERE id = $1`,
        [
          check.id,
          s.status,
          iso(now),
          iso(s.lastPingAt),
          iso(s.lastStartAt),
          iso(s.lastFailAt),
          iso(result.nextEvalAt),
          withShape ? JSON.stringify(withShape.shape) : null,
          withShape?.sh ?? null,
          warning,
          warningAt !== undefined,
          iso(warningAt ?? null),
        ],
      );

      const after = { ...check, state: s };
      for (const effect of result.effects) {
        if (effect.type === 'open') {
          alertsQueued = (await openIncident(tx, { ...after, state: { ...s, lastPingAt: check.state.lastPingAt } }, 'reported_failure', effect.at, appUrl)) || alertsQueued;
        } else {
          alertsQueued = (await resolveIncident(tx, after, effect.at, appUrl)) || alertsQueued;
        }
      }
    }

    return { pings: inserted.length, alertsQueued };
  });
}
