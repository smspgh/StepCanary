// Tiny email provider adapter. Choose with EMAIL_PROVIDER = "resend" | "postmark" | "console".
// "console" logs instead of sending (local development).

export interface EmailEnv {
  EMAIL_PROVIDER?: string;
  EMAIL_FROM: string;
  RESEND_API_KEY?: string;
  POSTMARK_TOKEN?: string;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Lets the provider drop an accidental resend of the same alert (Resend supports this). */
  idempotencyKey?: string;
}

type FetchFn = typeof fetch;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function simpleHtml(text: string, link?: { url: string; label: string }, footer?: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = link
    ? `<p style="margin:20px 0"><a href="${escapeHtml(link.url)}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(link.label)}</a></p>`
    : '';
  return `<div style="font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2128;max-width:560px">${paragraphs}${button}${footer ? `<p style="margin:22px 0 0;padding-top:12px;border-top:1px solid #e3e6ea;color:#667085;font-size:13px">${escapeHtml(footer)}</p>` : ''}</div>`;
}

export function buildRequest(env: EmailEnv, email: Email): { url: string; init: RequestInit } {
  const provider = (env.EMAIL_PROVIDER ?? 'console').toLowerCase();
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
    const headers: Record<string, string> = { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' };
    if (email.idempotencyKey) headers['idempotency-key'] = email.idempotencyKey;
    return {
      url: 'https://api.resend.com/emails',
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
      },
    };
  }
  if (provider === 'postmark') {
    if (!env.POSTMARK_TOKEN) throw new Error('POSTMARK_TOKEN is not set');
    return {
      url: 'https://api.postmarkapp.com/email',
      init: {
        method: 'POST',
        headers: { 'x-postmark-server-token': env.POSTMARK_TOKEN, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          From: env.EMAIL_FROM,
          To: email.to,
          Subject: email.subject,
          TextBody: email.text,
          HtmlBody: email.html,
          MessageStream: 'outbound',
        }),
      },
    };
  }
  throw new Error(`Unknown EMAIL_PROVIDER "${provider}" (use resend, postmark or console)`);
}

export async function sendEmail(env: EmailEnv, email: Email, fetchImpl: FetchFn = fetch): Promise<void> {
  if ((env.EMAIL_PROVIDER ?? 'console').toLowerCase() === 'console') {
    console.log(`[email:console] to=${email.to} subject=${email.subject}\n${email.text}`);
    return;
  }
  const { url, init } = buildRequest(env, email);
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`email provider responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
