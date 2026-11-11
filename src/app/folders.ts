// Client folders (Agency plan) and the weekly client health summary job.

import { composeWeeklySummary, summaryWeek, type SummaryCheck } from '../core/summary';
import { randomId } from '../shared/token';
import { iso, ms, type Db } from './db';
import type { Email } from './email';

export interface Folder {
  id: string;
  name: string;
  checks: number;
}

export async function listFolders(db: Db, accountId: string): Promise<Folder[]> {
  const rows = await db.query(
    `SELECT f.id, f.name, (SELECT count(*)::int FROM checks c WHERE c.folder_id = f.id) AS checks
       FROM folders f WHERE f.account_id = $1 ORDER BY lower(f.name), f.id`,
    [accountId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, checks: r.checks }));
}

export function cleanFolderName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name && name.length <= 80 ? name : null;
}

export async function createFolder(db: Db, accountId: string, name: string, now: number = Date.now()): Promise<string> {
  const id = randomId();
  await db.query('INSERT INTO folders (id, account_id, name, created_at) VALUES ($1, $2, $3, $4::timestamptz)', [id, accountId, name, iso(now)]);
  return id;
}

export async function renameFolder(db: Db, accountId: string, id: string, name: string): Promise<void> {
  await db.query('UPDATE folders SET name = $3 WHERE id = $1 AND account_id = $2', [id, accountId, name]);
}

/** Delete a folder. Its checks are kept and simply become unfiled. */
export async function deleteFolder(db: Db, accountId: string, id: string): Promise<void> {
  await db.query('DELETE FROM folders WHERE id = $1 AND account_id = $2', [id, accountId]);
}

export async function folderBelongsTo(db: Db, accountId: string, id: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM folders WHERE id = $1 AND account_id = $2', [id, accountId])).length > 0;
}

async function folderStats(db: Db, folderId: string, start: number, end: number): Promise<SummaryCheck[]> {
  const rows = await db.query(
    `SELECT c.name, c.status, c.first_ping_at,
            COALESCE((SELECT sum(h.ok)::int FROM ping_hourly h
                       WHERE h.check_id = c.id AND h.hour >= $2::timestamptz AND h.hour < $3::timestamptz), 0) AS pings,
            COALESCE((SELECT sum(EXTRACT(EPOCH FROM (LEAST(COALESCE(i.resolved_at, $3::timestamptz), $3::timestamptz)
                                                     - GREATEST(i.opened_at, $2::timestamptz))))::float8
                        FROM incidents i
                       WHERE i.check_id = c.id AND i.kind = 'down' AND i.opened_at < $3::timestamptz
                         AND COALESCE(i.resolved_at, $3::timestamptz) > $2::timestamptz), 0) AS down_seconds,
            (SELECT count(*)::int FROM incidents i
              WHERE i.check_id = c.id AND i.kind = 'down' AND i.opened_at >= $2::timestamptz AND i.opened_at < $3::timestamptz) AS incidents
       FROM checks c WHERE c.folder_id = $1 ORDER BY lower(c.name), c.id`,
    [folderId, iso(start), iso(end)],
  );
  return rows.map((r) => ({
    name: r.name,
    status: r.status,
    pings: Number(r.pings),
    downtimeMs: Math.round(Number(r.down_seconds) * 1000),
    incidents: r.incidents,
    monitoredSince: ms(r.first_ping_at),
  }));
}

/**
 * Send this week's summary for every Agency folder that has not had one yet. Runs from the
 * every-minute cron; each folder is claimed with a conditional update first, so a week is sent
 * once even if two runs overlap. A failed send releases the claim and is retried next minute.
 */
export async function runWeeklySummaries(db: Db, send: (email: Email) => Promise<void>, now: number, limit = 20): Promise<number> {
  const { week, periodStart, periodEnd, dueAt } = summaryWeek(now);
  if (now < dueAt) return 0;

  const due = await db.query(
    `SELECT f.id, f.name, f.last_summary_week, a.email
       FROM folders f JOIN accounts a ON a.id = f.account_id
      WHERE a.plan = 'agency' AND f.last_summary_week IS DISTINCT FROM $1
        AND f.created_at < $2::timestamptz  -- no summary for a week before the folder existed
        AND EXISTS (SELECT 1 FROM checks c WHERE c.folder_id = f.id)
      ORDER BY f.id LIMIT ${Math.floor(limit)}`,
    [week, iso(periodEnd)],
  );

  let sent = 0;
  for (const f of due) {
    const claimed = await db.query(
      'UPDATE folders SET last_summary_week = $2 WHERE id = $1 AND last_summary_week IS DISTINCT FROM $2 RETURNING id',
      [f.id, week],
    );
    if (claimed.length === 0) continue;
    try {
      const checks = await folderStats(db, f.id, periodStart, periodEnd);
      const email = composeWeeklySummary({ folderName: f.name, periodStart, periodEnd, checks });
      await send({ to: f.email, ...email, idempotencyKey: `summary-${f.id}-${week}` });
      sent++;
    } catch (err) {
      console.error('weekly_summary_failed', f.id, String(err));
      await db.query('UPDATE folders SET last_summary_week = $2 WHERE id = $1', [f.id, f.last_summary_week ?? null]);
    }
  }
  return sent;
}
