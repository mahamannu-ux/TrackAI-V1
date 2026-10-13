/**
 * attesta:keys CLI (Task15l2): dry run by default with the exact scope, apply only
 * with --confirm=<COMMAND> --expect=<n> --actor, nothing secret printed, the
 * development signer refused in production, and the full rotation procedure driven
 * through the CLI (register → activate → publish → export-root-draft → offline sign
 * → import-root).
 */
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { main, type KeysCliIo } from './attesta-keys-cli';
import { main as rootMain, type CliIo } from './attesta-trust-root-cli';
import { LocalDevSigner } from './signer-local-dev';
import { keyidOf, parseTrustDocument } from './trust-documents';
import { memoryTrustStore, type TrustAdapters } from './trust-inventory';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const T0 = Date.parse('2026-10-13T10:00:00.000Z');

interface Key { pem: string; pubPem: string; priv: KeyObject; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = createPublicKey(privateKey);
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pubPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey, keyid: keyidOf(pub.export({ type: 'spki', format: 'der' }) as Buffer) };
}

function harness() {
  const k = { root: newKey(), anchor: newKey(), keyset: newKey(), a1: newKey(), a2: newKey() };
  const files = new Map<string, string>([['/k/root.pem', k.root.pem], ['/k/root.pub', k.root.pubPem]]);
  const out: string[] = [];
  const err: string[] = [];
  let now = T0;
  const store = memoryTrustStore();
  const adapters: TrustAdapters = { 'local-dev': new LocalDevSigner({ env: {}, credentials: [
    { credentialId: 'dev:anchor-cred', tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: k.anchor.pem },
    { credentialId: 'dev:keyset-cred', tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: k.keyset.pem },
    { credentialId: 'dev:a1-cred', tenantId: A, privateKeyPem: k.a1.pem },
    { credentialId: 'dev:a2-cred', tenantId: A, privateKeyPem: k.a2.pem },
  ] }) };
  const io: KeysCliIo = {
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFile: (p, t) => {
      if (files.has(p)) throw new Error('EEXIST');
      files.set(p, t);
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { ATTESTA_TRUST_ROOT_KEYIDS: k.root.keyid },
    now: () => new Date(now),
    store,
    adapters,
  };
  const rootIo: CliIo = { readFile: io.readFile, writeFile: io.writeFile, out: () => undefined, err: (l) => err.push(l), env: {}, now: io.now };
  const cli = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await main(argv, io);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  /** Dry run, read the --expect it prints, apply. */
  const apply = async (...argv: string[]) => {
    const dry = await cli(...argv);
    assert.equal(dry.code, 0, dry.err);
    const m = /--confirm=(\S+) --expect=(\d+)/.exec(dry.out);
    assert.ok(m, dry.out);
    const done = await cli(...argv, `--confirm=${m[1]}`, `--expect=${m[2]}`, '--actor', 'alice');
    assert.equal(done.code, 0, done.err);
    return done;
  };
  return { k, files, store, io, rootIo, cli, apply, advance: (d: number) => { now += d; } };
}

test('the full procedure through the CLI: dry runs change nothing; applied runs write events and audit rows', async () => {
  const h = harness();
  // register platform keys (dry run first: nothing stored, scope printed)
  const dry = await h.cli('register', '--adapter', 'local-dev', '--credential', 'dev:anchor-cred', '--purpose', 'anchor');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /^DRY RUN register \(nothing changed\)/);
  assert.match(dry.out, new RegExp(`register anchor key ${h.k.anchor.keyid} for platform`));
  assert.match(dry.out, /apply with: --confirm=REGISTER --expect=1 --actor <your name>/);
  assert.equal(h.store.state.keys.length, 0);
  await h.apply('register', '--adapter', 'local-dev', '--credential', 'dev:anchor-cred', '--purpose', 'anchor');
  await h.apply('register', '--adapter', 'local-dev', '--credential', 'dev:keyset-cred', '--purpose', 'tenant_keyset');
  // root v1: export the draft, sign offline, import
  const draft = await h.cli('export-root-draft', '--out', '/w/draft1.json', '--root-pub', '/k/root.pub');
  assert.equal(draft.code, 0, draft.err);
  assert.match(draft.out, /draft root version 1/);
  assert.equal(await rootMain(['sign', '--draft', '/w/draft1.json', '--key', '/k/root.pem', '--out', '/w/root1.json'], h.rootIo), 0);
  const imp = await h.apply('import-root', '--file', '/w/root1.json');
  assert.match(imp.out, /APPLIED import-root/);
  assert.match(imp.out, /anchor .*: registered -> active/);
  // tenant key: register, activate, publish
  await h.apply('register', '--adapter', 'local-dev', '--credential', 'dev:a1-cred', '--tenant', A);
  await h.apply('activate', '--tenant', A, '--keyid', h.k.a1.keyid);
  const pub = await h.apply('publish', '--tenant', A);
  assert.match(pub.out, /stored version 1/);
  // rotation: a2 replaces a1, then a1 is revoked superseded; publish v2
  h.advance(3_600_000);
  await h.apply('register', '--adapter', 'local-dev', '--credential', 'dev:a2-cred', '--tenant', A);
  const rot = await h.cli('activate', '--tenant', A, '--keyid', h.k.a2.keyid, '--replace');
  assert.match(rot.out, /--expect=2/);
  await h.apply('activate', '--tenant', A, '--keyid', h.k.a2.keyid, '--replace');
  await h.apply('revoke', '--tenant', A, '--keyid', h.k.a1.keyid, '--reason', 'superseded');
  await h.apply('publish', '--all-tenants');
  const v2 = parseTrustDocument((await h.store.documents(A))[1].envelope);
  assert.deepEqual([v2.keys.get(h.k.a1.keyid)?.entry.status, v2.keys.get(h.k.a2.keyid)?.entry.status], ['revoked', 'active']);
  // root v2 retires the anchor key (export with --previous-out, offline sign with --previous)
  const d2 = await h.cli('export-root-draft', '--out', '/w/draft2.json', '--previous-out', '/w/prev.json', '--retire', h.k.anchor.keyid);
  assert.equal(d2.code, 0, d2.err);
  assert.equal(await rootMain(['sign', '--draft', '/w/draft2.json', '--key', '/k/root.pem', '--previous', '/w/prev.json', '--out', '/w/root2.json'], h.rootIo), 0);
  await h.apply('import-root', '--file', '/w/root2.json');
  assert.equal(h.store.state.keys.find((k) => k.keyid === h.k.anchor.keyid)?.status, 'retired');
  // list prints keyids, purposes, statuses and validity only
  const list = await h.cli('list', '--tenant', A);
  assert.match(list.out, /statement +sha256:[0-9a-f]{64} revoked/);
  // audit: every tenant action once, actor recorded
  const audits = h.store.state.audits.map((a) => a.action).sort();
  assert.deepEqual(audits, ['attesta.keys.activate', 'attesta.keys.activate', 'attesta.keys.publish', 'attesta.keys.publish',
    'attesta.keys.register', 'attesta.keys.register', 'attesta.keys.revoke']);
  assert.ok(h.store.state.audits.every((a) => a.actorId === 'alice' && a.tenantId === A));
  assert.ok(h.store.state.events.every((e) => e.actor === 'alice'));
  // Nothing secret anywhere in the output or the drafts.
  const everything = [...h.files.entries()].filter(([p]) => p.startsWith('/w/')).map(([, v]) => v).join('\n');
  assert.ok(!/dev:|PRIVATE/.test(everything));
});

test('apply needs the exact --confirm, a matching --expect and an --actor; mismatches change nothing', async () => {
  const h = harness();
  const base = ['register', '--adapter', 'local-dev', '--credential', 'dev:a1-cred', '--tenant', A];
  const cases: Array<[string[], RegExp]> = [
    [['--confirm=REGISTER'], /needs --expect/],
    [['--confirm=register', '--expect=1', '--actor', 'a'], /exactly REGISTER/],
    [['--expect=1'], /--expect needs --confirm/],
    [['--confirm=REGISTER', '--expect=2', '--actor', 'a'], /--expect=2 but register changes 1/],
    [['--confirm=REGISTER', '--expect=1'], /--actor <your name> is required/],
    [['--confirm=REGISTER', '--expect=1', '--actor', 'bad actor!'], /--actor/],
  ];
  for (const [extra, re] of cases) {
    const r = await h.cli(...base, ...extra);
    assert.equal(r.code, 1);
    assert.match(r.err, re);
  }
  assert.equal(h.store.state.keys.length, 0);
  await h.apply(...base);
  const r = await h.cli('activate', '--tenant', A, '--keyid', h.k.a1.keyid, '--confirm=ACTIVATE', '--expect=2', '--actor', 'a');
  assert.match(r.err, /refused \[ATTESTA_TRUST_INPUT_INVALID\]: --expect=2 but this would change 1/);
  assert.equal(h.store.state.keys[0].status, 'registered');
  // Unknown options, commands and malformed values are refused before anything runs.
  assert.match((await h.cli('activate', '--tenant', A, '--keyid', 'abc')).err, /--keyid must be/);
  assert.match((await h.cli('retire', '--tenant', A, '--keyid', h.k.a1.keyid, '--replace')).err, /does not apply to retire/);
  assert.match((await h.cli('frobnicate')).err, /usage/);
  assert.match((await h.cli('revoke', '--tenant', A, '--keyid', h.k.a1.keyid, '--reason', 'compromised', '--compromised-since', 'yesterday')).err, /RFC 3339/);
  assert.match((await h.cli('publish')).err, /exactly one of --tenant/);
  assert.match((await h.cli('import-root', '--file', '/nope.json')).err, /not a readable JSON/);
  assert.match((await h.cli('export-root-draft', '--out', '/w/d.json')).err, /version 1 needs --root-pub/);
});

test('nothing secret is printed: credential references, PEM material and signer details stay out of every line', async () => {
  const h = harness();
  const lines: string[] = [];
  const collect = (r: { out: string; err: string }) => lines.push(r.out, r.err);
  collect(await h.cli('register', '--adapter', 'local-dev', '--credential', 'dev:a1-cred', '--tenant', A));
  collect(await h.apply('register', '--adapter', 'local-dev', '--credential', 'dev:a1-cred', '--tenant', A));
  // Signer errors quote the credential: the CLI prints the class only.
  collect(await h.cli('register', '--adapter', 'local-dev', '--credential', 'dev:missing-secret-name', '--tenant', A));
  collect(await h.cli('register', '--adapter', 'kms-aws', '--credential', 'aws-kms:secret-arn', '--tenant', A));
  collect(await h.cli('register', '--adapter', 'local-dev', '--credential', 'dev:a1-cred', '--tenant', A));
  collect(await h.cli('publish', '--tenant', A));
  collect(await h.cli('list'));
  const text = lines.join('\n');
  assert.ok(!/dev:|aws-kms:|secret|PRIVATE|BEGIN/.test(text), text);
  assert.match(text, /signer SigningRejected \(details withheld/);
  assert.match(text, /already registered/);
  assert.match(text, /no root document/);
});

test('production: a development signer is refused, and the pin is required for root import', async () => {
  const h = harness();
  h.io.env = { NODE_ENV: 'production', ATTESTA_TRUST_ROOT_KEYIDS: h.k.root.keyid };
  const r = await h.cli('list');
  assert.equal(r.code, 1);
  assert.match(r.err, /development signer is configured in production/);
  h.io.adapters = undefined; // built from the environment now
  h.io.env = { NODE_ENV: 'production', ATTESTA_DEV_CREDENTIALS_FILE: '/k/dev.json' };
  assert.match((await h.cli('list')).err, /ATTESTA_DEV_CREDENTIALS_FILE is set in production/);
  h.io.env = { NODE_ENV: 'production' };
  h.files.set('/w/root.json', JSON.stringify({ payload: 'e30=', payloadType: 'application/vnd.trackai.trust-root+json', signatures: [] }));
  assert.match((await h.cli('import-root', '--file', '/w/root.json')).err, /DOCUMENT_MALFORMED|ROOT_NOT_PINNED/);
  h.io.env = { ATTESTA_TRUST_ROOT_KEYIDS: 'nonsense' };
  assert.match((await h.cli('list')).err, /ATTESTA_TRUST_ROOT_KEYIDS must be/);
});

test('publish --all-tenants: one tenant failing does not stop the others, and the exit code says so', async () => {
  const h = harness();
  const dry = await h.cli('publish', '--all-tenants');
  assert.equal(dry.code, 0);
  assert.match(dry.out, /--expect=0/);
  // A tenant with a key ever active but no root: every tenant refused, exit 1.
  await h.apply('register', '--adapter', 'local-dev', '--credential', 'dev:a1-cred', '--tenant', A);
  await h.apply('activate', '--tenant', A, '--keyid', h.k.a1.keyid);
  const r = await h.cli('publish', '--all-tenants');
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`tenant ${A}: refused`));
  assert.match(r.out, /--expect=0/);
});
