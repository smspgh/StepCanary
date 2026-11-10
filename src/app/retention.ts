// Daily housekeeping: roll hourly counts up into daily counts, then delete what is past retention.
//   raw pings + hourly counters: 30 days     daily counters: 12 months
// Every statement is idempotent, so running this twice (or late) is harmless.

import { getState, iso, setState, type Db } from './db';

const DAY = 86_400_000;
const KEY = 'retention_last_run';

export async function runRetentionIfDue(db: Db, now: number): Promise<boolean> {
  const last = Number((await getState(db, KEY)) ?? 0);
  if (now - last < DAY) return false;
  await runRetention(db, now);
  await setState(db, KEY, String(now));
  return true;
}

export async function runRetention(db: Db, now: number): Promise<void> {
  const today = Math.floor(now / DAY) * DAY;

  // Recompute the last 3 complete UTC days from hourly counters (covers late-arriving pings).
  await db.query(
    `INSERT INTO ping_daily (check_id, day, ok, fail)
     SELECT check_id, (hour AT TIME ZONE 'UTC')::date, sum(ok)::int, sum(fail)::int
       FROM ping_hourly
      WHERE hour >= $1::timestamptz AND hour < $2::timestamptz
      GROUP BY 1, 2
     ON CONFLICT (check_id, day) DO UPDATE SET ok = excluded.ok, fail = excluded.fail`,
    [iso(today - 3 * DAY), iso(today)],
  );

  const cutoff30 = iso(now - 30 * DAY);
  await db.query('DELETE FROM pings WHERE received_at < $1::timestamptz', [cutoff30]);
  await db.query('DELETE FROM ping_hourly WHERE hour < $1::timestamptz', [cutoff30]);
  await db.query(`DELETE FROM ping_daily WHERE day < ($1::timestamptz - interval '12 months')::date`, [iso(now)]);

  // Our own bookkeeping.
  await db.query('DELETE FROM evaluator_runs WHERE started_at < $1::timestamptz', [iso(now - 7 * DAY)]);
  await db.query('DELETE FROM monitoring_gaps WHERE ended_at < $1::timestamptz', [iso(now - 90 * DAY)]);
  await db.query('DELETE FROM login_tokens WHERE expires_at < $1::timestamptz', [iso(now - DAY)]);
  await db.query('DELETE FROM sessions WHERE expires_at < $1::timestamptz', [iso(now)]);
  await db.query(
    `DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < $1::timestamptz - interval '12 months'`,
    [iso(now)],
  );
}
