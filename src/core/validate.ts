// Turns the check form into a CheckConfig, with messages a non-developer can act on.

import { Cron } from 'croner';
import { DateTime } from 'luxon';
import type { CheckConfig } from './evaluate';
import type { PlanLimits } from './plans';
import type { ActiveWindow } from './window';

export type FormData = Record<string, string | string[] | undefined>;

export interface ValidatedCheck {
  name: string;
  cfg: CheckConfig;
}

const UNIT_SECONDS: Record<string, number> = { minutes: 60, hours: 3600, days: 86400 };
const MIN_SECONDS = 60;
const MAX_SECONDS = 365 * 86400;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? '').trim();
}

function many(v: string | string[] | undefined): string[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function duration(form: FormData, field: string, label: string, errors: string[]): number {
  const value = Number(one(form[`${field}_value`]));
  const unit = UNIT_SECONDS[one(form[`${field}_unit`])];
  if (!Number.isFinite(value) || value <= 0 || !unit) {
    errors.push(`${label}: enter a number greater than zero.`);
    return 0;
  }
  const seconds = Math.round(value * unit);
  if (seconds < MIN_SECONDS) errors.push(`${label}: the minimum is 1 minute.`);
  if (seconds > MAX_SECONDS) errors.push(`${label}: the maximum is 365 days.`);
  return seconds;
}

function clock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) <= 24 && Number(m[2]) < 60 && minutes <= 1440 ? minutes : null;
}

export function isValidTimezone(tz: string): boolean {
  return tz !== '' && DateTime.now().setZone(tz).isValid;
}

export function validateCron(expr: string, timezone: string): string | null {
  if (expr.split(/\s+/).length !== 5) {
    return 'Schedule: use 5 fields (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5".';
  }
  try {
    if (!new Cron(expr, { timezone }).nextRun()) return 'Schedule: this schedule never runs.';
    return null;
  } catch {
    return 'Schedule: we could not understand this schedule. Example: "0 9 * * 1-5" = 09:00 on weekdays.';
  }
}

export function validateCheckForm(form: FormData, limits: PlanLimits): { ok: true; value: ValidatedCheck } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const name = one(form.name);
  if (!name) errors.push('Name: give this check a name, e.g. "New lead → CRM".');
  if (name.length > 100) errors.push('Name: keep it under 100 characters.');

  const timezone = one(form.timezone) || 'UTC';
  if (!isValidTimezone(timezone)) errors.push('Timezone: pick a timezone like "Europe/London".');

  const mode = one(form.mode) === 'schedule' ? 'schedule' : 'interval';
  const graceSeconds = duration(form, 'grace', 'Grace period', errors);

  let intervalSeconds: number | null = null;
  let cron: string | null = null;
  let activeWindow: ActiveWindow | null = null;

  if (mode === 'schedule') {
    if (!limits.scheduleMode) errors.push('Schedule mode is part of the Pro plan.');
    cron = one(form.cron).replace(/\s+/g, ' ');
    const err = isValidTimezone(timezone) ? validateCron(cron, timezone) : null;
    if (err) errors.push(err);
  } else {
    intervalSeconds = duration(form, 'interval', 'Interval', errors);
    if (one(form.window_enabled)) {
      if (!limits.activeWindows) errors.push('Active windows are part of the Pro plan.');
      const days = [...new Set(many(form.window_days).map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
      const start = clock(one(form.window_start));
      const end = clock(one(form.window_end));
      if (days.length === 0) errors.push('Active window: pick at least one day.');
      if (start == null || end == null) errors.push('Active window: enter times as HH:MM, e.g. 09:00 and 18:00.');
      else if (end <= start) errors.push('Active window: the end time must be after the start time (overnight windows are not supported yet).');
      if (days.length && start != null && end != null && end > start) activeWindow = { days, start, end };
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { name, cfg: { mode, intervalSeconds, cron, timezone, graceSeconds, activeWindow } } };
}
