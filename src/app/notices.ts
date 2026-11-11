// One-off emails to the account owner that are not alerts about an incident.

import { composeBaselineReady } from '../core/describe';
import { iso, type Db } from './db';
import { simpleHtml, type Email } from './email';

/**
 * "Your 14-day volume baseline is ready to review": sent once when a check finishes learning.
 * Volume checks are set-and-forget, so nobody would come back to enable alerts unprompted.
 * Each check is claimed with a conditional update before sending, so the email goes out once
 * even if two evaluator runs overlap; a failed send releases the claim and is retried next minute.
 */
export async function sendBaselineReadyNotices(db: Db, send: (email: Email) => Promise<void>, now: number, appUrl: string, limit = 20): Promise<number> {
  const due = await db.query(
    `SELECT c.id, c.name, a.email FROM checks c JOIN accounts a ON a.id = c.account_id
      WHERE c.mode = 'volume' AND c.baseline_status = 'ready' AND c.baseline_notified_at IS NULL
      ORDER BY c.id LIMIT ${Math.floor(limit)}`,
  );
  let sent = 0;
  for (const row of due) {
    const claimed = await db.query(
      `UPDATE checks SET baseline_notified_at = $2::timestamptz
        WHERE id = $1 AND baseline_status = 'ready' AND baseline_notified_at IS NULL RETURNING id`,
      [row.id, iso(now)],
    );
    if (claimed.length === 0) continue;
    try {
      const link = `${appUrl.replace(/\/$/, '')}/checks/${row.id}`;
      const msg = composeBaselineReady(row.name, link);
      await send({
        to: row.email,
        subject: msg.subject,
        text: `${msg.body}\n\nReview the baseline: ${link}`,
        html: simpleHtml(msg.body, { url: link, label: 'Review the baseline' }),
        idempotencyKey: `baseline-ready-${row.id}-${now}`,
      });
      sent++;
    } catch (err) {
      console.error('baseline_notice_failed', row.id, String(err));
      await db.query('UPDATE checks SET baseline_notified_at = NULL WHERE id = $1', [row.id]);
    }
  }
  return sent;
}
