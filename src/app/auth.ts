// Magic-link login. Only hashes of login tokens and session tokens are stored.

import { randomId, randomSecret, sha256Hex } from '../shared/token';
import { iso, ms, type Db } from './db';

export const LOGIN_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 86_400_000;
export const SESSION_COOKIE = 'sc_session';
const MAX_LINKS_PER_WINDOW = 5;

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/** Create a single-use login token. Returns null when this address has asked too often. */
export async function createLoginToken(db: Db, email: string, now: number): Promise<string | null> {
  const recent = await db.query(
    'SELECT count(*)::int AS n FROM login_tokens WHERE email = $1 AND created_at > $2::timestamptz',
    [email, iso(now - LOGIN_TTL_MS)],
  );
  if ((recent[0]?.n ?? 0) >= MAX_LINKS_PER_WINDOW) return null;
  const token = randomSecret();
  await db.query(
    'INSERT INTO login_tokens (token_hash, email, expires_at, created_at) VALUES ($1, $2, $3::timestamptz, $4::timestamptz)',
    [await sha256Hex(token), email, iso(now + LOGIN_TTL_MS), iso(now)],
  );
  return token;
}

/** Redeem a login token (once), creating the account on first sign-in. Returns a session token. */
export async function redeemLoginToken(db: Db, token: string, now: number, defaultPlan: string): Promise<string | null> {
  const hash = await sha256Hex(token);
  return db.tx(async (tx) => {
    const used = await tx.query(
      `UPDATE login_tokens SET used_at = $2::timestamptz
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2::timestamptz RETURNING email`,
      [hash, iso(now)],
    );
    if (used.length === 0) return null;
    const email: string = used[0].email;

    let account = (await tx.query('SELECT id FROM accounts WHERE email = $1', [email]))[0];
    if (!account) {
      const plan = ['free', 'pro', 'agency'].includes(defaultPlan) ? defaultPlan : 'free';
      const id = randomId();
      await tx.query('INSERT INTO accounts (id, email, plan) VALUES ($1, $2, $3)', [id, email, plan]);
      // Every account starts with one alert channel: its own email address.
      await tx.query(`INSERT INTO channels (id, account_id, kind, config) VALUES ($1, $2, 'email', $3::text::jsonb)`, [
        randomId(),
        id,
        JSON.stringify({ email }),
      ]);
      account = { id };
    }

    const session = randomSecret();
    await tx.query('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3::timestamptz)', [
      await sha256Hex(session),
      account.id,
      iso(now + SESSION_TTL_MS),
    ]);
    return session;
  });
}

export interface Account {
  id: string;
  email: string;
  plan: string;
  stripeCustomerId?: string | null;
  /** The subscription is canceled and the paid plan ends at this time (epoch ms). */
  planCancelAt?: number | null;
  /** A plan switch scheduled for later, e.g. a downgrade at the end of the paid period. */
  planChangeTo?: string | null;
  planChangeAt?: number | null;
}

export async function accountForSession(db: Db, sessionToken: string | undefined, now: number): Promise<Account | null> {
  if (!sessionToken) return null;
  const rows = await db.query(
    `SELECT a.id, a.email, a.plan, a.stripe_customer_id, a.plan_cancel_at, a.plan_change_to, a.plan_change_at
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.expires_at > $2::timestamptz`,
    [await sha256Hex(sessionToken), iso(now)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    plan: r.plan,
    stripeCustomerId: r.stripe_customer_id ?? null,
    planCancelAt: ms(r.plan_cancel_at),
    planChangeTo: r.plan_change_to ?? null,
    planChangeAt: ms(r.plan_change_at),
  };
}

export async function destroySession(db: Db, sessionToken: string | undefined): Promise<void> {
  if (sessionToken) await db.query('DELETE FROM sessions WHERE token_hash = $1', [await sha256Hex(sessionToken)]);
}
