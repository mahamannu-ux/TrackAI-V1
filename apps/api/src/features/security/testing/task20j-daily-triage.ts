/** Safe daily E20-W counts from the same API the Security console reads. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type User = { email: string; subject: string; password: string };
type Finding = { id: string; generation: string; rule_id: string; agent: string | null };
type Page = { items: Finding[]; next_cursor: string | null };

async function main(): Promise<void> {
  const directory = process.argv[2] ? resolve(process.argv[2]) : '';
  const date = process.argv[3] ?? '';
  if (!directory || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('usage: task20j-daily-triage.ts <private-directory> YYYY-MM-DD');
  }
  const users = (JSON.parse(readFileSync(join(directory, 'private/auth.json'), 'utf8')) as { users: User[] }).users;
  const admin = users.find(user => user.email === 'admin@task20j-a.acceptance.invalid');
  if (!admin) throw new Error('Company A administrator is missing');
  const authResponse = await fetch('http://127.0.0.1:54321/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: admin.email, password: admin.password }),
  });
  if (!authResponse.ok) throw new Error(`local auth returned ${authResponse.status}`);
  const auth = await authResponse.json() as { access_token?: string };
  if (!auth.access_token) throw new Error('local auth returned no access token');

  const from = `${date}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ from, to, generation: 'v2', limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`http://127.0.0.1:8080/api/admin/security/v2/findings?${query}`, {
      headers: { Authorization: `Bearer ${auth.access_token}` },
    });
    if (!response.ok) throw new Error(`Security console API returned ${response.status}`);
    const page = await response.json() as Page;
    if (!Array.isArray(page.items) || !('next_cursor' in page)) throw new Error('unexpected Security page');
    for (const item of page.items) {
      if (item.generation !== 'v2' || typeof item.id !== 'string' || seen.has(item.id)) continue;
      seen.add(item.id);
      const key = `${item.rule_id}\t${item.agent ?? 'unknown'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    cursor = page.next_cursor;
  } while (cursor);
  console.log(`date=${date} tenant=A source=security-console-api findings=${seen.size}`);
  console.log('rule_id\tagent\tcount');
  for (const [key, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${key}\t${count}`);
  }
}

main().catch(error => {
  console.error(`task20j_triage_failed=${(error as Error).message}`);
  process.exitCode = 1;
});
