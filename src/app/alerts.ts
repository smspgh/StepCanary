// Incidents + alert outbox.
//
// Idempotency comes from the database, not from careful code:
//  - at most one OPEN incident per check (unique partial index), so "down" can only be raised once
//  - exactly one delivery row per (incident, event, channel) (unique constraint)
// State change, incident and delivery rows are written in one transaction; sending happens
// afterwards from the outbox. Delivery is at-least-once: the only way to get a duplicate is a
// crash between the provider accepting a message and us marking it sent, and we pass the delivery
// id to the provider as an idempotency key where supported.

import { composeAlert } from '../core/describe';
import { randomId } from '../shared/token';
import { iso, ms, type Check, type Db } from './db';

export type DownReason = 'missed' | 'reported_failure';

function checkLink(appUrl: string, checkId: string): string {
  return `${appUrl.replace(/\/$/, '')}/checks/${checkId}`;
}

async function enqueueDeliveries(
  tx: Db,
  incidentId: string,
  event: 'down' | 'recovered',
  checkId: string,
  msg: { subject: string; body: string; link: string },
  at: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO alert_deliveries (id, incident_id, event, channel_id, next_attempt_at, subject, body, link)
     SELECT gen_random_uuid()::text, $1::text, $2::text, cc.channel_id, $3::timestamptz, $4::text, $5::text, $6::text
       FROM check_channels cc WHERE cc.check_id = $7
     ON CONFLICT (incident_id, event, channel_id) DO NOTHING`,
    [incidentId, event, iso(at), msg.subject, msg.body, msg.link, checkId],
  );
}

/** Open a "down" incident and queue its alerts. Returns false if one is already open (no-op). */
export async function openIncident(tx: Db, check: Check, reason: DownReason, at: number, appUrl: string): Promise<boolean> {
  const id = randomId();
  const rows = await tx.query(
    `INSERT INTO incidents (id, check_id, kind, reason, opened_at) VALUES ($1, $2, 'down', $3, $4::timestamptz)
     ON CONFLICT DO NOTHING RETURNING id`,
    [id, check.id, reason, iso(at)],
  );
  if (rows.length === 0) return false;
  const msg = composeAlert('down', {
    name: check.name,
    cfg: check.cfg,
    lastPingAt: check.state.lastPingAt,
    at,
    reason,
    link: checkLink(appUrl, check.id),
  });
  await enqueueDeliveries(tx, id, 'down', check.id, msg, at);
  return true;
}

/** Resolve the open "down" incident (if any) and queue "recovered" alerts. */
export async function resolveIncident(tx: Db, check: Check, at: number, appUrl: string): Promise<boolean> {
  const rows = await tx.query(
    `UPDATE incidents SET resolved_at = $2::timestamptz
      WHERE check_id = $1 AND kind = 'down' AND resolved_at IS NULL
      RETURNING id, opened_at`,
    [check.id, iso(at)],
  );
  if (rows.length === 0) return false;
  const msg = composeAlert('recovered', {
    name: check.name,
    cfg: check.cfg,
    lastPingAt: at,
    at,
    openedAt: ms(rows[0].opened_at) ?? undefined,
    link: checkLink(appUrl, check.id),
  });
  await enqueueDeliveries(tx, rows[0].id, 'recovered', check.id, msg, at);
  return true;
}

export interface OutboundAlert {
  subject: string;
  body: string;
  link: string;
  idempotencyKey: string;
}

export type SendFn = (channel: { kind: string; config: any }, alert: OutboundAlert) => Promise<void>;

const MAX_ATTEMPTS = 10;
const CLAIM_LEASE = "interval '5 minutes'";

function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);
}

/** Send everything due in the outbox. Safe to call concurrently and as often as you like. */
export async function sendPendingAlerts(db: Db, send: SendFn, now: number, limit = 50): Promise<{ sent: number; failed: number }> {
  const claimed = await db.query(
    `UPDATE alert_deliveries d
        SET status = 'sending', claimed_at = $1::timestamptz, attempts = d.attempts + 1
      WHERE d.id IN (
        SELECT id FROM alert_deliveries
         WHERE (status = 'pending' AND next_attempt_at <= $1::timestamptz)
            OR (status = 'sending' AND claimed_at < $1::timestamptz - ${CLAIM_LEASE})
         ORDER BY next_attempt_at, id
         LIMIT ${Math.floor(limit)}
         FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.channel_id, d.subject, d.body, d.link, d.attempts, d.created_at, d.event`,
    [iso(now)],
  );
  // "down" before "recovered" when both are due for the same incident.
  claimed.sort((a, b) => (ms(a.created_at)! - ms(b.created_at)!) || (a.event === 'down' ? -1 : 1));

  let sent = 0;
  let failed = 0;
  for (const d of claimed) {
    try {
      const ch = await db.query('SELECT kind, config FROM channels WHERE id = $1', [d.channel_id]);
      if (ch.length === 0) throw new Error('channel no longer exists');
      const config = typeof ch[0].config === 'string' ? JSON.parse(ch[0].config) : ch[0].config;
      await send({ kind: ch[0].kind, config }, { subject: d.subject, body: d.body, link: d.link, idempotencyKey: d.id });
      await db.query(
        `UPDATE alert_deliveries SET status = 'sent', sent_at = $2::timestamptz, last_error = NULL WHERE id = $1 AND status = 'sending'`,
        [d.id, iso(now)],
      );
      sent++;
    } catch (err) {
      failed++;
      const giveUp = d.attempts >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE alert_deliveries SET status = $2, next_attempt_at = $3::timestamptz, last_error = $4 WHERE id = $1 AND status = 'sending'`,
        [d.id, giveUp ? 'failed' : 'pending', iso(now + backoffMs(d.attempts)), String(err).slice(0, 500)],
      );
    }
  }
  return { sent, failed };
}
