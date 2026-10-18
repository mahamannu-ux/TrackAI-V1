import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import { canonicalize } from '../attesta/canonical';
import { LOCAL_DEV_MAX_PAYLOAD_BYTES, LocalDevSigner, generateDevCredential } from '../attesta/signer-local-dev';
import { ATTESTA_PLATFORM_TENANT_ID } from '../attesta/anchor-contract';
import { pinnedCatalogue } from './catalogue';
import { compileRules } from './compiler';
import { bundlePayload, signBundle } from './bundle';
import { applyRuleChanges, defaultRuleSettings } from './settings';
import {
  SECURITY_ACTIVATION_LEASE_PAYLOAD_TYPE,
  SECURITY_RULE_BUNDLE_PAYLOAD_TYPE,
  SecurityDocumentTooLarge,
  SecuritySigningUnavailable,
  fixedSigner,
  signSecurityDocument,
} from './signing';
import { securitySignerFromEnv } from './signing-env';
import { trustFixture } from './testing/trust-fixture';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-17T12:00:00.000Z');
const catalogue = pinnedCatalogue();
const CONTRACT = resolve(__dirname, '../../../../../docs/contracts/security-v2');

function contractAjv(): Ajv {
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
  ajv.addFormat('date-time', { type: 'string', validate: (value: string) => Number.isFinite(Date.parse(value)) });
  ajv.addFormat('uri', { type: 'string', validate: (value: string) => { try { new URL(value); return true; } catch { return false; } } });
  for (const file of readdirSync(CONTRACT).filter(name => name.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(join(CONTRACT, file), 'utf8')));
  }
  return ajv;
}

async function defaultBundle(fixture = trustFixture(NOW)) {
  const payload = bundlePayload({
    tenantId: TENANT, bundleVersion: 1, epoch: 1, issuedAt: NOW, compiled: compileRules(catalogue, defaultRuleSettings(catalogue), 1),
  });
  return { fixture, payload, signed: await signBundle(fixture.signer('policy_bundle'), payload) };
}

test('bundle: the payload validates against security-rule-bundle-v1 and carries every file digest', async () => {
  const { payload, signed } = await defaultBundle();
  const validate = contractAjv().getSchema('https://trackai.dev/contracts/security-v2/security-rule-bundle-v1.schema.json')!;
  assert.ok(validate(JSON.parse(signed.payload.toString('utf8'))), JSON.stringify(validate.errors));
  assert.deepEqual(Object.keys(payload.agents), ['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot']);
  for (const folder of Object.values(payload.agents)) {
    for (const file of folder!.files) {
      assert.equal(createHash('sha256').update(Buffer.from(file.content_b64, 'base64')).digest('hex'), file.sha256);
    }
  }
});

test('bundle: signed bytes verify with verifyTrusted (policy_bundle, platform); the digest is SHA-256 of the payload bytes', async () => {
  const { fixture, payload, signed } = await defaultBundle();
  assert.equal(signed.envelope.payloadType, SECURITY_RULE_BUNDLE_PAYLOAD_TYPE);
  assert.equal(signed.payload.toString('utf8'), canonicalize(payload), 'RFC 8785 bytes');
  assert.equal(signed.digest, createHash('sha256').update(signed.payload).digest('hex'));
  assert.deepEqual(JSON.parse(signed.envelopeBytes.toString('utf8')), signed.envelope, 'stored bytes are the envelope');
  assert.equal(signed.keyid, fixture.policy.keyid);
  const verdict = fixture.verify({ envelope: signed.envelope, purpose: 'policy_bundle', signedAt: payload.issued_at, now: NOW });
  assert.equal(verdict.status, 'verified', verdict.code);
});

test('bundle: a tampered payload, the wrong purpose and the wrong key are rejected', async () => {
  const { fixture, payload, signed } = await defaultBundle();
  const tampered = Buffer.from(canonicalize({ ...payload, epoch: 2 }), 'utf8');
  const forged = { ...signed.envelope, payload: tampered.toString('base64') };
  assert.equal(fixture.verify({ envelope: forged, purpose: 'policy_bundle', signedAt: payload.issued_at, now: NOW }).status, 'rejected');
  assert.equal(fixture.verify({ envelope: signed.envelope, purpose: 'activation_lease', signedAt: payload.issued_at, now: NOW }).code,
    'ATTESTA_TRUST_PURPOSE_MISMATCH');
  const byLeaseKey = await signSecurityDocument(fixture.wrongKeySigner('policy_bundle'), payload);
  assert.equal(fixture.verify({ envelope: byLeaseKey.envelope, purpose: 'policy_bundle', signedAt: payload.issued_at, now: NOW }).code,
    'ATTESTA_TRUST_PURPOSE_MISMATCH');
});

test('lease documents sign and verify the same way under activation_lease', async () => {
  const fixture = trustFixture(NOW);
  const lease = {
    schema_version: 'trackai.security-activation-lease/2', tenant_id: TENANT, machine_id: '22222222-2222-4222-8222-222222222222',
    lease_id: '33333333-3333-4333-8333-333333333333', issued_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 72 * 3_600_000).toISOString(),
    mode: 'monitor', agents: ['claude-code', 'codex'], bundle_digest: 'a'.repeat(64),
    data_settings: { schema_version: 'trackai.security-data-settings/1', command_previews: false, file_paths: false, urls: false, host_identity: false, user_identity: false },
    day_one_scan: false,
  };
  const validate = contractAjv().getSchema('https://trackai.dev/contracts/security-v2/security-activation-lease-v2.schema.json')!;
  assert.ok(validate(lease), JSON.stringify(validate.errors));
  const signed = await signSecurityDocument(fixture.signer('activation_lease'), lease);
  assert.equal(signed.envelope.payloadType, SECURITY_ACTIVATION_LEASE_PAYLOAD_TYPE);
  assert.equal(fixture.verify({ envelope: signed.envelope, purpose: 'activation_lease', signedAt: lease.issued_at, now: NOW }).status, 'verified');
  assert.equal(fixture.verify({ envelope: signed.envelope, purpose: 'policy_bundle', signedAt: lease.issued_at, now: NOW }).status, 'rejected');
});

test('signing fails closed: over the signer limit, no development key, development key in production', async () => {
  const fixture = trustFixture(NOW);
  // The Attesta adapters cap a signed payload at 4 MiB + 1 KiB (Task15op0, PR #80). No settings combination
  // reaches it (all 51 overrides compile to about 1.3 MB), so the refusal is proven with a document just over the cap.
  const over = { pad: 'x'.repeat(LOCAL_DEV_MAX_PAYLOAD_BYTES) };
  await assert.rejects(signSecurityDocument(fixture.signer('policy_bundle'), over), SecurityDocumentTooLarge);
  const all = Object.fromEntries(catalogue.manifest.rules.map(rule => [rule.id, { severity: rule.severity === 'info' ? 'low' : 'info' }]));
  const largest = bundlePayload({
    tenantId: TENANT, bundleVersion: 2, epoch: 2, issuedAt: NOW,
    compiled: compileRules(catalogue, applyRuleChanges(defaultRuleSettings(catalogue), all), 2),
  });
  assert.ok((await signBundle(fixture.signer('policy_bundle'), largest)).envelope.signatures.length === 1);
  await assert.rejects(signSecurityDocument(securitySignerFromEnv('policy_bundle', {}), { a: 1 }), SecuritySigningUnavailable);
  const credential = generateDevCredential('dev:task20f-env', ATTESTA_PLATFORM_TENANT_ID);
  const env = { SECURITY_POLICY_BUNDLE_CREDENTIAL_ID: credential.credentialId, SECURITY_DEV_POLICY_BUNDLE_KEY_FILE: '/key.pem' };
  const dev = securitySignerFromEnv('policy_bundle', env, { read: () => credential.privateKeyPem });
  assert.match((await signSecurityDocument(dev, { a: 1 })).keyid, /^sha256:[a-f0-9]{64}$/);
  // In production the dev variables are ignored: the trust inventory is the only source, and an empty one refuses.
  const prod = securitySignerFromEnv('policy_bundle', { ...env, NODE_ENV: 'production' }, {
    read: () => credential.privateKeyPem,
    store: { documents: async () => [], platformKeys: async () => [] } as never,
    adapters: { 'local-dev': new LocalDevSigner({ credentials: [], env: {} }) },
  });
  await assert.rejects(signSecurityDocument(prod, { a: 1 }), SecuritySigningUnavailable);
  assert.equal(fixedSigner('policy_bundle', new LocalDevSigner({ credentials: [], env: {} }), 'dev:none').purpose, 'policy_bundle');
});
