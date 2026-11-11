// Weekly Client Health Summary (Agency plan): one email per client folder that an agency can
// forward to its client as proof of maintenance. Pure composition; no I/O.

import { DateTime } from 'luxon';

export interface SummaryCheck {
  name: string;
  status: string;
  /** Successful pings in the period. */
  pings: number;
  /** Milliseconds the check spent "down" in the period. */
  downtimeMs: number;
  incidents: number;
  /** When monitoring of this check began (first ping), or null if it never has. */
  monitoredSince: number | null;
}

export interface SummaryInput {
  folderName: string;
  periodStart: number;
  periodEnd: number;
  checks: SummaryCheck[];
}

export interface SummaryEmail {
  subject: string;
  text: string;
  html: string;
}

/** The Monday-to-Monday (UTC) week that ended most recently, and when its summary becomes due. */
export function summaryWeek(now: number): { week: string; periodStart: number; periodEnd: number; dueAt: number } {
  const thisMonday = DateTime.fromMillis(now, { zone: 'utc' }).startOf('week');
  const periodStart = thisMonday.minus({ weeks: 1 });
  return {
    week: periodStart.toFormat("kkkk-'W'WW"),
    periodStart: periodStart.toMillis(),
    periodEnd: thisMonday.toMillis(),
    dueAt: thisMonday.plus({ hours: 9 }).toMillis(), // Monday 09:00 UTC
  };
}

/** Uptime over the part of the period the check was actually being monitored. Null = not monitored. */
export function uptimePercent(c: SummaryCheck, periodStart: number, periodEnd: number): number | null {
  if (c.monitoredSince == null || c.monitoredSince >= periodEnd) return null;
  const span = periodEnd - Math.max(periodStart, c.monitoredSince);
  if (span <= 0) return null;
  return Math.max(0, Math.min(100, (1 - c.downtimeMs / span) * 100));
}

function formatUptime(pct: number | null): string {
  if (pct == null) return 'not yet monitored';
  if (pct >= 99.995) return '100%';
  return `${pct.toFixed(pct >= 99 ? 2 : 1)}%`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STATUS_WORD: Record<string, string> = { up: 'Healthy', late: 'Late', down: 'Down', new: 'Waiting for first run', paused: 'Paused' };

export function composeWeeklySummary(input: SummaryInput): SummaryEmail {
  const from = DateTime.fromMillis(input.periodStart, { zone: 'utc' });
  const to = DateTime.fromMillis(input.periodEnd, { zone: 'utc' }).minus({ days: 1 });
  const range = `${from.toFormat('d LLL')} – ${to.toFormat('d LLL yyyy')}`;
  const totalPings = input.checks.reduce((a, c) => a + c.pings, 0);
  const totalIncidents = input.checks.reduce((a, c) => a + c.incidents, 0);
  const healthy = input.checks.filter((c) => c.status === 'up').length;
  const rows = input.checks.map((c) => ({
    name: c.name,
    status: STATUS_WORD[c.status] ?? c.status,
    pings: c.pings.toLocaleString('en-US'),
    uptime: formatUptime(uptimePercent(c, input.periodStart, input.periodEnd)),
    incidents: String(c.incidents),
  }));

  const headline =
    `${input.checks.length} automation${input.checks.length === 1 ? '' : 's'} monitored, ` +
    `${totalPings.toLocaleString('en-US')} successful run${totalPings === 1 ? '' : 's'}, ` +
    `${totalIncidents === 0 ? 'no incidents' : `${totalIncidents} incident${totalIncidents === 1 ? '' : 's'}`}.`;

  const text = [
    `Weekly automation health summary: ${input.folderName}`,
    range,
    '',
    headline,
    `${healthy} of ${input.checks.length} currently healthy.`,
    '',
    ...rows.map((r) => `- ${r.name}: ${r.status}. ${r.pings} runs, uptime ${r.uptime}, incidents ${r.incidents}.`),
    '',
    'Monitored by StepCanary.',
  ].join('\n');

  const cell = 'padding:8px 10px;border-bottom:1px solid #e3e6ea;text-align:left';
  const html =
    `<div style="font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2128;max-width:640px">` +
    `<h2 style="margin:0 0 4px">Weekly automation health summary</h2>` +
    `<p style="margin:0 0 16px;color:#667085">${esc(input.folderName)} · ${esc(range)}</p>` +
    `<p style="margin:0 0 16px">${esc(headline)} ${healthy} of ${input.checks.length} currently healthy.</p>` +
    `<table style="border-collapse:collapse;width:100%"><thead><tr>` +
    ['Automation', 'Status', 'Successful runs', 'Uptime', 'Incidents'].map((h) => `<th style="${cell};font-size:12px;color:#667085">${h}</th>`).join('') +
    `</tr></thead><tbody>` +
    rows
      .map((r) => `<tr>${[r.name, r.status, r.pings, r.uptime, r.incidents].map((v) => `<td style="${cell}">${esc(v)}</td>`).join('')}</tr>`)
      .join('') +
    `</tbody></table><p style="margin:16px 0 0;color:#667085;font-size:13px">Monitored by StepCanary.</p></div>`;

  return { subject: `Weekly automation health: ${input.folderName} (${range})`, text, html };
}
