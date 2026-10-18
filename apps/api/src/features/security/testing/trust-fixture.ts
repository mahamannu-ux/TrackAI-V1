/**
 * Test trust state for Task20f (tests and the live verify only): throwaway P-256 keys for
 * the platform root, policy_bundle and activation_lease purposes, a version-1 root
 * document listing them signed by the root key, and dev signers holding the two online
 * keys. Verification then goes through the real `verifyTrusted` with `production: true`,
 * exactly as the Endpoint (Task20g) will call it.
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { ATTESTA_PLATFORM_TENANT_ID } from '../../attesta/anchor-contract';
import { canonicalize } from '../../attesta/canonical';
import { pae, type DsseEnvelope } from '../../attesta/dsse';
import { LocalDevSigner, generateDevCredential } from '../../attesta/signer-local-dev';
import { TRUST_ROOT_PAYLOAD_TYPE, TRUST_ROOT_TYPE, verifyTrusted, type ArtifactPurpose, type TrustVerdict } from '../../attesta/trust-contract';
import { fixedSigner, keyidOf, type SecurityDocumentPurpose, type SecurityDocumentSigner } from '../signing';

interface TestKey {
  credentialId: string;
  privateKeyPem: string;
  spki: Buffer;
  keyid: string;
}

function testKey(name: string): TestKey {
  const credential = generateDevCredential(`dev:task20f-${name}`, ATTESTA_PLATFORM_TENANT_ID);
  const spki = createPublicKey(createPrivateKey(credential.privateKeyPem)).export({ type: 'spki', format: 'der' }) as Buffer;
  return { credentialId: credential.credentialId, privateKeyPem: credential.privateKeyPem, spki, keyid: keyidOf(spki) };
}

export interface TrustFixture {
  root: TestKey;
  policy: TestKey;
  lease: TestKey;
  rootDocument: DsseEnvelope;
  signer(purpose: SecurityDocumentPurpose): SecurityDocumentSigner;
  /** A signer for `purpose` that holds the *other* online key (purpose mismatch). */
  wrongKeySigner(purpose: SecurityDocumentPurpose): SecurityDocumentSigner;
  verify(input: { envelope: DsseEnvelope; purpose: ArtifactPurpose; signedAt: string; now: Date; payload?: Buffer }): TrustVerdict;
}

export function trustFixture(now = new Date()): TrustFixture {
  const root = testKey('root');
  const policy = testKey('policy-bundle');
  const lease = testKey('activation-lease');
  const day = 86_400_000;
  const notBefore = new Date(now.getTime() - day).toISOString();
  const notAfter = new Date(now.getTime() + 300 * day).toISOString();
  const entry = (key: TestKey, purpose: string) => ({
    keyid: key.keyid, purpose, spki_der_b64: key.spki.toString('base64'), not_before: notBefore, not_after: notAfter, status: 'active',
  });
  const body = {
    _type: TRUST_ROOT_TYPE, scope: 'platform', version: 1, issued_at: notBefore, expires: notAfter, previous: null, threshold: 1,
    keys: [entry(root, 'root'), entry(policy, 'policy_bundle'), entry(lease, 'activation_lease')],
  };
  const payload = Buffer.from(canonicalize(body), 'utf8');
  const sig = sign('sha256', pae(TRUST_ROOT_PAYLOAD_TYPE, payload), createPrivateKey(root.privateKeyPem));
  const rootDocument: DsseEnvelope = {
    payload: payload.toString('base64'), payloadType: TRUST_ROOT_PAYLOAD_TYPE, signatures: [{ keyid: root.keyid, sig: sig.toString('base64') }],
  };
  const adapter = new LocalDevSigner({
    credentials: [policy, lease].map(key => ({ credentialId: key.credentialId, tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: key.privateKeyPem })),
    env: {},
  });
  const keyFor = (purpose: SecurityDocumentPurpose) => (purpose === 'policy_bundle' ? policy : lease);
  return {
    root, policy, lease, rootDocument,
    signer: purpose => fixedSigner(purpose, adapter, keyFor(purpose).credentialId),
    wrongKeySigner: purpose => fixedSigner(purpose, adapter, keyFor(purpose === 'policy_bundle' ? 'activation_lease' : 'policy_bundle').credentialId),
    verify: ({ envelope, purpose, signedAt, now: at, payload: bytes }) => verifyTrusted({
      payloadType: envelope.payloadType,
      payload: bytes ?? Buffer.from(envelope.payload, 'base64'),
      envelope,
      purpose,
      audience: 'platform',
      signedAt,
      state: {
        pinnedRootKeyids: [root.keyid],
        rootDocuments: [rootDocument],
        keysetDocuments: {},
        lastTrusted: {},
        now: at.toISOString(),
        production: true,
      },
    }),
  };
}
