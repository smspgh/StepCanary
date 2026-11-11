// Incidents + alert outbox.
//
// Idempotency comes from the database, not from careful code:
//  - at most one OPEN incident per check and kind (unique partial index), so an alert for
//    "down", "drift" or "runaway" can only be raised once per occurrence
//  - exactly one delivery row per (incident, event, channel) (unique constraint)
// State change, incident and delivery rows are written in one transaction; sending happens
// afterwards from the outbox. Delivery is at-least-once: the only way to get a duplicate is a
// crash between the provider accepting a message and us marking it sent, and we pass the delivery
// id to the provider as an idempotency key where supported.

import { composeAlert, type AlertEvent, type VolumeFacts } from '../core/describe';
import { randomId } from '../shared/token';
import { asJson, iso, ms, type Check, type Db } from './db';

export type IncidentKind = 'down' | 'drift' | 'runaway';
export type DownReason = 'missed' | 'reported_failure' | 'low_volume';

export interface IncidentDetails {
  volume?: VolumeFacts;
  /** Drift: plain-English change lines (key names only). */
  changes?: string[];
}

function checkLink(appUrl: string, checkId: string): string {
  return `${appUrl.replace(/\/$/, '')}/checks/${checkId}`;
}

async function enqueueDeliveries(
  tx: Db,
  incidentId: string,
  event: AlertEvent,
  checkId: string,
  msg: { subject: string; body: string; link: string },
  at: number,
): Promise<void> {
  // Free accounts alert by email only; other channels stay configured but silent after a downgrade.
  await tx.query(
    `INSERT INTO alert_deliveries (id, incident_id, event, channel_id, next_attempt_at, subject, body, link)
     SELECT gen_random_uuid()::text, $1::text, $2::text, cc.channel_id, $3::timestamptz, $4::text, $5::text, $6::text
       FROM check_channels cc
       JOIN channels ch ON ch.id = cc.channel_id
       JOIN accounts a ON a.id = ch.account_id
      WHERE cc.check_id = $7 AND (ch.kind = 'email' OR a.plan <> 'free')
     ON CONFLICT (incident_id, event, channel_id) DO NOTHING`,
    [incidentId, event, iso(at), msg.subject, msg.body, msg.link, checkId],
  );
}

export interface OpenOptions {
  kind?: IncidentKind;
  reason: DownReason | 'drift' | 'runaway';
  at: number;
  appUrl: string;
  details?: IncidentDetails;
}

/** Open an incident and queue its alerts. Returns false if one of that kind is already open (no-op). */
export async function openIncident(tx: Db, check: Check, opts: OpenOptions): Promise<boolean> {
  const kind = opts.kind ?? 'down';
  const id = randomId();
  const rows = await tx.query(
    `INSERT INTO incidents (id, check_id, kind, reason, opened_at, last_event_at, details)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6::text::jsonb)
     ON CONFLICT DO NOTHING RETURNING id`,
    [id, check.id, kind, opts.reason, iso(opts.at), opts.details ? JSON.stringify(opts.details) : null],
  );
  if (rows.length === 0) return false;
  const msg = composeAlert(kind, {
    name: check.name,
    cfg: check.cfg,
    lastPingAt: check.state.lastPingAt,
    at: opts.at,
    reason: kind === 'down' ? (opts.reason as DownReason) : undefined,
    volume: opts.details?.volume,
    changes: opts.details?.changes,
    link: checkLink(opts.appUrl, check.id),
  });
  await enqueueDeliveries(tx, id, kind, check.id, msg, opts.at);
  return true;
}

export interface ResolveOptions {
  kind?: IncidentKind;
  at: number;
  appUrl: string;
  /** Send "recovered" alerts. Only "down" incidents announce their recovery. */
  notify?: boolean;
  volume?: VolumeFacts;
}

/** Resolve the open incident of a kind (if any). Returns true if there was one. */
export async function resolveIncident(tx: Db, check: Check, opts: ResolveOptions): Promise<boolean> {
  const kind = opts.kind ?? 'down';
  const rows = await tx.query(
    `UPDATE incidents SET resolved_at = $2::timestamptz
      WHERE check_id = $1 AND kind = $3 AND resolved_at IS NULL
      RETURNING id, opened_at`,
    [check.id, iso(opts.at), kind],
  );
  if (rows.length === 0) return false;
  if (kind === 'down' && opts.notify !== false) {
    const msg = composeAlert('recovered', {
      name: check.name,
      cfg: check.cfg,
      lastPingAt: opts.at,
      at: opts.at,
      openedAt: ms(rows[0].opened_at) ?? undefined,
      volume: opts.volume,
      link: checkLink(opts.appUrl, check.id),
    });
    await enqueueDeliveries(tx, rows[0].id, 'recovered', check.id, msg, opts.at);
  }
  return true;
}

export interface OpenIncident {
  id: string;
  kind: IncidentKind;
  reason: string;
  openedAt: number;
  details: IncidentDetails | null;
}

export async function openIncidents(db: Db, checkId: string): Promise<OpenIncident[]> {
  const rows = await db.query(
    'SELECT id, kind, reason, opened_at, details FROM incidents WHERE check_id = $1 AND resolved_at IS NULL ORDER BY opened_at',
    [checkId],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, openedAt: ms(r.opened_at)!, details: asJson<IncidentDetails>(r.details) }));
}

export interface OutboundAlert {
  event: AlertEvent;
  subject: string;
  body: string;
  link: string;
  checkId: string;
  checkName: string;
  at: number;
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
      RETURNING d.id, d.channel_id, d.incident_id, d.subject, d.body, d.link, d.attempts, d.created_at, d.event`,
    [iso(now)],
  );
  // "down" before "recovered" when both are due for the same incident.
  claimed.sort((a, b) => (ms(a.created_at)! - ms(b.created_at)!) || (a.event === 'recovered' ? 1 : -1));

  let sent = 0;
  let failed = 0;
  for (const d of claimed) {
    try {
      const ch = await db.query('SELECT kind, config FROM channels WHERE id = $1', [d.channel_id]);
      if (ch.length === 0) throw new Error('channel no longer exists');
      const info = await db.query(
        'SELECT c.id, c.name FROM incidents i JOIN checks c ON c.id = i.check_id WHERE i.id = $1',
        [d.incident_id],
      );
      await send(
        { kind: ch[0].kind, config: asJson(ch[0].config) },
        {
          event: d.event,
          subject: d.subject,
          body: d.body,
          link: d.link,
          checkId: info[0]?.id ?? '',
          checkName: info[0]?.name ?? '',
          at: ms(d.created_at) ?? now,
          idempotencyKey: d.id,
        },
      );
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
