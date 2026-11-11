// Turns an outbox row into a real notification: email, Slack, Discord or a generic webhook.

import { decryptSecret } from '../shared/crypto';
import type { OutboundAlert, SendFn } from './alerts';
import { sendEmail, simpleHtml, type EmailEnv } from './email';

export interface SenderEnv extends EmailEnv {
  CHANNEL_KEY?: string;
}

type FetchFn = typeof fetch;

/** The HTTP request for a webhook-style channel. Pure, so the formats can be tested. */
export function buildWebhookRequest(kind: string, url: string, alert: OutboundAlert): { url: string; init: RequestInit } {
  let payload: unknown;
  if (kind === 'slack') {
    payload = { text: `*${alert.subject}*\n${alert.body}\n<${alert.link}|Open this check>` };
  } else if (kind === 'discord') {
    // Discord rejects messages over 2000 characters.
    const room = 2000 - alert.subject.length - alert.link.length - 10;
    const body = alert.body.length > room ? `${alert.body.slice(0, Math.max(0, room - 1))}…` : alert.body;
    payload = { content: `**${alert.subject}**\n${body}\n${alert.link}` };
  } else {
    payload = {
      event: alert.event,
      check: { id: alert.checkId, name: alert.checkName },
      subject: alert.subject,
      message: alert.body,
      url: alert.link,
      sent_at: new Date(alert.at).toISOString(),
      delivery_id: alert.idempotencyKey,
    };
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'StepCanary-Alerts/1.0' },
      body: JSON.stringify(payload),
    },
  };
}

export function makeSender(env: SenderEnv, fetchImpl: FetchFn = fetch): SendFn {
  return async (channel, alert) => {
    if (channel.kind === 'email') {
      await sendEmail(
        env,
        {
          to: channel.config.email,
          subject: alert.subject,
          text: `${alert.body}\n\nOpen this check: ${alert.link}`,
          html: simpleHtml(alert.body, { url: alert.link, label: 'Open this check' }),
          idempotencyKey: alert.idempotencyKey,
        },
        fetchImpl,
      );
      return;
    }
    if (channel.kind !== 'slack' && channel.kind !== 'discord' && channel.kind !== 'webhook') {
      throw new Error(`unknown channel kind "${channel.kind}"`);
    }
    const target = await decryptSecret(channel.config.enc, env.CHANNEL_KEY ?? '');
    const { url, init } = buildWebhookRequest(channel.kind, target, alert);
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    // Never include the URL in the error: it ends up in last_error and in logs.
    if (!res.ok) throw new Error(`${channel.kind} webhook responded ${res.status}`);
  };
}
