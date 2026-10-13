/**
 * `npm run attesta:anchor -w apps/api [-- --loop --tenant <uuid> --max-batch 256 --partial-after-ms 600000]`
 *
 * Runs one anchoring pass (or a pass every 5 minutes with `--loop`, for local use;
 * `--sleep-ms` overrides). Production scheduling is Task14's. Needs DATABASE_URL and
 * the anchoring variables of anchor-env.ts (the dev signer only: production refuses
 * to start until Task15l). Prints counts and codes only: no IDs, no URLs, no keys.
 */
import 'dotenv/config';
import { db, pool } from '../../core/db';
import { parseArgs } from './attesta-build-cli';
import { anchorFromEnv } from './anchor-env';
import { runAnchorPass, type AnchorPassOptions, type AnchorPassResult } from './anchor-worker';

export const DEFAULT_LOOP_SLEEP_MS = 300_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN = new Set(['loop', 'tenant', 'max-batch', 'partial-after-ms', 'sleep-ms', 'limit-tenants']);

function intArg(args: Map<string, string>, name: string): number | undefined {
  const raw = args.get(name);
  if (raw === undefined) return undefined;
  if (!/^\d{1,10}$/.test(raw)) throw new Error(`--${name} must be a whole number`);
  return Number(raw);
}

/** CLI arguments → pass options (refuses anything unknown). */
export function parseAnchorArgs(argv: string[]): { options: AnchorPassOptions; loop: boolean; sleepMs: number } {
  const args = parseArgs(argv);
  for (const k of args.keys()) if (!KNOWN.has(k)) throw new Error(`unknown option --${k}`);
  const tenantId = args.get('tenant');
  if (tenantId !== undefined && !UUID_RE.test(tenantId)) throw new Error('--tenant must be a lowercase UUID');
  const loop = args.get('loop') === 'true';
  if (args.has('loop') && !loop) throw new Error('--loop takes no value');
  const sleepMs = intArg(args, 'sleep-ms') ?? DEFAULT_LOOP_SLEEP_MS;
  if (sleepMs < 1000) throw new Error('--sleep-ms must be at least 1000');
  return {
    options: {
      tenantId, maxBatch: intArg(args, 'max-batch'), partialAfterMs: intArg(args, 'partial-after-ms'),
      limitTenants: intArg(args, 'limit-tenants'),
    },
    loop,
    sleepMs,
  };
}

/** One summary line: counts and codes only. */
export function formatPass(r: AnchorPassResult): string {
  const codes = Object.entries(r.codes).sort().map(([code, n]) => `${code}:${n}`).join(',') || 'none';
  return `attesta_anchor_pass tenants=${r.tenants} busy=${r.busy} batches_anchored=${r.batchesAnchored} ` +
    `records_anchored=${r.recordsAnchored} batches_failed=${r.batchesFailed} batches_stopped=${r.batchesStopped} ` +
    `batches_backoff=${r.batchesBackoff} superseded=${r.superseded} already_anchored=${r.alreadyAnchored} ` +
    `records_waiting=${r.recordsWaiting} tenant_errors=${r.tenantErrors} stopped_on_outage=${r.stoppedOnOutage} codes=${codes}`;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { options, loop, sleepMs } = parseAnchorArgs(process.argv.slice(2));
  const { anchor } = await anchorFromEnv(process.env);
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  console.log(`attesta_anchor mode=${loop ? 'loop' : 'once'}`);
  do {
    const r = await runAnchorPass(db, { anchor }, options);
    console.log(formatPass(r));
    if (r.tenantErrors > 0) process.exitCode = 1;
    if (loop && !stop) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  } while (loop && !stop);
}

if (require.main === module) {
  void main()
    .catch((error) => {
      // Configuration errors name variables only; anything else prints its class, not its text.
      console.error(error instanceof Error && error.name === 'AnchorConfigError' ? error.message
        : `attesta:anchor failed (${error instanceof Error ? error.name : 'error'})`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
