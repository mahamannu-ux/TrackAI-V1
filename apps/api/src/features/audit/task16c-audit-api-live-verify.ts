/**
 * IT-T16c-01: the audit read API against real PostgreSQL, through the real JWT
 * and tenant middleware (a local JWKS stands in for Supabase), the real
 * requireAdminAction guard and the real createApp() mount.
 *
 *   scripts/it-db.sh npm run verify:task16c-audit-live -w apps/api
 *
 * (a) A migrated mutation (registerDeveloperMachine) writes its row through
 *     recordAuditEvent(), and GET /api/audit/events?action=machine.registered
 *     returns it, valid against docs/contracts/audit/event-v1.schema.json.
 * (b) 120 events written with recordAuditEvent() in one transaction (one shared
 *     occurred_at) page out at limit=50 with each id exactly once.
 * (c) Company B sees none of Company A's rows, by list or by id.
 * (d) Each read wrote exactly one audit.events.read row, carrying the auditor's
 *     role when the auditor reads.
 * (e) A raw reveal by an auditor records actor_type = 'tenant_auditor'.
 *
 * Throwaway database only (TASK6_EPHEMERAL_DATABASE=1, set by scripts/it-db.sh).
 * Prints only safe summary lines (counts and codes), never a details value.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db, pool } from '../../core/db';
import { encryptEnvelope } from '../../core/security/envelope-encryption';
import { registerDeveloperMachine } from '../../core/security/machine-security-service';
import { recordAuditEvent } from '../../core/audit/record';
import { aiSessions, evidenceEventContents, evidenceEvents } from '../../core/db/schema';
import { readRawEvidence } from '../evidence/service';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T16c-01 failed: ${message}`);
}

interface Tenant {
  label: string;
  tenantId: string;
  domain: string;
}

async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t16c-${label}-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example`;
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, domain, slug]);
  return { label, tenantId, domain };
}

async function grant(t: Tenant, subject: string, role: 'tenant_admin' | 'tenant_auditor'): Promise<void> {
  await pool.query(
    `insert into tenant_admin_memberships (tenant_id, subject, email, role, status, granted_by, revoked_at)
     values ($1, $2, $3, $4, 'active', 'it-t16c', null)`,
    [t.tenantId, subject, `${subject}@${t.domain}`, role]);
}

// ---------------------------------------------------------------------------
// JWKS and tokens (as IT-T15i)

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t16c';
async function startJwks(): Promise<Server> {
  const jwk = { ...JWT_KEY.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return server;
}
const token = (t: Tenant, subject: string) =>
  jwt.sign({ sub: subject, email: `${subject}@${t.domain}` }, JWT_KEY.privateKey, { algorithm: 'RS256', keyid: KID, expiresIn: 600 });

interface Res { status: number; headers: Headers; body: any }
function client(base: string) {
  const call = async (method: string, path: string, bearer?: string, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(base + path, {
      method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    check(!bearer || res.headers.get('cache-control') === 'no-store', `${method} ${path}: no-store (${res.status})`);
    return { status: res.status, headers: res.headers, body: parsed };
  };
  return {
    get: (path: string, bearer?: string, headers?: Record<string, string>) => call('GET', path, bearer, headers),
  };
}
type Api = ReturnType<typeof client>;

const isProblem = (r: Res, status: number, code: string) =>
  r.status === status && r.headers.get('content-type')?.startsWith('application/problem+json') && r.body?.code === code;

async function readRows(tenantId: string, action: string): Promise<Array<Record<string, any>>> {
  const r = await pool.query(
    `select id::text as id, actor_type, actor_id, action, target_type, target_id, details from security_audit_events
     where tenant_id = $1 and action = $2 order by occurred_at, id`, [tenantId, action]);
  return r.rows;
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const jwks = await startJwks();
  process.env.SUPABASE_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  const servers: Server[] = [jwks];
  try {
    // The JWT middleware reads SUPABASE_URL when it is first imported.
    const { createApp } = await import('../../app');
    const app = await listen(createApp());
    servers.push(app.server);
    const api: Api = client(app.base);

    const a = await seedTenant('a');
    const b = await seedTenant('b');
    await grant(a, 'admin-a', 'tenant_admin');
    await grant(a, 'auditor-a', 'tenant_auditor');
    await grant(b, 'auditor-b', 'tenant_auditor');
    const adminA = token(a, 'admin-a');
    const auditorA = token(a, 'auditor-a');
    const auditorB = token(b, 'auditor-b');

    // (a) a migrated mutation writes through recordAuditEvent(); the list returns
    // it, valid against event-v1.
    const machine = await registerDeveloperMachine({
      tenantId: a.tenantId, installationId: `it-t16c-${randomUUID()}`, displayName: 'IT-T16c laptop', actorId: 'admin-a',
    });
    const listed = await api.get(`/api/audit/events?action=machine.registered`, adminA);
    check(listed.status === 200, `(a) list answers 200 (got ${listed.status})`);
    const events = listed.body.events as Array<Record<string, any>>;
    check(events.length === 1 && events[0].target_id === machine.id, '(a) the migrated mutation row is listed');
    const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../../../docs/contracts/audit/event-v1.schema.json'), 'utf8'));
    const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
    check(validate(events[0]), `(a) the listed event matches event-v1`);
    check(events[0].severity === 'notice' && events[0].catalog_version === 1, '(a) derived severity and catalog_version');
    console.log('IT-T16c-01a ok: migrated mutation row listed, valid against event-v1');

    // (b) 120 rows in one transaction share one occurred_at; limit=50 pages each id once.
    await db.transaction(async (tx) => {
      for (let i = 0; i < 120; i++) {
        await recordAuditEvent(tx, a.tenantId, {
          action: 'machine.registered', actorType: 'tenant_admin', actorId: 'admin-a',
          targetType: 'developer_machine', targetId: randomUUID(),
          details: { installationId: `it-t16c-b-${i}`, displayName: 'IT-T16c paging' },
        });
      }
    });
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const path = cursor === null
        ? '/api/audit/events?action=machine.registered&limit=50'
        : `/api/audit/events?action=machine.registered&limit=50&cursor=${cursor}`;
      const page = await api.get(path, adminA);
      check(page.status === 200, `(b) page answers 200 (got ${page.status})`);
      for (const event of page.body.events as Array<{ id: string }>) {
        check(!seen.has(event.id), '(b) no id repeats across pages');
        seen.add(event.id);
      }
      pages += 1;
      cursor = page.body.next_cursor as string | null;
      if (cursor === null) break;
      check(pages < 10, '(b) paging terminates');
    }
    check(seen.size === 121 && pages === 3, `(b) 121 rows page out as 50/50/21 (got ${seen.size} in ${pages})`);
    const shared = await pool.query(
      `select count(distinct occurred_at)::int as n from security_audit_events
       where tenant_id = $1 and action = 'machine.registered' and details->>'displayName' = 'IT-T16c paging'`, [a.tenantId]);
    check(shared.rows[0].n === 1, '(b) one transaction shares one occurred_at');
    console.log('IT-T16c-01b ok: 120 same-instant rows page out with each id exactly once');

    // (c) Company B sees none of Company A's rows, by list or by id.
    const bList = await api.get('/api/audit/events?action=machine.registered', auditorB);
    check(bList.status === 200 && (bList.body.events as unknown[]).length === 0, "(c) B's list is empty");
    const aRowId = (await readRows(a.tenantId, 'machine.registered'))[0].id as string;
    const cross = await api.get(`/api/audit/events/${aRowId}`, auditorB);
    check(isProblem(cross, 404, 'AUDIT_EVENT_NOT_FOUND'), "(c) A's id is 404 for B");
    const unknown = await api.get(`/api/audit/events/${randomUUID()}`, auditorB);
    check(isProblem(unknown, 404, 'AUDIT_EVENT_NOT_FOUND'), '(c) an unknown id is 404');
    console.log("IT-T16c-01c ok: Company B sees none of Company A's rows");

    // (d) each read wrote exactly one audit.events.read row, with the auditor's role.
    const before = (await readRows(a.tenantId, 'audit.events.read')).length;
    const auditorList = await api.get('/api/audit/events?severity=notice', auditorA);
    check(auditorList.status === 200, '(d) auditor lists');
    const adminGet = await api.get(`/api/audit/events/${aRowId}`, adminA);
    check(adminGet.status === 200, '(d) admin reads one');
    const catalog = await api.get('/api/audit/catalog', auditorA);
    check(catalog.status === 200, '(d) catalog answers');
    const after = await readRows(a.tenantId, 'audit.events.read');
    check(after.length === before + 2, `(d) two reads wrote two audit rows (before ${before}, after ${after.length})`);
    const fresh = after.slice(-2);
    const auditorRow = fresh.find(row => row.actor_id === 'auditor-a');
    check(auditorRow?.actor_type === 'tenant_auditor', "(d) the auditor's read carries the auditor role");
    check(Array.isArray(auditorRow?.details.filters)
      && (auditorRow.details.filters as string[]).every(name => typeof name === 'string'), '(d) filters are names only');
    check(fresh.every(row => row.target_type === 'security_audit_events' && row.target_id === a.tenantId), '(d) reads target the tenant trail');
    console.log('IT-T16c-01d ok: each read audited once, with the auditor role');

    // (e) a raw reveal by an auditor records actor_type = 'tenant_auditor'.
    const [session] = await db.insert(aiSessions).values({
      tenantId: a.tenantId, externalSessionId: `it-t16c-${randomUUID()}`, tool: 'opencode',
    }).returning({ id: aiSessions.id });
    const [event] = await db.insert(evidenceEvents).values({
      tenantId: a.tenantId, sessionId: session.id, provider: 'opencode', providerEventId: `it-t16c-${randomUUID()}`,
      eventType: 'prompt', sourceVersion: '1', occurredAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: evidenceEvents.id });
    await db.insert(evidenceEventContents).values({
      tenantId: a.tenantId, eventId: event.id,
      encryptedValue: encryptEnvelope(JSON.stringify({ text: 'IT-T16cян' }), {
        tenantId: a.tenantId, purpose: 'evidence-event', resourceId: event.id,
      }) as unknown as Record<string, unknown>,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const reveal = await readRawEvidence({
      tenantId: a.tenantId, eventId: event.id, actorId: 'auditor-a', actorRole: 'tenant_auditor',
    });
    check(reveal !== null && reveal.availability !== 'expired', '(e) the auditor reveals the event');
    const rawRows = await readRows(a.tenantId, 'evidence.raw.read');
    check(rawRows.length === 1 && rawRows[0].actor_type === 'tenant_auditor' && rawRows[0].actor_id === 'auditor-a',
      "(e) the raw reveal carries actor_type = 'tenant_auditor'");
    console.log("IT-T16c-01e ok: auditor raw reveal records actor_type = 'tenant_auditor'");
    console.log('IT-T16c-01 passed');
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    await pool.end();
  }
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T16c-01 failed');
  process.exitCode = 1;
});
