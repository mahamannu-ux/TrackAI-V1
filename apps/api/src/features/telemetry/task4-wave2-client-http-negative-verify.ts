import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

type ManifestEntry = {
  label: string;
  tenantId: string;
  repositoryUrl: string;
  keyId: string;
};

type Manifest = {
  version: number;
  apiBaseUrl: string;
  credentialPath: string;
  entries: ManifestEntry[];
};

type Keyring = { version: number; credentials: string[] };
type UploadError = { index: number; error: string };

function credentialKeyId(credential: string): string | null {
  const [prefix, keyId, secret, extra] = credential.split('.');
  return prefix === 'trk_v1' && keyId && secret && extra === undefined ? keyId : null;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const runtimeDirValue = process.env.TASK4_WAVE2_RUNTIME_DIR?.trim();
  if (!runtimeDirValue) throw new Error('TASK4_WAVE2_RUNTIME_DIR is required');

  const manifestPath = join(resolve(runtimeDirValue), 'task4-wave2-client-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  const keyring = JSON.parse(await readFile(manifest.credentialPath, 'utf8')) as Keyring;
  if (manifest.version !== 1 || manifest.entries.length !== 2
    || keyring.version !== 1 || keyring.credentials.length !== 2) {
    throw new Error('Wave 2 runtime files are invalid');
  }

  const credentialByKeyId = new Map(
    keyring.credentials.map(credential => [credentialKeyId(credential), credential]),
  );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave2-http-negative-verify',
  });

  try {
    for (const entry of manifest.entries) {
      const other = manifest.entries.find(candidate => candidate.tenantId !== entry.tenantId);
      if (!other) throw new Error('A distinct cross-tenant fixture is required');
      const credential = credentialByKeyId.get(entry.keyId);
      if (!credential) throw new Error(`${entry.label} credential key is missing`);

      const marker = `task4-wave2-http-${randomUUID()}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const event = (repositoryUrl: string, branch: string, suffix: string) => ({
        t: timestamp,
        e: 999,
        v: { 0: `${marker}-${suffix}` },
        a: { 1: repositoryUrl, 5: branch },
      });
      const response = await fetch(`${manifest.apiBaseUrl}/worker/metrics/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': credential },
        body: JSON.stringify({
          v: 1,
          events: [
            event(entry.repositoryUrl, `task4-wave2/${entry.label}`, 'allowed'),
            event(other.repositoryUrl, `task4-wave2/${other.label}`, 'cross-tenant'),
            event(entry.repositoryUrl, 'main', 'denied-branch'),
          ],
        }),
      });
      const body = await response.json() as { errors?: UploadError[] };
      if (response.status !== 200 || !Array.isArray(body.errors)) {
        throw new Error(`${entry.label} partial acknowledgement did not return HTTP 200`);
      }
      const indexes = body.errors.map(error => error.index);
      if (indexes.length !== 2 || indexes[0] !== 1 || indexes[1] !== 2
        || body.errors.some(error => error.error !== 'Machine repository or branch grant is not active')) {
        throw new Error(`${entry.label} partial acknowledgement indexes or reasons changed`);
      }

      const retained = await pool.query<{ own_count: string; foreign_count: string }>(`
        SELECT
          count(*) FILTER (WHERE tenant_id = $1)::text AS own_count,
          count(*) FILTER (WHERE tenant_id <> $1)::text AS foreign_count
        FROM telemetry_metric_events
        WHERE raw_event #>> '{v,0}' = $2
      `, [entry.tenantId, `${marker}-allowed`]);
      if (retained.rows[0].own_count !== '1' || retained.rows[0].foreign_count !== '0') {
        throw new Error(`${entry.label} allowed event was not retained in exactly one tenant`);
      }
      const rejected = await pool.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM telemetry_metric_events
        WHERE raw_event #>> '{v,0}' = ANY($1::text[])
      `, [[`${marker}-cross-tenant`, `${marker}-denied-branch`]]);
      if (rejected.rows[0].count !== '0') {
        throw new Error(`${entry.label} rejected event was retained`);
      }

      console.log(`${entry.label}.http_status=200`);
      console.log(`${entry.label}.allowed_index=retained`);
      console.log(`${entry.label}.cross_tenant_index=rejected`);
      console.log(`${entry.label}.denied_branch_index=rejected`);
      console.log(`${entry.label}.partial_ack_indexes=1,2`);
    }
    console.log('credentials=used-without-printing');
    console.log('raw_payloads=not-printed');
    console.log('http_negative_verification=passed');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 2 HTTP negative verification failed');
  process.exitCode = 1;
});
