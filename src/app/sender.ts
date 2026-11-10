// Turns an outbox row into a real notification. Email only in the MVP;
// Slack / Discord / generic webhook arrive in Step 3 and plug in here.

import type { SendFn } from './alerts';
import { sendEmail, simpleHtml, type EmailEnv } from './email';

export function makeSender(env: EmailEnv): SendFn {
  return async (channel, alert) => {
    if (channel.kind !== 'email') throw new Error(`channel kind "${channel.kind}" is not supported yet`);
    await sendEmail(env, {
      to: channel.config.email,
      subject: alert.subject,
      text: `${alert.body}\n\nOpen this check: ${alert.link}`,
      html: simpleHtml(alert.body, { url: alert.link, label: 'Open this check' }),
      idempotencyKey: alert.idempotencyKey,
    });
  };
}
