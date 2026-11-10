import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { DateTime } from 'luxon';
import type { Db } from '../src/app/db';
import type { CheckConfig, CheckState } from '../src/core/evaluate';

/** A wall-clock time in a timezone -> epoch ms. at('2026-03-27 17:30', 'Europe/London') */
export function at(local: string, zone = 'UTC'): number {
  const dt = DateTime.fromSQL(local, { zone });
  if (!dt.isValid) throw new Error(`bad time ${local} ${zone}`);
  return dt.toMillis();
}

export const MIN = 60_000;
export const HOUR = 3_600_000;

export function intervalCfg(over: Partial<CheckConfig> = {}): CheckConfig {
  return { mode: 'interval', intervalSeconds: 3600, cron: null, timezone: 'UTC', graceSeconds: 600, activeWindow: null, ...over };
}

export function scheduleCfg(cron: string, timezone: string, graceSeconds = 600): CheckConfig {
  return { mode: 'schedule', intervalSeconds: null, cron, timezone, graceSeconds, activeWindow: null };
}

export function state(over: Partial<CheckState> = {}): CheckState {
  return { status: 'up', lastPingAt: null, lastStartAt: null, lastFailAt: null, clockResetAt: null, ...over };
}

function wrap(q: any): Db {
  return {
    query: async (text, params = []) => (await q.query(text, params)).rows,
    tx: (fn) => q.transaction((tx: any) => fn(wrap(tx))),
  };
}

/** A real Postgres (PGlite, in-process) with the production migrations applied. */
export async function testDb(): Promise<{ db: Db; reset: () => Promise<void>; close: () => Promise<void> }> {
  const pg = new PGlite();
  const dir = join(__dirname, '..', 'migrations');
  for (const file of readdirSync(dir).sort()) await pg.exec(readFileSync(join(dir, file), 'utf8'));
  const db = wrap(pg);
  return {
    db,
    reset: async () => {
      await pg.exec(
        'TRUNCATE accounts, login_tokens, sessions, channels, checks, check_channels, pings, ping_hourly, ping_daily, incidents, alert_deliveries, evaluator_runs, monitoring_gaps, system_state CASCADE',
      );
    },
    close: () => pg.close(),
  };
}
