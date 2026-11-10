// Local development database: PGlite (Postgres compiled to WASM) served over the Postgres wire
// protocol on 127.0.0.1:5433, so `wrangler dev` can use it with no Postgres or Docker install.
// Data lives in ./.dev-db (delete the folder to start fresh). DEVELOPMENT ONLY: PGlite has a single
// session, so connections are served one at a time.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.DEV_DB_PORT ?? 5433);
const db = new PGlite(process.env.DEV_DB_MEMORY ? undefined : join(root, '.dev-db'));

await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
for (const file of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  await db.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
  await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  console.log(`applied ${file}`);
}

const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 1 });
await server.start();
console.log(`dev database ready: postgres://postgres:postgres@127.0.0.1:${port}/postgres`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
