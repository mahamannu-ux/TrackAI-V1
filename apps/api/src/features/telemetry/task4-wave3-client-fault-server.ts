import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Keyring = { version: number; credentials: string[] };
type MetricEvent = { a?: Record<string, unknown> };
type MetricsBatch = { events?: MetricEvent[] };

const runtimeDirValue = process.env.TASK4_WAVE3_RUNTIME_DIR?.trim();
if (!runtimeDirValue) throw new Error('TASK4_WAVE3_RUNTIME_DIR is required');
const port = Number(process.env.PORT ?? '8080');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT is invalid');
const keyringPath = resolve(runtimeDirValue, 'trackai-machine-credentials.json');

function eventCase(event: MetricEvent): string | null {
  const custom = event.a?.['30'];
  if (typeof custom !== 'string') return null;
  try {
    const parsed = JSON.parse(custom) as Record<string, unknown>;
    return typeof parsed.task4_wave3_case === 'string' ? parsed.task4_wave3_case : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const keyring = JSON.parse(await readFile(keyringPath, 'utf8')) as Keyring;
  if (keyring.version !== 1 || !Array.isArray(keyring.credentials) || keyring.credentials.length !== 2) {
    throw new Error('Wave 3 credential keyring is invalid');
  }
  const credentials = new Set(keyring.credentials);
  const caseCounts = new Map<string, number>();
  let authenticatedRequests = 0;

  const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (request.method === 'GET' && request.url === '/verify') {
    const counts = Object.fromEntries([...caseCounts.entries()].sort());
    const expected = [
      'company_a_backfill_generation',
      'company_a_current_generation',
      'company_a_old_commit_poison',
      'company_b_current_generation',
      'company_b_old_generation_poison',
    ];
    const allSeenOnce = expected.every(name => counts[name] === 1);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      authenticated_requests: authenticatedRequests,
      cases: counts,
      all_cases_seen_once: allSeenOnce,
      credentials_or_payloads_printed: false,
    }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/worker/metrics/upload') {
    response.writeHead(404).end();
    return;
  }
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey !== 'string' || !credentials.has(apiKey)) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 1_000_000) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', () => {
    try {
      const batch = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MetricsBatch;
      if (!Array.isArray(batch.events)) throw new Error('events missing');
      authenticatedRequests += 1;
      const errors: Array<{ index: number; error: string }> = [];
      batch.events.forEach((event, index) => {
        const name = eventCase(event);
        if (!name) {
          errors.push({ index, error: 'Task4 verification case is missing' });
          return;
        }
        caseCounts.set(name, (caseCounts.get(name) ?? 0) + 1);
        if (name.endsWith('_poison')) {
          errors.push({ index, error: 'Evidence predates the repository enrollment watermark' });
        }
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ errors }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Invalid request' }));
    }
  });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log('task4_wave3_fault_server=running');
    console.log(`port=${port}`);
    console.log('credentials=loaded-not-printed');
    console.log('raw_payloads=not-printed');
  });
}

void main().catch(() => {
  console.error('task4_wave3_fault_server=failed');
  process.exitCode = 1;
});
