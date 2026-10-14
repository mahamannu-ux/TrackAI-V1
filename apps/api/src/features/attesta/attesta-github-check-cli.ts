/**
 * `npm run attesta:github-checks -w apps/api [-- --tenant <uuid>] [--limit 200]`
 *
 * Runs one GitHub check pass: for each selected pull request it posts (or
 * patches) the informational "TrackAI Attesta" check run through the tenant's
 * installed GitHub App, then prints the counts. Production scheduling (every 5
 * minutes, after the build and anchor passes) is Task14's. Needs DATABASE_URL.
 */
import 'dotenv/config';
import { pool } from '../../core/db';
import { githubGetStatus, githubWrite } from '../scm/github-app';
import { runGithubCheckPass } from './github-check';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseGithubCheckArgs(argv: string[]): { tenantId?: string; limit: number } {
  let tenantId: string | undefined;
  let limit = 200;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tenant') {
      const value = argv[i + 1];
      if (!value || !UUID_RE.test(value)) throw new Error('--tenant must be a lowercase UUID');
      tenantId = value;
      i += 1;
    } else if (arg.startsWith('--tenant=')) {
      const value = arg.slice('--tenant='.length);
      if (!UUID_RE.test(value)) throw new Error('--tenant must be a lowercase UUID');
      tenantId = value;
    } else if (arg === '--limit') {
      const value = argv[i + 1];
      if (!value || !/^[1-9]\d*$/.test(value)) throw new Error('--limit must be a positive whole number');
      limit = Number(value);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      const value = arg.slice('--limit='.length);
      if (!/^[1-9]\d*$/.test(value)) throw new Error('--limit must be a positive whole number');
      limit = Number(value);
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  return { tenantId, limit };
}

export function formatCheckPass(result: {
  tenants: number; prs: number; created: number; updated: number; unchanged: number;
  skipped_no_installation: number; permission_missing: number; not_found: number;
  failed: number; skipped_url: number;
}): string {
  return `attesta_github_checks tenants=${result.tenants} prs=${result.prs} created=${result.created} `
    + `updated=${result.updated} unchanged=${result.unchanged} `
    + `skipped_no_installation=${result.skipped_no_installation} permission_missing=${result.permission_missing} `
    + `not_found=${result.not_found} failed=${result.failed} skipped_url=${result.skipped_url}`;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { tenantId, limit } = parseGithubCheckArgs(process.argv.slice(2));
  const result = await runGithubCheckPass(
    pool,
    { write: githubWrite, getStatus: githubGetStatus, env: process.env },
    { tenantId, now: new Date(), limit },
  );
  console.log(formatCheckPass(result));
}

if (require.main === module) {
  void main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'attesta:github-checks failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
