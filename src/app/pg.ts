// Production database adapter: postgres.js over Cloudflare Hyperdrive.

import postgres from 'postgres';
import type { Db } from './db';

function wrap(sql: any): Db {
  return {
    query: async (text, params = []) => [...(await sql.unsafe(text, params as any[]))] as any[],
    tx: (fn) => sql.begin((tx: any) => fn(wrap(tx))) as Promise<any>,
  };
}

export function connect(connectionString: string): { db: Db; close: () => Promise<void> } {
  // One short-lived connection per invocation; Hyperdrive does the real pooling. A single
  // connection also keeps queries strictly ordered, which is all this workload needs.
  const sql = postgres(connectionString, { max: 1, fetch_types: false, onnotice: () => {} });
  return { db: wrap(sql), close: () => sql.end({ timeout: 5 }) };
}
