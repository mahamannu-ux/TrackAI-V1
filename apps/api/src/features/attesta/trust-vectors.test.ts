/**
 * Trust-layer vectors (Task15l contract): the files reproduce byte for byte from
 * generate.ts, every well-formed document payload passes
 * trust-document-v1.schema.json, every expected code is a contract code with its
 * fixed status, and OpenSSL (an independent implementation) verifies the
 * signatures that must verify. Running the vectors through verifyTrusted is in
 * trust-verify.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { canonicalize, sha256Prefixed } from './canonical';
import { pae, type DsseEnvelope } from './dsse';
import { TRUST_CODE_STATUS } from './trust-contract';
import { buildVectorFiles } from './vectors/trust/generate';

const VECTOR_DIR = join(__dirname, 'vectors', 'trust');
const SCHEMA = JSON.parse(readFileSync(join(__dirname, '../../../../../docs/contracts/attesta/trust-document-v1.schema.json'), 'utf8'));

interface VectorFile {
  name: string;
  input: { payload_type: string; payload_b64: string; envelope: DsseEnvelope; state: {
    root_documents: DsseEnvelope[]; keyset_documents: Record<string, DsseEnvelope[]> } };
  expected: { status: string; code: string };
}

function vectorFiles(): Array<[string, VectorFile]> {
  return readdirSync(VECTOR_DIR).filter((f) => /^\d{2}-.*\.json$/.test(f)).sort()
    .map((f) => [f, JSON.parse(readFileSync(join(VECTOR_DIR, f), 'utf8')) as VectorFile]);
}

function documentsOf(v: VectorFile): DsseEnvelope[] {
  return [...v.input.state.root_documents, ...Object.values(v.input.state.keyset_documents).flat()];
}

test('T15l vectors: files reproduce byte for byte from the generator', () => {
  const built = buildVectorFiles();
  const onDisk = readdirSync(VECTOR_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(onDisk, [...built.keys()].sort());
  for (const [name, text] of built) assert.equal(readFileSync(join(VECTOR_DIR, name), 'utf8'), text, name);
  assert.ok(built.size > 50);
});

test('T15l vectors: expected codes are contract codes with their fixed status', () => {
  for (const [f, v] of vectorFiles()) {
    const status = (TRUST_CODE_STATUS as Record<string, string>)[v.expected.code];
    assert.ok(status, `${f}: unknown code ${v.expected.code}`);
    assert.equal(v.expected.status, status, f);
  }
});

test('T15l vectors: canonical document payloads satisfy the schema; key ids are SPKI digests', () => {
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  const validate = ajv.compile(SCHEMA);
  const seen = new Set<string>();
  let checked = 0;
  for (const [f, v] of vectorFiles()) {
    for (const env of documentsOf(v)) {
      const text = Buffer.from(env.payload, 'base64').toString('utf8');
      if (seen.has(text)) continue;
      seen.add(text);
      const body = JSON.parse(text) as { keys: Array<{ keyid: string; spki_der_b64: string }> };
      if (canonicalize(body) !== text) continue; // the deliberately non-canonical vector
      assert.ok(validate(body), `${f}: ${JSON.stringify(validate.errors)}`);
      checked++;
      const ids = body.keys.map((k) => k.keyid);
      const bad = body.keys.filter((k) => sha256Prefixed(Buffer.from(k.spki_der_b64, 'base64')) !== k.keyid);
      // Exactly one vector carries a wrong keyid (and a duplicate) on purpose.
      if (bad.length > 0) assert.equal(v.expected.code, 'ATTESTA_TRUST_DOCUMENT_MALFORMED', f);
      else assert.equal(new Set(ids).size, ids.length, f);
    }
  }
  assert.ok(checked >= 10);
});

test('T15l vectors: the schema refuses what trust.md forbids', () => {
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  const validate = ajv.compile(SCHEMA);
  const [, good] = vectorFiles()[0];
  type Doc = { keys: Array<Record<string, unknown>>; issued_at: string } & Record<string, unknown>;
  const root = JSON.parse(Buffer.from(good.input.state.root_documents[0].payload, 'base64').toString('utf8')) as Doc;
  const keyset = JSON.parse(Buffer.from(Object.values(good.input.state.keyset_documents)[0][0].payload, 'base64').toString('utf8')) as Doc;
  assert.ok(validate(structuredClone(root)) && validate(structuredClone(keyset)));
  const bad: unknown[] = [
    { ...root, extra: 1 },
    { ...root, threshold: undefined },
    { ...root, previous: 'sha256:' + '0'.repeat(64) },
    { ...keyset, version: 2, previous: null },
    { ...keyset, threshold: 1 },
    { ...keyset, scope: 'platform' },
    { ...root, keys: root.keys.filter((k) => k.purpose !== 'root') },
    { ...keyset, keys: [{ ...keyset.keys[0], purpose: 'release' }] },
    { ...root, keys: [...root.keys, { ...keyset.keys[0] }] },
    { ...keyset, keys: [{ ...keyset.keys[0], status: 'retired' }] },
    { ...keyset, keys: [{ ...keyset.keys[0], revoked_at: keyset.issued_at }] },
    { ...keyset, keys: [{ ...keyset.keys[0], status: 'revoked', revoked_at: keyset.issued_at, revocation_reason: 'compromised' }] },
    { ...keyset, keys: [{ ...keyset.keys[0], status: 'revoked', revoked_at: keyset.issued_at, revocation_reason: 'superseded', compromised_since: keyset.issued_at }] },
    { ...keyset, keys: [{ ...keyset.keys[0], spki_der_b64: 'AAAA' }] },
    { ...keyset, issued_at: '2026-10-10T00:00:00Z' },
    { ...keyset, version: 1.5 },
  ].map((o) => JSON.parse(JSON.stringify(o)));
  bad.forEach((doc, i) => assert.equal(validate(doc), false, `case ${i}`));
});

function hasOpenssl(): boolean {
  return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
}

test('T15l vectors: OpenSSL verifies the signatures of every verified vector (independent oracle)', { skip: !hasOpenssl() && 'openssl not on PATH' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't15l-oracle-'));
  try {
    const keys = JSON.parse(readFileSync(join(VECTOR_DIR, 'keys.json'), 'utf8')).keys as Array<{ keyid: string; spki_der_b64: string }>;
    const spkiByKeyid = new Map(keys.map((k) => [k.keyid, Buffer.from(k.spki_der_b64, 'base64')]));
    const checked = new Set<string>();
    for (const [f, v] of vectorFiles()) {
      if (v.expected.status !== 'verified') continue;
      for (const env of [v.input.envelope, ...documentsOf(v)]) {
        for (const s of env.signatures) {
          const spki = spkiByKeyid.get(s.keyid);
          const id = `${s.keyid}:${s.sig}`;
          if (!spki || checked.has(id)) continue;
          checked.add(id);
          writeFileSync(join(dir, 'key.der'), spki);
          writeFileSync(join(dir, 'pae.bin'), pae(env.payloadType, Buffer.from(env.payload, 'base64')));
          writeFileSync(join(dir, 'sig.der'), Buffer.from(s.sig, 'base64'));
          const r = spawnSync('openssl', ['dgst', '-sha256', '-verify', join(dir, 'key.der'), '-keyform', 'DER',
            '-signature', join(dir, 'sig.der'), join(dir, 'pae.bin')], { encoding: 'utf8' });
          assert.equal(r.status, 0, `${f}: OpenSSL refused ${s.keyid}: ${r.stdout}${r.stderr}`);
        }
      }
    }
    assert.ok(checked.size >= 10, `only ${checked.size} signatures checked`);
    // And refuses the one artifact signature made over other bytes.
    const bad = vectorFiles().find(([, v]) => v.name === 'signature-invalid')?.[1];
    assert.ok(bad);
    const s = bad.input.envelope.signatures[0];
    writeFileSync(join(dir, 'key.der'), spkiByKeyid.get(s.keyid) as Buffer);
    writeFileSync(join(dir, 'pae.bin'), pae(bad.input.envelope.payloadType, Buffer.from(bad.input.envelope.payload, 'base64')));
    writeFileSync(join(dir, 'sig.der'), Buffer.from(s.sig, 'base64'));
    const r = spawnSync('openssl', ['dgst', '-sha256', '-verify', join(dir, 'key.der'), '-keyform', 'DER',
      '-signature', join(dir, 'sig.der'), join(dir, 'pae.bin')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
