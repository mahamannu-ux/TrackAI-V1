import 'dotenv/config';

import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

interface ColumnContract {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
}

function columnSignature(column: ColumnContract): string {
  return [
    `${column.table_name}.${column.column_name}`,
    column.data_type,
    column.udt_name,
    column.is_nullable,
  ].join(':');
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const migrationDirectory = resolve(__dirname, '../../../drizzle');
  const migrationFiles = (await readdir(migrationDirectory))
    .filter(file => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  if (migrationFiles.length !== 10
    || migrationFiles[0]?.slice(0, 4) !== '0000'
    || migrationFiles.at(-1)?.slice(0, 4) !== '0009') {
    throw new Error('Expected the canonical 0000 through 0009 migration chain');
  }

  const disposableSchema = `task4_wave6_fresh_${randomBytes(8).toString('hex')}`;
  const quotedSchema = `"${disposableSchema}"`;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave6-fresh-schema-dry-run',
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    const expectedTables = (await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name <> 'items'
      ORDER BY table_name
    `)).rows.map(row => row.table_name);
    const expectedColumns = (await client.query<ColumnContract>(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'items'
      ORDER BY table_name, ordinal_position
    `)).rows;
    const expectedRlsTables = (await client.query<{ table_name: string }>(`
      SELECT relname AS table_name
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relkind = 'r' AND relrowsecurity
        AND relname <> 'items'
      ORDER BY relname
    `)).rows.map(row => row.table_name);

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET LOCAL search_path TO ${quotedSchema}, public`);

    for (const migrationFile of migrationFiles) {
      const original = await readFile(resolve(migrationDirectory, migrationFile), 'utf8');
      const isolated = original
        .replaceAll('"public".', `${quotedSchema}.`)
        .replaceAll('--> statement-breakpoint', '\n');
      await client.query(isolated);
    }

    const actualTables = (await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `, [disposableSchema])).rows.map(row => row.table_name);
    const actualColumns = (await client.query<ColumnContract>(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position
    `, [disposableSchema])).rows;
    const actualRlsTables = (await client.query<{ table_name: string }>(`
      SELECT relname AS table_name
      FROM pg_class
      WHERE relnamespace = $1::regnamespace
        AND relkind = 'r' AND relrowsecurity
      ORDER BY relname
    `, [disposableSchema])).rows.map(row => row.table_name);

    if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
      throw new Error('Fresh migration table contract differs from the persistent schema');
    }
    const expectedSignatures = expectedColumns.map(columnSignature).sort();
    const actualSignatures = actualColumns.map(columnSignature).sort();
    if (JSON.stringify(actualSignatures) !== JSON.stringify(expectedSignatures)) {
      const missing = expectedSignatures.filter(signature => !actualSignatures.includes(signature));
      const unexpected = actualSignatures.filter(signature => !expectedSignatures.includes(signature));
      throw new Error(
        `Fresh migration column contract differs from the persistent schema; missing=${missing.join(',') || 'none'}; unexpected=${unexpected.join(',') || 'none'}`,
      );
    }
    if (JSON.stringify(actualRlsTables) !== JSON.stringify(expectedRlsTables)) {
      const missing = expectedRlsTables.filter(table => !actualRlsTables.includes(table));
      const unexpected = actualRlsTables.filter(table => !expectedRlsTables.includes(table));
      throw new Error(
        `Fresh migration RLS contract differs from the persistent schema; missing=${missing.join(',') || 'none'}; unexpected=${unexpected.join(',') || 'none'}`,
      );
    }

    console.log('migration_chain=0000-through-0009');
    console.log(`fresh_schema_tables=${actualTables.length}`);
    console.log(`fresh_schema_columns=${actualColumns.length}`);
    console.log(`rls_enabled_tables=${actualRlsTables.length}`);
    console.log('table_contract=matches-persistent');
    console.log('column_contract=matches-persistent');
    console.log('rls_contract=matches-persistent');
    console.log('tenant_rows_read=0');
    console.log('database_changes=transaction-only');

    await client.query('ROLLBACK');
    transactionOpen = false;
    const [{ present }] = (await client.query<{ present: boolean }>(
      'SELECT to_regnamespace($1) IS NOT NULL AS present', [disposableSchema],
    )).rows;
    if (present) throw new Error('Disposable fresh schema remained after rollback');
    console.log('migration_dry_run=rolled-back');
    console.log('after_rollback_schema=absent');
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Fresh migration-chain verification failed');
  process.exitCode = 1;
});
