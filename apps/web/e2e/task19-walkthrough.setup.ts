/**
 * IT-T19i-01 global setup: seed the throwaway database, then start the local sign-in stub,
 * the real API and a production build of the real web app, each on a free port.
 *
 * Runs only inside scripts/it-db.sh (DATABASE_URL on 127.0.0.1 and both ephemeral flags);
 * the seed and the stub refuse anything else too. Every process starts in a temporary
 * directory, so no developer `.env` file is loaded (dotenv never overrides, but a stray
 * setting must not change what the walkthrough sees). Printed lines carry no secrets.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WEB = resolve(__dirname, '..');
const REPO = resolve(WEB, '../..');
const API = join(REPO, 'apps/api');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const NEXT = join(REPO, 'node_modules/.bin/next');

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

function start(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, log: string[]): ChildProcess {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) log.push(`[${name}] ${line}`);
    if (log.length > 400) log.splice(0, log.length - 400);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return child;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (process.env.TASK5_EPHEMERAL_DATABASE !== '1' || process.env.TASK6_EPHEMERAL_DATABASE !== '1' || !databaseUrl
    || !['127.0.0.1', 'localhost'].includes(new URL(databaseUrl).hostname)) {
    throw new Error('IT-T19i-01 runs only inside scripts/it-db.sh: use `npm run e2e:task19-walkthrough` from the repository root');
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
  const teardown = async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(work, { recursive: true, force: true });
  };

  try {
    // 1. Seed (synchronous: the steps need the whole world).
    console.log('IT-T19i-01 setup: seeding the throwaway database');
    const seed = spawnSync(TSX, [join(API, 'src/features/qa/testing/task19i-walkthrough-seed.ts'), manifestPath, join(work, 'attesta')],
      { cwd: work, env: process.env, encoding: 'utf8', timeout: 170_000 });
    const seedLines = `${seed.stdout ?? ''}${seed.stderr ?? ''}`.split('\n').filter((l) => /IT-T19i-01|failed|Error/.test(l));
    for (const line of seedLines) console.log(`  ${line}`);
    if (seed.status !== 0) throw new Error('IT-T19i-01 setup: the seed failed (lines above)');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { apiEnv: Record<string, string> };

    // 2. The sign-in stub, then the API that trusts it.
    const base: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
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
    const webEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: authUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'task19i-local-placeholder', NEXT_PUBLIC_API_URL: apiUrl };
    if (process.env.TASK19I_SKIP_WEB_BUILD !== '1') {
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
