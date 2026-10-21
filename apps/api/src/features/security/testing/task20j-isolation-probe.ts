/** E20-12: safe Company A/B read-isolation probe for the local week stack. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type User = { email: string; password: string };
type Page<T> = { items?: T[]; rows?: T[]; next_cursor: string | null };

async function token(user: User): Promise<string> {
  const response = await fetch('http://127.0.0.1:54321/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!response.ok) throw new Error(`local auth failed: ${response.status}`);
  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new Error('local auth returned no token');
  return body.access_token;
}

async function get(path: string, bearer: string): Promise<Response> {
  return fetch(`http://127.0.0.1:8080${path}`, { headers: { Authorization: `Bearer ${bearer}` } });
}

async function all<T>(path: string, bearer: string, key: 'items' | 'rows'): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(path, 'http://127.0.0.1:8080');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await get(`${url.pathname}${url.search}`, bearer);
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    const page = await response.json() as Page<T>;
    const entries = page[key];
    if (!Array.isArray(entries)) throw new Error(`unexpected ${path} page`);
    result.push(...entries);
    cursor = page.next_cursor;
  } while (cursor);
  return result;
}

async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error('usage: task20j-isolation-probe.ts <private-directory>');
  const directory = resolve(process.argv[2]);
  const users = (JSON.parse(readFileSync(join(directory, 'private/auth.json'), 'utf8')) as { users: User[] }).users;
  const a = users.find(user => user.email === 'admin@task20j-a.acceptance.invalid');
  const b = users.find(user => user.email === 'admin@task20j-b.acceptance.invalid');
  if (!a || !b) throw new Error('Company A/B administrators are missing');
  const { machineId } = JSON.parse(readFileSync(join(directory, 'aliases.json'), 'utf8')) as { machineId: string };
  const [aToken, bToken] = await Promise.all([token(a), token(b)]);
  const [aFindings, bFindings, aCoverage, bCoverage] = await Promise.all([
    all<{ id: string }>('/api/admin/security/v2/findings?generation=v2', aToken, 'items'),
    all<{ id: string }>('/api/admin/security/v2/findings?generation=v2', bToken, 'items'),
    all<{ machine_id: string }>('/api/admin/security/v2/coverage', aToken, 'rows'),
    all<{ machine_id: string }>('/api/admin/security/v2/coverage', bToken, 'rows'),
  ]);
  if (!aFindings.length || !aCoverage.some(row => row.machine_id === machineId)) {
    throw new Error('Company A live finding or machine is missing');
  }
  if (bFindings.some(row => aFindings.some(aRow => aRow.id === row.id))
    || bCoverage.some(row => row.machine_id === machineId)) {
    throw new Error('Company B read contains Company A data');
  }
  const detail = await get(`/api/admin/security/v2/findings/${encodeURIComponent(aFindings[0].id)}`, bToken);
  if (detail.status !== 404) throw new Error(`Company B finding detail returned ${detail.status}, expected 404`);
  const bMachinesResponse = await get('/api/admin/machines', bToken);
  if (!bMachinesResponse.ok) throw new Error(`Company B machine list returned ${bMachinesResponse.status}`);
  const bMachines = await bMachinesResponse.json();
  if (JSON.stringify(bMachines).includes(machineId)) throw new Error('Company B machine list contains Company A machine');
  console.log(`E20-12 tenant-isolation=passed A_findings=${aFindings.length} B_findings=${bFindings.length} A_coverage=${aCoverage.length} B_coverage=${bCoverage.length} B_A_detail=404 B_A_machine=absent`);
}

main().catch(error => {
  console.error(`E20-12 failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
