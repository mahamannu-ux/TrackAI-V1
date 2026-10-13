/**
 * Offline root tool (Task15l): draft → sign → the verifier accepts it; rotation
 * needs the previous root's keys; nothing it prints is key material; it refuses a
 * machine with a database configured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { sha256Prefixed } from './canonical';
import { pae, type DsseEnvelope } from './dsse';
import { main, type CliIo } from './attesta-trust-root-cli';
import { verifyTrusted } from './trust-contract';

function pemPair(curve = 'P-256'): { priv: string; pub: string; key: KeyObject; keyid: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    key: privateKey,
    keyid: sha256Prefixed(spki),
  };
}

function memIo(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines, errors, env,
    readFile: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
    writeFile: (p, t) => {
      files[p] = t;
    },
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    now: () => new Date('2026-10-13T10:00:00.000Z'),
  };
}

const root1 = pemPair();
const root2 = pemPair();
const release = pemPair();
const keyset = pemPair();

function releaseCheck(rootDocs: DsseEnvelope[], pins: string[]) {
  const payload = Buffer.from('{"artifact":"r"}', 'utf8');
  const pt = 'application/vnd.trackai.test+json';
  const sig = cryptoSign('sha256', pae(pt, payload), { key: release.key, dsaEncoding: 'der' }).toString('base64');
  return verifyTrusted({
    payloadType: pt, payload, envelope: { payload: payload.toString('base64'), payloadType: pt, signatures: [{ keyid: release.keyid, sig }] },
    purpose: 'release', audience: 'platform', signedAt: '2026-10-14T00:00:00.000Z',
    state: { pinnedRootKeyids: pins, rootDocuments: rootDocs, keysetDocuments: {}, lastTrusted: {}, now: '2026-10-14T00:00:00.000Z', production: true },
  });
}

test('T15l root tool: keyid, draft and sign produce a root the verifier accepts', async () => {
  const files: Record<string, string> = { 'r1.pem': root1.priv, 'r1.pub': root1.pub, 'rel.pub': release.pub, 'ks.pem': keyset.priv };
  const io = memIo(files);
  assert.equal(await main(['keyid', '--key', 'r1.pem'], io), 0);
  assert.deepEqual(io.lines, [root1.keyid]);
  assert.equal(await main(['draft', '--root-pub', 'r1.pub', '--online', 'release=rel.pub', '--online', 'tenant_keyset=ks.pem', '--out', 'd1.json'], io), 0);
  assert.equal(await main(['sign', '--draft', 'd1.json', '--key', 'r1.pem', '--out', 'root1.json'], io), 0, io.errors.join());
  const env = JSON.parse(files['root1.json']) as DsseEnvelope;
  assert.equal(releaseCheck([env], [root1.keyid]).code, 'ATTESTA_TRUST_VERIFIED');
  // Nothing printed or written is key material.
  const printed = [...io.lines, ...io.errors].join('\n') + files['d1.json'] + files['root1.json'];
  assert.doesNotMatch(printed, /BEGIN|PRIVATE/);
  assert.ok(io.lines.some((l) => l.includes('digest sha256:')));
});

test('T15l root tool: rotation must be signed by the previous root and the new one', async () => {
  const files: Record<string, string> = { 'r1.pem': root1.priv, 'r1.pub': root1.pub, 'r2.pem': root2.priv, 'r2.pub': root2.pub, 'rel.pub': release.pub, 'ks.pub': keyset.pub };
  const io = memIo(files);
  assert.equal(await main(['draft', '--root-pub', 'r1.pub', '--online', 'release=rel.pub', '--online', 'tenant_keyset=ks.pub', '--out', 'd1.json'], io), 0);
  assert.equal(await main(['sign', '--draft', 'd1.json', '--key', 'r1.pem', '--out', 'root1.json'], io), 0);
  // Version 2: root2 replaces root1; online keys carried over unchanged without being named again.
  assert.equal(await main(['draft', '--root-pub', 'r2.pub', '--previous', 'root1.json', '--issued-at', '2026-10-13T11:00:00.000Z', '--out', 'd2.json'], io), 0, io.errors.join());
  const d2 = JSON.parse(files['d2.json']);
  assert.equal(d2.version, 2);
  assert.equal(d2.keys.filter((k: { purpose: string }) => k.purpose !== 'root').length, 2);
  assert.equal(await main(['sign', '--draft', 'd2.json', '--key', 'r2.pem', '--previous', 'root1.json', '--out', 'bad.json'], io), 1);
  assert.match(io.errors.at(-1) ?? '', /previous root/);
  assert.equal(await main(['sign', '--draft', 'd2.json', '--key', 'r1.pem', '--previous', 'root1.json', '--out', 'bad.json'], io), 1);
  assert.equal(await main(['sign', '--draft', 'd2.json', '--key', 'r2.pem', '--key', 'r1.pem', '--out', 'bad.json'], io), 1);
  assert.match(io.errors.at(-1) ?? '', /--previous is required/);
  assert.equal(await main(['sign', '--draft', 'd2.json', '--key', 'r1.pem', '--key', 'r2.pem', '--previous', 'root1.json', '--out', 'root2.json'], io), 0, io.errors.join());
  const r1 = JSON.parse(files['root1.json']) as DsseEnvelope;
  const r2 = JSON.parse(files['root2.json']) as DsseEnvelope;
  assert.equal(releaseCheck([r1, r2], [root1.keyid]).code, 'ATTESTA_TRUST_VERIFIED');
  assert.equal(releaseCheck([r2], [root2.keyid]).code, 'ATTESTA_TRUST_VERIFIED');
  assert.equal(files['bad.json'], undefined);
});

test('T15l root tool: refusals', async () => {
  const k1 = pemPair('secp256k1');
  const files: Record<string, string> = { 'r1.pem': root1.priv, 'r1.pub': root1.pub, 'k1.pem': k1.priv, 'junk': 'not a key' };
  const io = memIo(files);
  assert.equal(await main(['keyid', '--key', 'k1.pem'], io), 1);
  assert.equal(await main(['keyid', '--key', 'junk'], io), 1);
  assert.equal(await main(['keyid', '--key', 'missing'], io), 1);
  assert.equal(await main(['draft', '--root-pub', 'r1.pub', '--online', 'statement=r1.pub', '--out', 'd.json'], io), 1);
  assert.equal(await main(['draft', '--root-pub', 'r1.pub', '--root-pub', 'r1.pub', '--out', 'd.json'], io), 1);
  assert.equal(await main(['draft', '--root-pub', 'r1.pub', '--threshold', '2', '--out', 'd.json'], io), 1);
  assert.equal(await main(['bogus'], io), 1);
  assert.equal(await main(['sign', '--draft', 'junk', '--key', 'r1.pem', '--out', 'x'], io), 1);
  const dbIo = memIo(files, { DATABASE_URL: 'postgres://example.invalid/db' });
  assert.equal(await main(['keyid', '--key', 'r1.pem'], dbIo), 1);
  assert.match(dbIo.errors[0], /offline machine/);
  assert.doesNotMatch(dbIo.errors[0], /example\.invalid/);
  assert.doesNotMatch([...io.errors].join('\n'), /BEGIN|PRIVATE|not a key\b.*not a key/);
});

test('T15l root tool: refuses a tampered predecessor and drafts that break the forward-only rule', async () => {
  const files: Record<string, string> = { 'r1.pem': root1.priv, 'r1.pub': root1.pub, 'rel.pub': release.pub, 'ks.pub': keyset.pub };
  const io = memIo(files);
  assert.equal(await main(['draft', '--root-pub', 'r1.pub', '--online', 'release=rel.pub', '--online', 'tenant_keyset=ks.pub', '--out', 'd1.json'], io), 0);
  assert.equal(await main(['sign', '--draft', 'd1.json', '--key', 'r1.pem', '--out', 'root1.json'], io), 0);
  assert.equal(await main(['draft', '--root-pub', 'r1.pub', '--previous', 'root1.json', '--issued-at', '2026-10-13T11:00:00.000Z', '--out', 'd2.json'], io), 0);
  const good = JSON.parse(files['d2.json']);
  // Tampered predecessor: one payload byte changed, signature kept.
  const r1 = JSON.parse(files['root1.json']);
  const body = JSON.parse(Buffer.from(r1.payload, 'base64').toString('utf8'));
  body.expires = '2027-10-12T10:00:00.000Z';
  files['tampered.json'] = JSON.stringify({ ...r1, payload: Buffer.from(JSON.stringify(body)).toString('base64') });
  assert.equal(await main(['draft', '--root-pub', 'r1.pub', '--previous', 'tampered.json', '--out', 'x.json'], io), 1);
  assert.equal(await main(['sign', '--draft', 'd2.json', '--key', 'r1.pem', '--previous', 'tampered.json', '--out', 'x.json'], io), 1);
  const nonRoot = (d: { keys: Array<{ purpose: string }> }) => d.keys.findIndex((k) => k.purpose === 'release');
  const variants: Array<[string, (d: typeof good) => void]> = [
    ['removes a key', (d) => { d.keys.splice(nonRoot(d), 1); }],
    ['widens a key', (d) => { d.keys[nonRoot(d)].not_after = '2028-01-01T00:00:00.000Z'; }],
    ['moves issued_at back', (d) => { d.issued_at = '2026-10-13T09:59:59.999Z'; d.expires = '2027-10-13T09:59:59.999Z'; }],
  ];
  for (const [name, mutate] of variants) {
    const d = JSON.parse(JSON.stringify(good));
    mutate(d);
    files[`bad-${name}.json`] = JSON.stringify(d);
    assert.equal(await main(['sign', '--draft', `bad-${name}.json`, '--key', 'r1.pem', '--previous', 'root1.json', '--out', 'x.json'], io), 1, name);
    assert.match(io.errors.at(-1) ?? '', /forward-only|not a valid|threshold/, name);
  }
  // Undo a revocation: v2 revokes the release key, a v3 draft marks it active again.
  const revoked = JSON.parse(JSON.stringify(good));
  revoked.keys[nonRoot(revoked)] = { ...revoked.keys[nonRoot(revoked)], status: 'revoked', revoked_at: revoked.issued_at, revocation_reason: 'superseded' };
  files['d2r.json'] = JSON.stringify(revoked);
  assert.equal(await main(['sign', '--draft', 'd2r.json', '--key', 'r1.pem', '--previous', 'root1.json', '--out', 'root2.json'], io), 0, io.errors.join());
  const undo = JSON.parse(JSON.stringify(good));
  undo.version = 3;
  undo.issued_at = '2026-10-13T12:00:00.000Z';
  undo.expires = '2027-10-13T12:00:00.000Z';
  undo.previous = 'sha256:' + require('node:crypto').createHash('sha256').update(Buffer.from(JSON.parse(files['root2.json']).payload, 'base64')).digest('hex');
  files['d3.json'] = JSON.stringify(undo);
  assert.equal(await main(['sign', '--draft', 'd3.json', '--key', 'r1.pem', '--previous', 'root2.json', '--out', 'x.json'], io), 1);
  assert.match(io.errors.at(-1) ?? '', /forward-only/);
  assert.equal(files['x.json'], undefined);
});
