// Plain-English wording for alerts and the dashboard. Pure functions.

import { DateTime } from 'luxon';
import type { CheckConfig } from './evaluate';
import type { ActiveWindow } from './window';

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s < 60) return unit(s, 'second');
  const parts: string[] = [];
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) parts.push(unit(days, 'day'));
  if (hours) parts.push(unit(hours, 'hour'));
  if (minutes && !days) parts.push(unit(minutes, 'minute'));
  return parts.join(' ');
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return 'every day';
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(j - i >= 2 ? `${DAY_NAMES[sorted[i]]}–${DAY_NAMES[sorted[j]]}` : sorted.slice(i, j + 1).map((d) => DAY_NAMES[d]).join(', '));
    i = j + 1;
  }
  return runs.join(', ');
}

export function describeWindow(w: ActiveWindow, timezone: string): string {
  return `${formatDays(w.days)}, ${formatClock(w.start)}–${formatClock(w.end)} (${timezone})`;
}

export function describeExpectation(cfg: CheckConfig): string {
  if (cfg.mode === 'schedule') {
    return `a ping on the schedule "${cfg.cron}" (${cfg.timezone}), within ${formatDuration(cfg.graceSeconds)} of each scheduled time`;
  }
  const base = `at least one ping every ${formatDuration(cfg.intervalSeconds ?? 0)}`;
  const window = cfg.activeWindow ? `, counted only during ${describeWindow(cfg.activeWindow, cfg.timezone)}` : '';
  return `${base}${window}, with ${formatDuration(cfg.graceSeconds)} of grace`;
}

export function formatInstant(ms: number, timezone: string): string {
  return DateTime.fromMillis(ms, { zone: timezone }).toFormat("ccc d LLL yyyy, HH:mm ZZZZ");
}

export interface AlertContext {
  name: string;
  cfg: CheckConfig;
  lastPingAt: number | null;
  /** When the event happened (down: when we noticed / failure reported; recovered: the ping). */
  at: number;
  reason?: 'missed' | 'reported_failure';
  /** For "recovered": when the incident opened. */
  openedAt?: number;
  link: string;
}

export interface AlertMessage {
  subject: string;
  body: string;
  link: string;
}

export function composeAlert(event: 'down' | 'recovered', ctx: AlertContext): AlertMessage {
  const tz = ctx.cfg.timezone;
  const expected = describeExpectation(ctx.cfg);
  const lastPing =
    ctx.lastPingAt == null
      ? 'We have not received a successful ping yet.'
      : `The last successful ping arrived ${formatInstant(ctx.lastPingAt, tz)} (${formatDuration((ctx.at - ctx.lastPingAt) / 1000)} earlier).`;

  if (event === 'recovered') {
    const downFor = ctx.openedAt != null ? ` It was down for about ${formatDuration((ctx.at - ctx.openedAt) / 1000)}.` : '';
    return {
      subject: `Recovered: "${ctx.name}" is checking in again`,
      body: [
        `Good news: your automation "${ctx.name}" is working again.`,
        '',
        `What happened: a ping arrived ${formatInstant(ctx.at, tz)}.${downFor}`,
        `What we expect: ${expected}.`,
      ].join('\n'),
      link: ctx.link,
    };
  }

  if (ctx.reason === 'reported_failure') {
    return {
      subject: `Down: "${ctx.name}" reported a failure`,
      body: [
        `Your automation "${ctx.name}" told us that it failed.`,
        '',
        `What happened: it sent a failure signal ${formatInstant(ctx.at, tz)}. ${lastPing}`,
        `What we expect: ${expected}.`,
        '',
        'We will let you know as soon as a successful ping arrives.',
      ].join('\n'),
      link: ctx.link,
    };
  }

  return {
    subject: `Down: "${ctx.name}" has stopped checking in`,
    body: [
      `Your automation "${ctx.name}" has stopped checking in.`,
      '',
      `What we expected: ${expected}.`,
      `What happened: nothing has arrived in time. ${lastPing}`,
      '',
      'Common causes: the workflow was turned off or paused, an earlier step is failing, a connected account needs reconnecting, or the trigger has stopped firing.',
      'We will let you know as soon as it checks in again.',
    ].join('\n'),
    link: ctx.link,
  };
}
