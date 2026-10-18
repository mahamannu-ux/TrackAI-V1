/**
 * The rule-bundle payload (Task20f; security-rule-bundle-v1.schema.json): a tenant's
 * compiled folders, with each file's digest and padded base64, signed as a whole with
 * the policy_bundle key.
 */
import { createHash } from 'node:crypto';
import {
  SECURITY_RULE_BUNDLE_SCHEMA,
  SECURITY_V2_MAX_BUNDLE_BYTES,
  SECURITY_V2_NUMBAT_PIN,
  type SecurityRuleBundleV1,
} from '../security-findings/v2-contract';
import { COMPILER_VERSION, type CompiledRules } from './compiler';
import { SECURITY_AGENTS } from './settings';
import { SecurityDocumentTooLarge, signSecurityDocument, type SecurityDocumentSigner, type SignedSecurityDocument } from './signing';

export function bundlePayload(input: {
  tenantId: string;
  bundleVersion: number;
  epoch: number;
  issuedAt: Date;
  compiled: CompiledRules;
}): SecurityRuleBundleV1 {
  for (const value of [input.bundleVersion, input.epoch]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('bundle version and epoch are positive integers');
  }
  const agents: SecurityRuleBundleV1['agents'] = {};
  for (const agent of SECURITY_AGENTS) {
    const folder = input.compiled.agents[agent];
    agents[agent] = {
      files: folder.files.map(file => ({
        path: file.path,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        content_b64: file.bytes.toString('base64'),
      })),
      enabled_rule_ids: [...folder.enabledRuleIds],
    };
  }
  return {
    schema_version: SECURITY_RULE_BUNDLE_SCHEMA,
    tenant_id: input.tenantId,
    bundle_version: input.bundleVersion,
    epoch: input.epoch,
    issued_at: input.issuedAt.toISOString(),
    numbat_pin: SECURITY_V2_NUMBAT_PIN,
    compiler_version: COMPILER_VERSION,
    agents,
  };
}

/** Sign a bundle payload; refuses one whose canonical bytes exceed 4 MiB. */
export async function signBundle(signer: SecurityDocumentSigner, payload: SecurityRuleBundleV1): Promise<SignedSecurityDocument> {
  if (signer.purpose !== 'policy_bundle') throw new Error('a rule bundle is signed with the policy_bundle key');
  const signed = await signSecurityDocument(signer, payload);
  if (signed.payload.length > SECURITY_V2_MAX_BUNDLE_BYTES) throw new SecurityDocumentTooLarge('rule bundle payload exceeds 4 MiB');
  return signed;
}
