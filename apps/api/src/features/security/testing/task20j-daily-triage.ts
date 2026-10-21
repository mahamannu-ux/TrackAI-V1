/** Safe daily E20-W counts from the same API the Security console reads. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type User = { email: string; subject: string; password: string };
type Finding = { id: string; generation: string; rule_id: string; agent: string | null };
type Page = { items: Finding[]; next_cursor: string | null };
type CoverageRow = {
  machine_id: string;
  status: 'unreported' | {
    observed_at: string;
    hook_status: string;
    agent_effective_view: string;
    local_record: string;
    forwarder_ack: string;
    lease_id: string | null;
  };
  lease: 'no_lease' | { expires_at: string; mode: string };
  acknowledgement: 'not_acknowledged' | { received_at: string; result: string };
};
type CoveragePage = { rows: CoverageRow[]; next_cursor: string | null };

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
  const { machineId } = JSON.parse(readFileSync(join(directory, 'aliases.json'), 'utf8')) as { machineId: string };
  if (!machineId) throw new Error('Company A machine alias is missing');
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

  let coverageCursor: string | null = null;
  let machine: CoverageRow | undefined;
  do {
    const query = new URLSearchParams();
    if (coverageCursor) query.set('cursor', coverageCursor);
    const response = await fetch(`http://127.0.0.1:8080/api/admin/security/v2/coverage?${query}`, {
      headers: { Authorization: `Bearer ${auth.access_token}` },
    });
    if (!response.ok) throw new Error(`Security coverage API returned ${response.status}`);
    const page = await response.json() as CoveragePage;
    if (!Array.isArray(page.rows) || !('next_cursor' in page)) throw new Error('unexpected Security coverage page');
    machine ??= page.rows.find(row => row.machine_id === machineId);
    coverageCursor = page.next_cursor;
  } while (coverageCursor);
  if (!machine) throw new Error('Company A machine is absent from Security coverage');
  const status = machine.status === 'unreported' ? null : machine.status;
  const lease = machine.lease === 'no_lease' ? null : machine.lease;
  const acknowledgement = machine.acknowledgement === 'not_acknowledged' ? null : machine.acknowledgement;
  console.log(`coverage_machine=A status_at=${status?.observed_at ?? 'unreported'} lease_id=${status?.lease_id ?? 'none'} lease_mode=${lease?.mode ?? 'none'} lease_expires_at=${lease?.expires_at ?? 'none'} acknowledgement_at=${acknowledgement?.received_at ?? 'none'} acknowledgement_result=${acknowledgement?.result ?? 'none'}`);
  console.log(`health hook_status=${status?.hook_status ?? 'unreported'} agent_effective_view=${status?.agent_effective_view ?? 'unreported'} local_record=${status?.local_record ?? 'unreported'} forwarder_ack=${status?.forwarder_ack ?? 'unreported'}`);
}

main().catch(error => {
  console.error(`task20j_triage_failed=${(error as Error).message}`);
  process.exitCode = 1;
});
