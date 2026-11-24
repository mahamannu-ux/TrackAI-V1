/** E20-04: one synthetic, schema-valid record with a disallowed command preview. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error('usage: task20j-forbidden-upload.ts <private-directory>');
  const directory = resolve(process.argv[2]);
  const credential = readFileSync(join(directory, 'private/credential.txt'), 'utf8').trim();
  if (!credential) throw new Error('machine credential is missing');
  const headers = { 'x-api-key': credential };
  const leaseResponse = await fetch('http://127.0.0.1:8080/worker/security/v2/lease', { headers });
  if (!leaseResponse.ok) throw new Error(`lease fetch returned ${leaseResponse.status}`);
  const envelope = await leaseResponse.json() as { payload: string };
  const lease = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as {
    lease_id: string; bundle_digest: string; mode: string;
    data_settings: { command_previews: boolean };
  };
  if (lease.mode !== 'monitor' || lease.data_settings.command_previews) {
    throw new Error('E20-04 requires an active monitor lease with command previews off');
  }
  const recordId = `sha256:${createHash('sha256').update(randomUUID()).digest('hex')}`;
  const response = await fetch('http://127.0.0.1:8080/worker/security/v2/records', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 'trackai.security-upload/2', records: [{
      kind: 'finding', record_id: recordId, rule_id: 'nb.cmd.dangerous_deletion',
      rule_version: 'r1', severity: 'high', title: 'Synthetic E20 privacy check',
      source_agent: 'claude-code', source_type: 'hook', confidence: 'high',
      detected_at: new Date().toISOString(), numbat_schema_version: '0.5.0',
      bundle_digest: lease.bundle_digest, lease_id: lease.lease_id,
      found_at_rest: false, repository: { kind: 'not_enrolled' },
      observed_command: 'synthetic-preview-must-be-refused',
    }] }),
  });
  const body = await response.json() as { results?: Array<{ result?: string; code?: string }> };
  if (response.status !== 200 || body.results?.[0]?.result !== 'rejected'
    || body.results[0].code !== 'SECURITY_V2_FIELD_NOT_PERMITTED') {
    throw new Error(`unexpected forbidden-field result: HTTP ${response.status}`);
  }
  console.log('E20-04 forbidden-field upload=rejected code=SECURITY_V2_FIELD_NOT_PERMITTED');
}

main().catch(error => {
  console.error(`E20-04 failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
