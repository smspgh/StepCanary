// Applies migrations/*.sql in order, once each. Usage:
//   DATABASE_URL="postgres://..." npm run migrate
// Use the DIRECT (non-pooled) Neon connection string here.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to your Postgres connection string.');
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) {
      console.log(`= ${file} (already applied)`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(dir, file), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log(`+ ${file}`);
  }
  console.log('Migrations up to date.');
} finally {
  await sql.end();
}
