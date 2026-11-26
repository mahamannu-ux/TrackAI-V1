/**
 * IT-T19i-01 global setup: seed the throwaway database, then start the local sign-in stub,
 * the real API and a production build of the real web app, each on a free port.
 *
 * Runs only inside scripts/it-db.sh (DATABASE_URL on 127.0.0.1 and both ephemeral flags);
 * the seed and the stub refuse anything else too. The seed, stub and API start in a temporary
 * directory, so no developer `apps/api/.env` is loaded; the web build reads `apps/web/.env.local`
 * if one exists, but the explicit NEXT_PUBLIC_* values below win. Inherited Supabase, GitHub App
 * and Attesta variables are dropped. Printed lines carry no secrets.
 *
 * The production build needs `apps/web/.next` (next.config.mjs). An existing `.next` is moved
 * aside first and put back at teardown, so the developer's own build is unchanged afterwards;
 * stop any `next start` serving from `.next` before a run (`next dev` uses `.next-dev`).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WEB = resolve(__dirname, '..');
const REPO = resolve(WEB, '../..');
const API = join(REPO, 'apps/api');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const NEXT = join(REPO, 'node_modules/.bin/next');
const BUILD = join(WEB, '.next');

/** The caller's environment without settings that would point the stack at real services. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(SUPABASE_|NEXT_PUBLIC_|GITHUB_|ATTESTA_|TRACKAI_|FRONTEND_URL$|PORT$)/.test(key)) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

async function waitFor(url: string, what: string, child: ChildProcess, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`IT-T19i-01 setup: ${what} exited with code ${child.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`IT-T19i-01 setup: ${what} did not answer within ${timeoutMs / 1000} s`);
}

function stopGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

function start(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, log: string[]): ChildProcess {
  // Own process group, so stopping it also stops what tsx or next start spawned.
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) log.push(`[${name}] ${line}`);
    if (log.length > 400) log.splice(0, log.length - 400);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return child;
}

/**
 * Manual mode (TASK19I_HOLD=1): keep the seeded stack up for a person to click through the
 * walkthrough, print where to sign in, and run no test. Ctrl-C stops everything, and
 * scripts/it-db.sh then removes the database. The passwords are the stub's local-only ones.
 */
async function hold(manifestPath: string, webOrigin: string, teardown: () => Promise<void>): Promise<never> {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    companyA: { repositoryName: string; repositoryId: string };
    codeReport: { from: string; to: string }; securityReport: { from: string; to: string };
    users: Record<string, { email: string; password: string }>;
  };
  const local = (iso: string) => new Date(iso).toLocaleString();
  const link = (q: string, period: { from: string; to: string }, repository?: string) => `${webOrigin}/dashboard?${new URLSearchParams({
    view: 'questions', qaQuestion: q, qaKind: 'signed', qaPeriod: 'custom', qaFrom: period.from, qaTo: period.to,
    qaScope: repository ? 'repository' : 'tenant', ...(repository ? { qaRepository: repository } : {}) }).toString()}`;
  console.log([
    '',
    `IT-T19i-01 manual mode: open ${webOrigin}/login`,
    ...Object.entries(m.users).map(([who, u]) => `  ${who.padEnd(9)} ${u.email}  password: ${u.password}`),
    `  Company A repository: ${m.companyA.repositoryName}`,
    `  Q3 signed (step 2): Custom range ${local(m.codeReport.from)} to ${local(m.codeReport.to)}, scope Repository, or open (as auditor A)`,
    `    ${link('Q3', m.codeReport, m.companyA.repositoryId)}`,
    `  S1 signed (step 7): Custom range ${local(m.securityReport.from)} to ${local(m.securityReport.to)}, scope Entire tenant, or open`,
    `    ${link('S1', m.securityReport)}`,
    '  Press Ctrl-C to stop; the throwaway database is removed.',
  ].join('\n'));
  const stop = () => { void teardown().finally(() => process.exit(130)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return new Promise<never>(() => undefined);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (process.env.TASK5_EPHEMERAL_DATABASE !== '1' || process.env.TASK6_EPHEMERAL_DATABASE !== '1' || !databaseUrl
    || !['127.0.0.1', 'localhost'].includes(new URL(databaseUrl).hostname)) {
    throw new Error('IT-T19i-01 runs only inside scripts/it-db.sh: use `npm run e2e:task19-walkthrough` from the repository root');
  }
  // A run killed before teardown leaves the developer's build aside: never move `.next`
  // again on top of it, and never delete a build we cannot identify.
  const orphans = readdirSync(WEB).filter((name) => name.startsWith('.next-before-task19i-'));
  if (orphans.length > 0) {
    throw new Error([
      `IT-T19i-01 setup: found ${orphans.map((o) => `apps/web/${o}`).join(', ')} from an interrupted earlier run.`,
      'Each is the web build that existed before that run; apps/web/.next (if any) is the walkthrough\'s own build.',
      'Check dates with `ls -ld apps/web/.next*`. To restore yours: rm -rf apps/web/.next && mv apps/web/<oldest .next-before-task19i-*> apps/web/.next',
      'Delete any other copy only once you know it is not a build you want, then run again.',
    ].join('\n'));
  }
  const work = mkdtempSync(join(tmpdir(), 'trackai-task19i-'));
  const manifestPath = join(work, 'manifest.json');
  // Free ports by default; fixed ones only when re-running against an earlier web build
  // (TASK19I_SKIP_WEB_BUILD=1 needs the ports that build baked in).
  const port = async (name: string) => Number(process.env[name]) || freePort();
  const [authPort, apiPort, webPort] = [await port('TASK19I_AUTH_PORT'), await port('TASK19I_API_PORT'), await port('TASK19I_WEB_PORT')];
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const authUrl = `http://127.0.0.1:${authPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const children: ChildProcess[] = [];
  const log: string[] = [];
  let movedBuild: string | null = null;
  /** Synchronous, so it also runs from an 'exit' handler when Ctrl-C ends the process first. */
  const restoreBuild = () => {
    if (!movedBuild) return;
    rmSync(BUILD, { recursive: true, force: true });
    renameSync(movedBuild, BUILD);
    movedBuild = null;
  };
  process.on('exit', () => {
    for (const child of children) stopGroup(child, 'SIGKILL');
    restoreBuild();
  });
  const teardown = async () => {
    for (const child of children) stopGroup(child, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 2000));
    for (const child of children) stopGroup(child, 'SIGKILL');
    restoreBuild();
    rmSync(work, { recursive: true, force: true });
  };

  try {
    // 1. Seed (synchronous: the steps need the whole world).
    console.log('IT-T19i-01 setup: seeding the throwaway database');
    const seed = spawnSync(TSX, [join(API, 'src/features/qa/testing/task19i-walkthrough-seed.ts'), manifestPath, join(work, 'attesta')],
      { cwd: work, env: cleanEnv(), encoding: 'utf8', timeout: 170_000 });
    const seedLines = `${seed.stdout ?? ''}${seed.stderr ?? ''}`.split('\n').filter((l) => /IT-T19i-01|failed|Error/.test(l));
    for (const line of seedLines) console.log(`  ${line}`);
    if (seed.status !== 0) throw new Error('IT-T19i-01 setup: the seed failed (lines above)');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { apiEnv: Record<string, string> };

    // 2. The sign-in stub, then the API that trusts it.
    const base: NodeJS.ProcessEnv = { ...cleanEnv(), NODE_ENV: 'test' };
    const auth = start('auth', TSX, [join(API, 'src/features/qa/testing/task19i-walkthrough-auth.ts')],
      { ...base, TASK19I_AUTH_PORT: String(authPort), TASK19I_WEB_ORIGIN: webOrigin }, work, log);
    children.push(auth);
    await waitFor(`${authUrl}/health`, 'the sign-in stub', auth);
    const api = start('api', TSX, [join(API, 'src/index.ts')], {
      ...base, ...manifest.apiEnv, SUPABASE_URL: authUrl, PORT: String(apiPort), FRONTEND_URL: webOrigin,
    }, work, log);
    children.push(api);
    await waitFor(`${apiUrl}/health`, 'the API', api);

    // 3. The web app: a production build pointing at the stub and this API.
    const webEnv: NodeJS.ProcessEnv = { ...cleanEnv(), NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: authUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'task19i-local-placeholder', NEXT_PUBLIC_API_URL: apiUrl };
    if (process.env.TASK19I_SKIP_WEB_BUILD !== '1') {
      if (existsSync(BUILD)) {
        movedBuild = join(WEB, `.next-before-task19i-${process.pid}`);
        renameSync(BUILD, movedBuild);
      }
      console.log('IT-T19i-01 setup: building the web app (about two minutes)');
      const build = spawnSync(NEXT, ['build'], { cwd: WEB, env: webEnv, encoding: 'utf8', timeout: 600_000 });
      if (build.status !== 0) {
        console.log(`${build.stdout ?? ''}${build.stderr ?? ''}`.split('\n').slice(-40).join('\n'));
        throw new Error('IT-T19i-01 setup: the web build failed (last lines above)');
      }
    }
    const web = start('web', NEXT, ['start', '-p', String(webPort), '-H', '127.0.0.1'], webEnv, WEB, log);
    children.push(web);
    await waitFor(`${webOrigin}/login`, 'the web app', web);

    Object.assign(process.env, {
      TASK19I_MANIFEST: manifestPath, TASK19I_WEB_URL: webOrigin, TASK19I_API_URL: apiUrl, TASK19I_AUTH_URL: authUrl,
    });
    console.log('IT-T19i-01 setup: ready (stub, API and web app on free local ports)');
    if (process.env.TASK19I_HOLD === '1') await hold(manifestPath, webOrigin, teardown);
    return async () => {
      if (process.env.TASK19I_SHOW_LOGS === '1') console.log(log.join('\n'));
      await teardown();
    };
  } catch (error) {
    console.log(log.slice(-60).join('\n'));
    await teardown();
    throw error;
  }
}
