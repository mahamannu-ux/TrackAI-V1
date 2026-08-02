import 'dotenv/config';

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, open, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function main(): Promise<void> {
  const databaseValue = process.env.DATABASE_URL;
  const backupDirValue = process.env.TASK4_BACKUP_DIR?.trim();
  if (!databaseValue) throw new Error('DATABASE_URL is required');
  if (!backupDirValue) throw new Error('TASK4_BACKUP_DIR is required');
  const database = new URL(databaseValue);
  if (database.protocol !== 'postgres:' && database.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be PostgreSQL');
  }
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ''));
  if (!database.hostname || !databaseName || !database.username) {
    throw new Error('DATABASE_URL is incomplete');
  }

  const backupDir = resolve(backupDirValue);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  await chmod(backupDir, 0o700);
  const backupPath = join(backupDir, `trackai-pre-wave4-${timestamp()}.dump`);
  const handle = await open(backupPath, 'wx', 0o600);
  await handle.close();

  const pgEnvironment = {
    ...process.env,
    PGHOST: database.hostname,
    PGPORT: database.port || '5432',
    PGDATABASE: databaseName,
    PGUSER: decodeURIComponent(database.username),
    PGPASSWORD: decodeURIComponent(database.password),
    PGSSLMODE: database.searchParams.get('sslmode') ?? 'require',
  };
  try {
    const dump = spawnSync('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--file', backupPath,
    ], { env: pgEnvironment, encoding: 'utf8' });
    if (dump.status !== 0) throw new Error('pg_dump failed');
    await chmod(backupPath, 0o600);
    const verify = spawnSync('pg_restore', ['--list', backupPath], {
      env: process.env,
      encoding: 'utf8',
    });
    if (verify.status !== 0 || !verify.stdout.includes('; Archive created at')) {
      throw new Error('pg_restore verification failed');
    }
    const metadata = await stat(backupPath);
    if (metadata.size === 0) throw new Error('Backup file is empty');
    console.log('backup=created-and-verified');
    console.log(`backup_file=${backupPath}`);
    console.log(`backup_bytes=${metadata.size}`);
    console.log(`backup_permissions=${(metadata.mode & 0o777).toString(8)}`);
  } catch (error) {
    await unlink(backupPath).catch(() => undefined);
    throw error;
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 4 backup failed');
  process.exitCode = 1;
});
