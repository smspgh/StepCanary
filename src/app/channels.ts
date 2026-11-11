// Alert channels. Every account has its own email address as a channel; paid plans can add
// Slack, Discord and generic webhooks. Webhook URLs are secrets (anyone holding one can post to
// the customer's workspace), so they are encrypted at rest and never shown again in full.

import { encryptSecret } from '../shared/crypto';
import { randomId } from '../shared/token';
import { asJson, type Db } from './db';

export type ChannelKind = 'email' | 'slack' | 'discord' | 'webhook';

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;
  /** Safe to display: an email address, or the webhook's host with the rest hidden. */
  target: string;
}

export const KIND_LABEL: Record<ChannelKind, string> = { email: 'Email', slack: 'Slack', discord: 'Discord', webhook: 'Webhook' };

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.lan|\[.*\]|\d{1,3}(\.\d{1,3}){3})$/i;

/** Returns an error message, or null if the URL is acceptable for this kind of channel. */
export function validateChannelUrl(kind: ChannelKind, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'Enter the full webhook URL, starting with https://';
  }
  if (url.protocol !== 'https:') return 'The webhook URL must start with https://';
  if (url.username || url.password) return 'The webhook URL must not contain a username or password.';
  if (PRIVATE_HOST.test(url.hostname)) return 'The webhook URL must be a public address.';
  if (kind === 'slack' && url.hostname !== 'hooks.slack.com') {
    return 'A Slack incoming webhook URL starts with https://hooks.slack.com/services/…';
  }
  if (kind === 'discord' && !(/^(discord|discordapp)\.com$/.test(url.hostname) && url.pathname.startsWith('/api/webhooks/'))) {
    return 'A Discord webhook URL starts with https://discord.com/api/webhooks/…';
  }
  return null;
}

export async function listChannels(db: Db, accountId: string): Promise<Channel[]> {
  const rows = await db.query('SELECT id, kind, name, config FROM channels WHERE account_id = $1 ORDER BY created_at, id', [accountId]);
  return rows.map((r) => {
    const config = asJson<{ email?: string; host?: string }>(r.config) ?? {};
    return {
      id: r.id,
      kind: r.kind,
      name: r.name ?? (r.kind === 'email' ? 'Your email' : KIND_LABEL[r.kind as ChannelKind]),
      target: r.kind === 'email' ? config.email ?? '' : `${config.host ?? ''}/…`,
    };
  });
}

/** Add a webhook-style channel and attach it to every existing check in the account. */
export async function addChannel(db: Db, accountId: string, kind: ChannelKind, name: string, url: string, key: string): Promise<string> {
  const id = randomId();
  const clean = url.trim();
  const config = { enc: await encryptSecret(clean, key), host: new URL(clean).hostname };
  await db.tx(async (tx) => {
    await tx.query('INSERT INTO channels (id, account_id, kind, name, config) VALUES ($1, $2, $3, $4, $5::text::jsonb)', [
      id,
      accountId,
      kind,
      name.trim().slice(0, 60) || KIND_LABEL[kind],
      JSON.stringify(config),
    ]);
    await tx.query('INSERT INTO check_channels (check_id, channel_id) SELECT id, $1::text FROM checks WHERE account_id = $2', [id, accountId]);
  });
  return id;
}

/** Delete a channel. The account's own email channel cannot be removed. */
export async function deleteChannel(db: Db, accountId: string, id: string): Promise<boolean> {
  const rows = await db.query(`DELETE FROM channels WHERE id = $1 AND account_id = $2 AND kind <> 'email' RETURNING id`, [id, accountId]);
  return rows.length > 0;
}

export async function getChannelRaw(db: Db, accountId: string, id: string): Promise<{ kind: string; config: any } | null> {
  const rows = await db.query('SELECT kind, config FROM channels WHERE id = $1 AND account_id = $2', [id, accountId]);
  return rows[0] ? { kind: rows[0].kind, config: asJson(rows[0].config) } : null;
}

export async function channelIdsForCheck(db: Db, checkId: string): Promise<string[]> {
  return (await db.query('SELECT channel_id FROM check_channels WHERE check_id = $1', [checkId])).map((r) => r.channel_id);
}
