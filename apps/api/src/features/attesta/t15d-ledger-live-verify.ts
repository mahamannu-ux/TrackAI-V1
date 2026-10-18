/**
 * IT-T15d-01…04: the Attesta ledger against real PostgreSQL.
 *
 *   scripts/it-db.sh npm run verify:task15d-ledger-live -w apps/api
 *   IT_T15D_WRITERS=50 IT_T15D_APPENDS=20 IT_T15D_VOLUME=10000 scripts/it-db.sh npm run verify:task15d-ledger-live -w apps/api
 *
 * 01 guards: every UPDATE / DELETE / TRUNCATE, out-of-order insert, wrong hash,
 *    inconsistent typed column, head not advanced and missing envelope is refused,
 *    as the API role and as an RLS-bound role; guard functions are SECURITY
 *    DEFINER with a fixed search_path; the record hash matches in SQL, in
 *    TypeScript and a fixed known answer.
 * 02 concurrency: parallel chainStatement calls (a quarter rolled back) give a
 *    gap-free chain with no duplicates (ported from SushiCorp IT-D1-03); claim-lost,
 *    previous-stale and duplicate paths.
 * 03 Company A/B: separate chains, no cross-tenant claim or repository, each clean.
 * 04 volume: a chain of IT_T15D_VOLUME records verifies clean, then one row changed
 *    behind the guards (superuser, triggers off) is found; time and memory printed.
 * Prints only safe summary lines.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { db, pool } from '../../core/db';
import { GENESIS_PREV_HASH, computeRecordHash, sha256Prefixed } from './canonical';
import {
  AI_PROVENANCE_PREDICATE_TYPE,
  AttestaLedgerError,
  buildCanonicalRecord,
  chainStatement,
  type AttestaStatementKind,
  type ChainStatementInput,
  type OutboxClaim,
} from './ledger';
import { chainInput, makeStatement, makeTestKey, shaOf, signStatement, type TestKey } from './testing/ledger-fixtures';
import { verifyChain } from './verify-chain';

const WRITERS = Number(process.env.IT_T15D_WRITERS ?? 8);
const APPENDS = Number(process.env.IT_T15D_APPENDS ?? 5);
const VOLUME = Number(process.env.IT_T15D_VOLUME ?? 500);
const KEY: TestKey = makeTestKey();
const KEYS = { [KEY.keyid]: KEY.publicKey };
const APP_ROLE = 'it_t15d_app';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15d failed: ${message}`);
}

let asOfCounter = 0;
const nextAsOf = () => new Date(Date.parse('2026-10-12T10:00:00.000Z') + asOfCounter++).toISOString();

interface Tenant {
  tenantId: string;
  repositoryId: string;
}

async function seedTenant(label: string): Promise<Tenant> {
  const slug = `it-t15d-${label}-${randomUUID().slice(0, 8)}`;
  const t = { tenantId: randomUUID(), repositoryId: randomUUID() };
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [t.tenantId, `IT ${label}`, `${slug}.example`, `it-${label}`],
  );
  await pool.query(
    `insert into scm_repositories (id, tenant_id, provider, external_id, name, url, normalized_url)
     values ($1, $2, 'github', $3, 'payments-service', $4, $5)`,
    [t.repositoryId, t.tenantId, String(100_000 + Math.floor(Math.random() * 1e6)),
      `https://github.com/${slug}/payments-service`, `github.com/${slug}/payments-service`],
  );
  return t;
}

/** A claimed outbox row, written directly (the worker's claim is A15.8). */
async function claimedSubject(t: Tenant, subjectSha: string, kind: AttestaStatementKind = 'commit_observed'): Promise<OutboxClaim> {
  check(kind === 'commit_observed', 'fixture writes commit_observed rows only');
  const result = await pool.query(
    `insert into attesta_subjects (tenant_id, repository_id, kind, metric_event_id, commit_id, commit_sha, event_at,
       status, claimed_at, attempts)
     values ($1, $2, 'commit_observed', $3, $4, $5, now(), 'claimed', now(), 1)
     returning id::text as id,
       to_char(claimed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claimed_at`,
    [t.tenantId, t.repositoryId, randomUUID(), randomUUID(), subjectSha],
  );
  return { subjectId: result.rows[0].id, claimedAt: result.rows[0].claimed_at, attempts: 1 };
}

function statementFor(t: Tenant, subjectSha: string, previous: string[] = []): string {
  return makeStatement({
    repositoryId: t.repositoryId, subjectSha, asOf: nextAsOf(),
    previous: previous.map((digest) => ({ digest, statement_kind: 'commit_observed' as const })),
  });
}

async function chainNew(t: Tenant, subjectSha: string, previous: string[] = []) {
  const claim = await claimedSubject(t, subjectSha);
  const input = chainInput(t.tenantId, statementFor(t, subjectSha, previous), KEY, { outboxClaim: claim });
  return db.transaction((tx) => chainStatement(tx, input));
}

async function expectLedgerCode(p: Promise<unknown>, code: string, label: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    check(err instanceof AttestaLedgerError && err.code === code, `${label}: expected ${code}, got ${(err as Error).message}`);
    return;
  }
  throw new Error(`IT-T15d failed: ${label}: expected ${code}, got success`);
}

async function count(sqlText: string, params: unknown[]): Promise<number> {
  return Number((await pool.query(sqlText, params)).rows[0].n);
}

// ---------------------------------------------------------------------------
// Raw writes for the guard attacks (a writer that bypasses chainStatement).
// ---------------------------------------------------------------------------

interface RawRecordOptions {
  seq?: (next: number) => number;
  prevHash?: (head: string) => string;
  recordHash?: (good: string) => string;
  statementDigest?: (good: string) => string;
  canonicalRecord?: (good: string) => string;
  recordedAt?: string;
  columnRecordedAt?: string;
  columnOutboxSubjectId?: string | null;
  columnSubjectSha?: string;
  /** outbox_subject_id in the bytes and the column alike. */
  outboxSubjectId?: string;
  envelope?: boolean;
  envelopePayloadOverride?: string;
  advance?: boolean;
}

async function rawAppend(client: PoolClient, t: Tenant, o: RawRecordOptions = {}): Promise<string> {
  const head = (await client.query(
    `select next_seq::text as next_seq, head_hash from chain_head where tenant_id = $1`, [t.tenantId])).rows[0];
  const next = Number(head.next_seq);
  const subjectSha = shaOf(`raw-${randomUUID()}`);
  const statement = statementFor(t, subjectSha);
  const goodDigest = sha256Prefixed(Buffer.from(statement, 'utf8'));
  const seq = o.seq ? o.seq(next) : next;
  const prevHash = o.prevHash ? o.prevHash(head.head_hash) : head.head_hash;
  const recordedAt = o.recordedAt ?? new Date(Date.parse('2030-01-01T00:00:00.000Z') + next).toISOString();
  const digest = o.statementDigest ? o.statementDigest(goodDigest) : goodDigest;
  const goodCanonical = buildCanonicalRecord({
    seq, prev_hash: prevHash, recorded_at: recordedAt, tenant_id: t.tenantId, record_kind: 'statement',
    statement_digest: digest, predicate_type: AI_PROVENANCE_PREDICATE_TYPE, statement_kind: 'commit_observed',
    repository_id: t.repositoryId, subject_sha: o.columnSubjectSha ?? subjectSha, outbox_subject_id: o.outboxSubjectId ?? null,
  });
  const canonical = o.canonicalRecord ? o.canonicalRecord(goodCanonical) : goodCanonical;
  const goodHash = computeRecordHash(canonical, prevHash);
  const recordHash = o.recordHash ? o.recordHash(goodHash) : goodHash;
  const inserted = await client.query(
    `insert into attesta_records (tenant_id, seq, prev_hash, recorded_at, record_kind, statement_digest, predicate_type,
       statement_kind, repository_id, subject_sha, statement_canonical, canonical_record, record_hash, outbox_subject_id)
     values ($1, $2, $3, $4::timestamptz, 'statement', $5, $6, 'commit_observed', $7, $8, $9, $10, $11, $12)
     returning id::text as id`,
    [t.tenantId, seq, prevHash, o.columnRecordedAt ?? recordedAt, digest, AI_PROVENANCE_PREDICATE_TYPE, t.repositoryId,
      o.columnSubjectSha ?? subjectSha, statement, canonical, recordHash, o.columnOutboxSubjectId ?? o.outboxSubjectId ?? null],
  );
  const recordId = inserted.rows[0].id as string;
  if (o.envelope !== false) {
    const signed = signStatement(o.envelopePayloadOverride ?? statement, KEY);
    await client.query(
      `insert into attesta_envelopes (tenant_id, record_id, payload_type, keyid, credential_id, signature_der, envelope)
       values ($1, $2, 'application/vnd.in-toto+json', $3, 'it', $4, $5::jsonb)`,
      [t.tenantId, recordId, KEY.keyid, signed.signatureDer, JSON.stringify(signed.envelope)],
    );
  }
  if (o.advance !== false) {
    await client.query(
      `update chain_head set next_seq = next_seq + 1, head_hash = $2, updated_at = now() where tenant_id = $1`,
      [t.tenantId, recordHash],
    );
  }
  return recordId;
}

/** Run `fn` in a savepoint (plus the commit-time guard); it must be refused with `code`. */
async function refused(client: PoolClient, label: string, code: string | RegExp, fn: () => Promise<unknown>): Promise<void> {
  await client.query('savepoint attack');
  let error: { code?: string } | null = null;
  try {
    await fn();
    await client.query('set constraints attesta_records_commit_guard immediate');
  } catch (err) {
    error = err as { code?: string };
  }
  await client.query('rollback to savepoint attack');
  await client.query('set constraints attesta_records_commit_guard deferred');
  check(error !== null, `${label}: the database accepted it`);
  const ok = typeof code === 'string' ? error.code === code : code.test(String(error.code));
  check(ok, `${label}: expected ${String(code)}, got ${String(error.code)}`);
}

async function guardAttacks(client: PoolClient, t: Tenant, other: Tenant, otherSubjectId: string, roleLabel: string): Promise<number> {
  let n = 0;
  const attack = async (label: string, code: string | RegExp, fn: () => Promise<unknown>) => {
    await refused(client, `${roleLabel} ${label}`, code, fn);
    n++;
  };
  const q = (text: string, params: unknown[] = []) => client.query(text, params);
  const T = t.tenantId;
  // Append-only tables and the head.
  await attack('update record', 'ATG01', () => q(`update attesta_records set statement_canonical = statement_canonical || ' ' where tenant_id = $1`, [T]));
  await attack('update seq', 'ATG01', () => q(`update attesta_records set seq = seq + 100 where tenant_id = $1`, [T]));
  await attack('delete record', 'ATG01', () => q(`delete from attesta_records where tenant_id = $1 and seq = 1`, [T]));
  await attack('truncate records', 'ATG01', () => q(`truncate attesta_records cascade`));
  await attack('update envelope', 'ATG01', () => q(`update attesta_envelopes set credential_id = 'x' where tenant_id = $1`, [T]));
  await attack('delete envelope', 'ATG01', () => q(`delete from attesta_envelopes where tenant_id = $1`, [T]));
  await attack('truncate envelopes', 'ATG01', () => q(`truncate attesta_envelopes`));
  await attack('delete head', 'ATG01', () => q(`delete from chain_head where tenant_id = $1`, [T]));
  await attack('truncate head', 'ATG01', () => q(`truncate chain_head`));
  await attack('head skips a seq', 'ATG01', () => q(`update chain_head set next_seq = next_seq + 2 where tenant_id = $1`, [T]));
  await attack('head to a foreign hash', 'ATG01', () => q(`update chain_head set next_seq = next_seq + 1, head_hash = $2 where tenant_id = $1`, [T, sha256Prefixed('x')]));
  await attack('head moves back', 'ATG01', () => q(`update chain_head set next_seq = next_seq - 1 where tenant_id = $1`, [T]));
  await attack('head touched in place', 'ATG01', () => q(`update chain_head set updated_at = now() where tenant_id = $1`, [T]));
  await attack('head changes tenant', 'ATG01', () => q(`update chain_head set tenant_id = $2 where tenant_id = $1`, [T, other.tenantId]));
  // Inserts that do not extend the chain correctly.
  await attack('insert past the head', 'ATH01', () => rawAppend(client, t, { seq: (s) => s + 1 }));
  await attack('insert over an old seq', 'ATH01', () => rawAppend(client, t, { seq: (s) => s - 1 }));
  await attack('insert with a stale prev_hash', 'ATH01', () => rawAppend(client, t, { prevHash: () => GENESIS_PREV_HASH }));
  await attack('insert with a wrong record_hash', 'ATG01', () => rawAppend(client, t, { recordHash: () => sha256Prefixed('forged') }));
  await attack('insert with a wrong statement_digest', 'ATG01', () => rawAppend(client, t, { statementDigest: () => sha256Prefixed('forged') }));
  await attack('canonical record with an extra field', 'ATG01', () => rawAppend(client, t, { canonicalRecord: (c) => c.replace('{', '{"anchor":1,') }));
  await attack('canonical record with whitespace', 'ATG01', () => rawAppend(client, t, { canonicalRecord: (c) => c.replace('{"outbox', '{ "outbox') }));
  await attack('canonical record with a duplicate key', 'ATG01', () => rawAppend(client, t, { canonicalRecord: (c) => c.replace('{', '{"seq":999999,') }));
  await attack('outbox subject of another tenant', 'ATG01', () => rawAppend(client, t, { outboxSubjectId: otherSubjectId }));
  await attack('typed copies left null', /^(23514|ATG01)$/, () => q(
    `insert into attesta_records (tenant_id, seq, prev_hash, recorded_at, record_kind, statement_digest, predicate_type,
       statement_kind, repository_id, subject_sha, statement_canonical, canonical_record, record_hash)
     select $1, h.next_seq, h.head_hash, now(), 'statement', $2, $3, null, $4, null, '{}', '{}', $2
     from chain_head h where h.tenant_id = $1`, [T, sha256Prefixed('x'), AI_PROVENANCE_PREDICATE_TYPE, t.repositoryId]));
  await attack('typed column disagrees with the record', 'ATG01', () => rawAppend(client, t, { columnOutboxSubjectId: randomUUID() }));
  await attack('typed copy disagrees with the statement', 'ATG01', () => rawAppend(client, t, { columnSubjectSha: shaOf('elsewhere') }));
  await attack('recorded_at goes backwards', 'ATG01', () => rawAppend(client, t, { recordedAt: '2001-01-01T00:00:00.000Z' }));
  await attack('recorded_at beyond milliseconds', 'ATG01', () => rawAppend(client, t, { columnRecordedAt: '2030-06-01T00:00:00.000123Z', recordedAt: '2030-06-01T00:00:00.000Z' }));
  await attack('head not advanced at commit', 'ATG01', () => rawAppend(client, t, { advance: false }));
  await attack('record without an envelope at commit', 'ATG01', () => rawAppend(client, t, { envelope: false }));
  await attack('envelope over other bytes', 'ATG01', () => rawAppend(client, t, { envelopePayloadOverride: statementFor(t, shaOf('other')) }));
  await attack('second envelope for a record', /^(23505|ATG01)$/, async () => {
    const recordId = (await q(`select id::text as id from attesta_records where tenant_id = $1 and seq = 0`, [T])).rows[0].id;
    const env = (await q(`select envelope, signature_der from attesta_envelopes where tenant_id = $1 and record_id = $2`, [T, recordId])).rows[0];
    await q(`insert into attesta_envelopes (tenant_id, record_id, payload_type, keyid, credential_id, signature_der, envelope)
             values ($1, $2, 'application/vnd.in-toto+json', $3, 'it', $4, $5::jsonb)`, [T, recordId, KEY.keyid, env.signature_der, env.envelope]);
  });
  await attack('signature column differs from the envelope', 'ATG01', async () => {
    const recordId = await rawAppend(client, t, { envelope: false, advance: false });
    const signed = signStatement((await q(`select statement_canonical from attesta_records where id = $1`, [recordId])).rows[0].statement_canonical, KEY);
    await q(`insert into attesta_envelopes (tenant_id, record_id, payload_type, keyid, credential_id, signature_der, envelope)
             values ($1, $2, 'application/vnd.in-toto+json', $3, 'it', $4, $5::jsonb)`,
      [T, recordId, KEY.keyid, Buffer.alloc(70, 1), JSON.stringify(signed.envelope)]);
  });
  return n;
}

async function it01(a: Tenant, b: Tenant): Promise<void> {
  // A short real chain to attack.
  for (let i = 0; i < 3; i++) await chainNew(a, shaOf(`it01-${i}`));
  await chainNew(b, shaOf('it01-b'));

  // Independent oracle: SQL hash = TypeScript hash = fixed known answer (Python hashlib).
  const kat = '{"outbox_subject_id":null,"predicate_type":"https://trackai.dev/attesta/ai-provenance/v1","prev_hash":"sha256:'
    + '0'.repeat(64) + '","record_kind":"statement","recorded_at":"2026-10-12T10:00:00.000Z","repository_id":"22222222-2222-4222-8222-222222222222","seq":0,"statement_digest":"sha256:'
    + 'ab'.repeat(32) + '","statement_kind":"commit_observed","subject_sha":"' + 'c'.repeat(40) + '","tenant_id":"11111111-1111-4111-8111-111111111111"}';
  const expected = 'sha256:6c0b4dcddbc87050fa95f285e6b5aba6e2f94fc4fee58df4651cd6bf7a5c5e09';
  const inSql = (await pool.query(
    `select 'sha256:' || encode(sha256(convert_to($1, 'UTF8') || convert_to($2, 'UTF8')), 'hex') as h`, [kat, GENESIS_PREV_HASH])).rows[0].h;
  check(inSql === expected && computeRecordHash(kat, GENESIS_PREV_HASH) === expected, 'record hash oracle');
  console.log('record_hash_oracle=sql_ts_kat_agree');

  // Guard functions: SECURITY DEFINER, fixed search_path, owned by the migration role.
  const fns = await pool.query(
    `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as config, pg_get_userbyid(p.proowner) as owner
     from pg_proc p where p.proname in ('attesta_ledger_reject_mutation', 'chain_head_guard',
       'attesta_records_chain_guard', 'attesta_records_commit_guard', 'attesta_envelopes_guard')`);
  const me = (await pool.query('select current_user as u')).rows[0].u;
  check(fns.rows.length === 5, 'all five guard functions exist');
  for (const f of fns.rows) {
    check(f.prosecdef === true && f.config === 'search_path=pg_catalog, pg_temp' && f.owner === me, `${f.proname} definer settings`);
  }
  const rls = await pool.query(
    `select c.relname, c.relrowsecurity as on, (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
     from pg_class c where c.relname in ('chain_head', 'attesta_records', 'attesta_envelopes')`);
  check(rls.rows.length === 3 && rls.rows.every((r) => r.on === true && r.policies === 0), 'RLS enabled without policies');
  console.log('guard_functions=security_definer_fixed_search_path');
  console.log('rls=enabled_no_policies');

  // As the API role (the DATABASE_URL role).
  const client = await pool.connect();
  try {
    await client.query('begin');
    const bSubject = (await claimedSubject(b, shaOf('b-subject'))).subjectId;
    const asApi = await guardAttacks(client, a, b, bSubject, 'api-role');
    await client.query('rollback');
    console.log(`guards_api_role=${asApi}_refused`);

    // As an RLS-bound role that sees only tenant A (a test policy, rolled back).
    await client.query('begin');
    await client.query(`create role ${APP_ROLE} nologin nosuperuser nobypassrls`);
    await client.query(`grant usage, create on schema public to ${APP_ROLE}`);
    // attesta_anchors (0018) references attesta_records, so TRUNCATE … CASCADE needs it too; with
    // the privilege the attack reaches the guards (Task15f2); attesta_period_reports (0022) too (Task15i4), and attesta_audit_seals (0023, Task16e).
    await client.query(`grant select, insert, update, delete, truncate on chain_head, attesta_records, attesta_envelopes, attesta_subjects, attesta_anchor_batches, attesta_anchors, attesta_period_reports, attesta_audit_seals, attesta_security_finding_seals, attesta_security_period_reports to ${APP_ROLE}`);
    for (const table of ['chain_head', 'attesta_records', 'attesta_envelopes', 'attesta_subjects']) {
      await client.query(`create policy it_t15d_tenant on ${table} for all to ${APP_ROLE}
        using (tenant_id = current_setting('it_t15d.tenant')::uuid) with check (tenant_id = current_setting('it_t15d.tenant')::uuid)`);
    }
    const claim = await (async () => {
      const r = await client.query(
        `insert into attesta_subjects (tenant_id, repository_id, kind, metric_event_id, commit_id, commit_sha, event_at, status, claimed_at, attempts)
         values ($1, $2, 'commit_observed', $3, $4, $5, now(), 'claimed', now(), 1)
         returning id::text as id, to_char(claimed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claimed_at`,
        [a.tenantId, a.repositoryId, randomUUID(), randomUUID(), shaOf('rls-ok')]);
      return { subjectId: r.rows[0].id as string, claimedAt: r.rows[0].claimed_at as string, attempts: 1 };
    })();
    await client.query(`select set_config('it_t15d.tenant', $1, true)`, [a.tenantId]);
    await client.query(`set local role ${APP_ROLE}`);
    // search_path hijack: shadow the polymorphic built-ins the guards call with
    // exact-type functions in public. With search_path = pg_catalog, pg_temp the
    // definer guards never resolve them, so the append below must not raise.
    for (const type of ['bigint', 'text']) {
      await client.query(`create function public.to_jsonb(${type}) returns jsonb language plpgsql as $f$
        begin raise exception 'search_path hijack ran as %', current_user; end $f$`);
    }
    const visibleB = Number((await client.query(`select count(*)::int as n from attesta_records where tenant_id = $1`, [b.tenantId])).rows[0].n);
    check(visibleB === 0, 'the RLS role sees no tenant B record');
    // A legitimate append still works: the definer guards read the head under RLS.
    const ok = await chainStatement(drizzle(client), chainInput(a.tenantId, statementFor(a, shaOf('rls-ok')), KEY, { outboxClaim: claim }));
    check(ok.seq === 3 && !ok.duplicate, 'chainStatement as the RLS-bound role');
    const asRls = await guardAttacks(client, a, b, bSubject, 'rls-role');
    await client.query('rollback');
    console.log(`guards_rls_role=${asRls}_refused`);
    console.log('rls_role_append=passed');
    console.log('search_path_hijack=not_resolved');
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }

  const report = await verifyChain(db, a.tenantId, { keys: KEYS });
  check(report.ok && report.checked === 3, 'tenant A chain intact after the attacks');
  console.log('IT-T15d-01=passed');
}

async function it02(): Promise<void> {
  const t = await seedTenant('concurrency');
  let committed = 0;
  let rolledBack = 0;
  const errors: string[] = [];
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  await Promise.all(Array.from({ length: WRITERS }, (_, w) => (async () => {
    for (let i = 0; i < APPENDS; i++) {
      const subjectSha = shaOf(`w${w}-${i}`);
      const claim = await claimedSubject(t, subjectSha);
      const input = chainInput(t.tenantId, statementFor(t, subjectSha), KEY, { outboxClaim: claim });
      const rollback = random() < 0.25;
      try {
        await db.transaction(async (tx) => {
          await chainStatement(tx, input);
          if (rollback) tx.rollback();
        });
        committed++;
      } catch (err) {
        if (rollback && !(err instanceof AttestaLedgerError)) rolledBack++;
        else errors.push(err instanceof AttestaLedgerError ? err.code : 'unexpected');
      }
    }
  })()));
  check(errors.length === 0, `concurrent writers raised ${errors.join(',')}`);
  const rows = await pool.query(`select r.seq::text as seq, r.statement_digest from attesta_records r where r.tenant_id = $1 order by r.seq`, [t.tenantId]);
  const head = (await pool.query(`select next_seq::text as next_seq from chain_head where tenant_id = $1`, [t.tenantId])).rows[0];
  check(rows.rows.length === committed, 'one record per committed append');
  check(rows.rows.every((r, i) => Number(r.seq) === i), `seq is gap-free: ${rows.rows.map((r) => r.seq).join(',')} committed=${committed}`);
  check(new Set(rows.rows.map((r) => r.statement_digest)).size === committed, 'no duplicate statements');
  check(Number(head.next_seq) === committed, 'head equals the record count');
  check(await count(`select count(*)::int as n from attesta_subjects where tenant_id = $1 and status = 'done'`, [t.tenantId]) === committed,
    'exactly the committed outbox rows are done');
  const report = await verifyChain(db, t.tenantId, { keys: KEYS });
  check(report.ok && report.checked === committed, `concurrent chain verifies clean: ${JSON.stringify(report.breaks.slice(0, 3))}`);
  console.log(`concurrency_writers=${WRITERS} appends=${WRITERS * APPENDS} committed=${committed} rolled_back=${rolledBack} gap_free=yes`);

  // Claim lost: the row was re-claimed (attempts moved on); nothing is chained.
  const sha = shaOf('claim-lost');
  const claim = await claimedSubject(t, sha);
  const before = committed;
  await expectLedgerCode(db.transaction((tx) => chainStatement(tx, chainInput(t.tenantId, statementFor(t, sha), KEY,
    { outboxClaim: { ...claim, attempts: 2 } }))), 'ATTESTA_LEDGER_CLAIM_LOST', 'stale attempt');
  await expectLedgerCode(db.transaction((tx) => chainStatement(tx, chainInput(t.tenantId, statementFor(t, sha), KEY,
    { outboxClaim: { ...claim, claimedAt: '2001-01-01T00:00:00.000000Z' } }))), 'ATTESTA_LEDGER_CLAIM_LOST', 'stale claimed_at');
  check(await count(`select count(*)::int as n from attesta_records where tenant_id = $1`, [t.tenantId]) === before, 'claim lost chains nothing');
  console.log('claim_lost=blocked');

  // Previous stale: a statement about the subject was chained after the build read previous.
  const subject = shaOf('previous');
  const first = await chainNew(t, subject);
  await expectLedgerCode(chainNew(t, subject, []), 'ATTESTA_LEDGER_PREVIOUS_STALE', 'stale previous');
  const second = await chainNew(t, subject, [first.statementDigest]);
  check(second.seq === first.seq + 1, 'rebuilt statement links to the first');
  console.log('previous_stale=retry_then_linked');

  // Duplicate: the same statement bytes from another claimed row are not chained twice.
  const dupStatement = statementFor(t, shaOf('dup'));
  const c1 = await claimedSubject(t, shaOf('dup'));
  const c2 = await claimedSubject(t, shaOf('dup'));
  const r1 = await db.transaction((tx) => chainStatement(tx, chainInput(t.tenantId, dupStatement, KEY, { outboxClaim: c1 })));
  const r2 = await db.transaction((tx) => chainStatement(tx, chainInput(t.tenantId, dupStatement, KEY, { outboxClaim: c2 })));
  check(!r1.duplicate && r2.duplicate && r1.recordId === r2.recordId, 'duplicate returns the existing record');
  check(await count(`select count(*)::int as n from attesta_subjects where id = $1 and status = 'done'`, [c2.subjectId]) === 1, 'duplicate still marks the row done');
  console.log('duplicate_statement=deduplicated');

  // A caller that set its constraints IMMEDIATE, and one chaining two statements in one transaction.
  const imm = await claimedSubject(t, shaOf('immediate'));
  await db.transaction(async (tx) => {
    await tx.execute(sql`set constraints all immediate`);
    await chainStatement(tx, chainInput(t.tenantId, statementFor(t, shaOf('immediate')), KEY, { outboxClaim: imm }));
    await chainStatement(tx, chainInput(t.tenantId, statementFor(t, shaOf('immediate-2')), KEY));
  });
  console.log('caller_immediate_and_multi_statement=passed');

  // A rolled-back transaction leaves no gap: the next append takes the same seq.
  const nextBefore = Number((await pool.query(`select next_seq::text as n from chain_head where tenant_id = $1`, [t.tenantId])).rows[0].n);
  let seenSeq = -1;
  await db.transaction(async (tx) => {
    const claim2 = await claimedSubject(t, shaOf('rolled'));
    seenSeq = (await chainStatement(tx, chainInput(t.tenantId, statementFor(t, shaOf('rolled')), KEY, { outboxClaim: claim2 }))).seq;
    tx.rollback();
  }).catch(() => undefined);
  const after = await chainNew(t, shaOf('after-rollback'));
  check(seenSeq === nextBefore && after.seq === nextBefore, 'rollback leaves no gap');
  const final = await verifyChain(db, t.tenantId, { keys: KEYS });
  check(final.ok, 'chain clean after the edge paths');
  console.log('rollback=no_gap');
  console.log('IT-T15d-02=passed');
}

async function it03(a: Tenant, b: Tenant): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await chainNew(a, shaOf(`a-${i}`));
    await chainNew(b, shaOf(`b-${i}`));
  }
  const nA = await count(`select count(*)::int as n from attesta_records where tenant_id = $1`, [a.tenantId]);
  const nB = await count(`select count(*)::int as n from attesta_records where tenant_id = $1`, [b.tenantId]);
  const ra = await verifyChain(db, a.tenantId, { keys: KEYS });
  const rb = await verifyChain(db, b.tenantId, { keys: KEYS });
  check(ra.ok && ra.checked === nA && ra.head?.next_seq === nA, 'Company A chain clean and complete');
  check(rb.ok && rb.checked === nB && rb.head?.next_seq === nB, 'Company B chain clean and complete');
  const zeroA = (await pool.query(`select record_hash from attesta_records where tenant_id = $1 and seq = 0`, [a.tenantId])).rows[0].record_hash;
  const zeroB = (await pool.query(`select record_hash from attesta_records where tenant_id = $1 and seq = 0`, [b.tenantId])).rows[0].record_hash;
  check(zeroA !== zeroB, 'separate chains');

  // B cannot finish A's outbox row, nor chain a statement about A's repository.
  const aClaim = await claimedSubject(a, shaOf('a-claim'));
  const bStatementOnA = statementFor({ tenantId: b.tenantId, repositoryId: a.repositoryId }, shaOf('a-claim'));
  await expectLedgerCode(db.transaction((tx) => chainStatement(tx, chainInput(b.tenantId, statementFor(b, shaOf('a-claim')), KEY,
    { outboxClaim: aClaim }))), 'ATTESTA_LEDGER_CLAIM_LOST', 'B uses A claim');
  await expectLedgerCode(db.transaction((tx) => chainStatement(tx, chainInput(b.tenantId, bStatementOnA, KEY))),
    'ATTESTA_LEDGER_GUARD_VIOLATION', 'B statement about A repository');
  // An A statement cannot be duplicated into B by digest lookup: B chains its own copy.
  const shared = statementFor(a, shaOf('shared'));
  const inA = await db.transaction((tx) => chainStatement(tx, chainInput(a.tenantId, shared, KEY)));
  check(!inA.duplicate, 'A chains the statement');
  check(await count(`select count(*)::int as n from attesta_subjects where id = $1 and status = 'claimed'`, [aClaim.subjectId]) === 1, 'A row untouched by B');
  check(await count(`select count(*)::int as n from attesta_records where tenant_id = $1`, [b.tenantId]) === nB, 'B chain unchanged by refused writes');
  console.log(`tenant_a_records=${nA + 1} tenant_b_records=${nB}`);
  console.log('cross_tenant=blocked');
  console.log('IT-T15d-03=passed');
}

async function it04(): Promise<void> {
  const t = await seedTenant('volume');
  const batch = 200;
  const startChain = performance.now();
  for (let done = 0; done < VOLUME; done += batch) {
    const inputs: ChainStatementInput[] = [];
    for (let i = done; i < Math.min(VOLUME, done + batch); i++) {
      inputs.push(chainInput(t.tenantId, statementFor(t, shaOf(`v-${i}`)), KEY));
    }
    await db.transaction(async (tx) => {
      for (const input of inputs) await chainStatement(tx, input);
    });
  }
  const chainMs = performance.now() - startChain;

  let peak = process.memoryUsage().heapUsed;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 20);
  const baseline = process.memoryUsage().heapUsed;
  const startVerify = performance.now();
  const clean = await verifyChain(db, t.tenantId, { keys: KEYS });
  const verifyMs = performance.now() - startVerify;
  clearInterval(sampler);
  check(clean.ok && clean.checked === VOLUME, `volume chain verifies clean: ${JSON.stringify(clean.breaks.slice(0, 3))}`);

  // Tamper behind the guards (superuser, triggers off): one record's bytes changed.
  const target = Math.floor(VOLUME / 2);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    await client.query(
      `update attesta_records set canonical_record = replace(canonical_record, '"record_kind":"statement"', '"record_kind":"statemenT"')
       where tenant_id = $1 and seq = $2`, [t.tenantId, target]);
    await client.query('commit');
  } finally {
    client.release();
  }
  const tampered = await verifyChain(db, t.tenantId, { keys: KEYS });
  check(!tampered.ok && tampered.breaks.some((b) => b.seq === target && b.kind === 'hash_mismatch'), 'tampered row found');
  check(tampered.breaks.every((b) => b.seq === target), 'only the tampered row is blamed');
  console.log(`volume_records=${VOLUME} chain_ms=${chainMs.toFixed(0)} verify_ms=${verifyMs.toFixed(0)} verify_heap_growth_mb=${((peak - baseline) / 1048576).toFixed(1)}`);
  console.log(`volume_tamper=found_at_seq_${target}`);
  console.log('IT-T15d-04=passed');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('IT-T15d requires a local disposable database');
  try {
    const a = await seedTenant('a');
    const b = await seedTenant('b');
    await it01(a, b);
    await it02();
    await it03(a, b);
    await it04();
    console.log('IT-T15d=passed');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15d failed');
  process.exitCode = 1;
});

