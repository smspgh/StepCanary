// Production database adapter: postgres.js over Cloudflare Hyperdrive.

import postgres from 'postgres';
import type { Db } from './db';

/**
 * Queries are sent strictly one at a time. Code may still fire several with Promise.all, but
 * they are never pipelined on the connection: concurrent parameterised queries on a single
 * Hyperdrive connection can hang.
 */
function wrap(sql: any): Db {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  };
  return {
    query: (text, params = []) => serial(async () => [...(await sql.unsafe(text, params as any[]))] as any[]),
    tx: (fn) => serial(() => sql.begin((tx: any) => fn(wrap(tx))) as Promise<any>),
  };
}

export function connect(connectionString: string): { db: Db; close: () => Promise<void> } {
  // One short-lived connection per invocation; Hyperdrive does the real pooling.
  const sql = postgres(connectionString, { max: 1, fetch_types: false, onnotice: () => {} });
  return { db: wrap(sql), close: () => sql.end({ timeout: 5 }) };
}
