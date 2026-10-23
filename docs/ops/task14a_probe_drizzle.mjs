#!/usr/bin/env node
// Run the same node-postgres Drizzle migrator inside an outer rollback transaction.
// The Python launcher supplies a verified disposable-project URL and captures output.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const pg = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');

const expectedRef = 'glwwxaobocwoczvjmrod';
const expectedHost = 'aws-0-ap-northeast-1.pooler.supabase.com';
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/');
if (
  process.env.TASK14A_ROLLBACK_PROBE !== expectedRef ||
  url.hostname !== expectedHost ||
  url.port !== '5432' ||
  decodeURIComponent(url.username) !== `postgres.${expectedRef}` ||
  url.pathname !== '/postgres' ||
  url.searchParams.get('sslmode') !== 'verify-full' ||
  !url.searchParams.get('sslrootcert')
) {
  console.error('Task14a probe refused: destination identity mismatch.');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const db = drizzle(pool);
const rollbackMarker = 'TASK14A_INTENTIONAL_PROBE_ROLLBACK';
let exitCode = 1;
try {
  await db.transaction(async (tx) => {
    await migrate(tx, {
      migrationsFolder: fileURLToPath(new URL('../../apps/api/drizzle', import.meta.url)),
    });
    throw new Error(rollbackMarker);
  });
} catch (error) {
  if (error instanceof Error && error.message === rollbackMarker) {
    console.log('probe=pass_rolled_back');
    exitCode = 0;
  } else {
    const chain = [];
    let current = error;
    while (current && chain.length < 5) {
      chain.push({
        name: current.name,
        message: current.message,
        code: current.code,
        detail: current.detail,
        hint: current.hint,
        table: current.table,
        constraint: current.constraint,
      });
      current = current.cause;
    }
    console.error(JSON.stringify({ probe: 'failed_rolled_back', chain }, null, 2));
  }
} finally {
  await pool.end();
}
process.exitCode = exitCode;
