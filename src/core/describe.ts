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
  if (cfg.mode === 'volume') {
    const window = cfg.activeWindow ? ` (counting only ${describeWindow(cfg.activeWindow, cfg.timezone)})` : '';
    return `ping volume to stay above ${cfg.volumeThresholdPct ?? 50}% of what is normal for the day${window}`;
  }
  const base = `at least one ping every ${formatDuration(cfg.intervalSeconds ?? 0)}`;
  const window = cfg.activeWindow ? `, counted only during ${describeWindow(cfg.activeWindow, cfg.timezone)}` : '';
  return `${base}${window}, with ${formatDuration(cfg.graceSeconds)} of grace`;
}

export function formatInstant(ms: number, timezone: string): string {
  return DateTime.fromMillis(ms, { zone: timezone }).toFormat("ccc d LLL yyyy, HH:mm ZZZZ");
}

export type AlertEvent = 'down' | 'recovered' | 'drift' | 'runaway';

export interface VolumeFacts {
  expected: number;
  actual: number;
  /** "on a Tuesday" / "between 14:00 and 15:00 on a Tuesday" */
  when: string;
  /** "Tue 10 Nov" */
  label: string;
  pct: number;
}

export interface AlertContext {
  name: string;
  cfg: CheckConfig;
  lastPingAt: number | null;
  /** When the event happened (down: when we noticed / failure reported; recovered: the ping). */
  at: number;
  reason?: 'missed' | 'reported_failure' | 'low_volume';
  /** For "recovered": when the incident opened. */
  openedAt?: number;
  /** For low-volume down / recovered. */
  volume?: VolumeFacts;
  /** For "drift": one plain-English line per change (key names only). */
  changes?: string[];
  link: string;
}

export interface AlertMessage {
  subject: string;
  body: string;
  link: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function composeAlert(event: AlertEvent, ctx: AlertContext): AlertMessage {
  const tz = ctx.cfg.timezone;
  const expected = describeExpectation(ctx.cfg);
  const lastPing =
    ctx.lastPingAt == null
      ? 'We have not received a successful ping yet.'
      : `The last successful ping arrived ${formatInstant(ctx.lastPingAt, tz)} (${formatDuration((ctx.at - ctx.lastPingAt) / 1000)} earlier).`;

  if (event === 'runaway') {
    return {
      subject: `Runaway loop detected: "${ctx.name}"`,
      body: [
        `Your automation "${ctx.name}" is pinging us more than 60 times a minute, which usually means it is stuck in a loop.`,
        '',
        `What we expected: ${expected}.`,
        `What happened: since ${formatInstant(ctx.at, tz)} it has been sending pings far faster than that. We still count it as alive, but we are ignoring the extra pings.`,
        '',
        'Common causes: a workflow that triggers itself, a loop step with no exit condition, or a retry storm after an error. Check it soon: a looping automation can burn through your task quota quickly.',
      ].join('\n'),
      link: ctx.link,
    };
  }

  if (event === 'drift') {
    return {
      subject: `Payload changed: "${ctx.name}"`,
      body: [
        `The data your automation "${ctx.name}" sends has changed shape.`,
        '',
        'What changed:',
        ...(ctx.changes ?? []).map((line) => `• ${line}`),
        '',
        'The automation is still running, but a field that went blank or missing often means a mapping broke upstream.',
        'If this change is expected, open the check and choose "Accept new shape" or "Mark as optional" so you are not alerted about it again.',
      ].join('\n'),
      link: `${ctx.link}#drift`,
    };
  }

  if (event === 'recovered') {
    const downFor = ctx.openedAt != null ? ` It was down for about ${formatDuration((ctx.at - ctx.openedAt) / 1000)}.` : '';
    const what = ctx.volume
      ? `${plural(ctx.volume.actual, 'ping')} arrived ${ctx.volume.label}, which is back in the normal range (usually about ${ctx.volume.expected} ${ctx.volume.when}).${downFor}`
      : `a ping arrived ${formatInstant(ctx.at, tz)}.${downFor}`;
    return {
      subject: ctx.volume ? `Recovered: "${ctx.name}" volume is back to normal` : `Recovered: "${ctx.name}" is checking in again`,
      body: [`Good news: your automation "${ctx.name}" is working again.`, '', `What happened: ${what}`, `What we expect: ${expected}.`].join('\n'),
      link: ctx.link,
    };
  }

  if (ctx.reason === 'low_volume' && ctx.volume) {
    const v = ctx.volume;
    return {
      subject: `Down: "${ctx.name}" volume has dropped`,
      body: [
        `Your automation "${ctx.name}" is running far less often than normal.`,
        '',
        `What we expected: usually about ${plural(v.expected, 'ping')} ${v.when}. We alert below ${v.pct}% of that.`,
        `What happened: only ${plural(v.actual, 'ping')} arrived ${v.label}.`,
        '',
        'Common causes: the trigger has stopped firing for some records, a filter or path changed, a connected account needs reconnecting, or the source simply had less activity than usual.',
        'We will let you know when volume is back to normal.',
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
