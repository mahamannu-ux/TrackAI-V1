import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertOwnerOnlyDirectory,
  atomicWriteOwnerOnly,
  readOwnerOnlyFile,
} from './task4-wave4-local-file';

const CREDENTIAL_PATTERN = /^trk_v1\.([A-Za-z0-9_-]{16})\.[A-Za-z0-9_-]{43}$/;

async function readCredential(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('Credential input must be piped from a silent prompt; interactive input is refused');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > 1_024) throw new Error('Credential input is too large');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function parseKeyring(raw: string): { credentials: string[]; keyIds: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Machine keyring is invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object'
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { credentials?: unknown }).credentials)) {
    throw new Error('Machine keyring is invalid');
  }
  const credentials = (parsed as { credentials: unknown[] }).credentials.map(value => {
    if (typeof value !== 'string' || !CREDENTIAL_PATTERN.test(value)) {
      throw new Error('Machine keyring contains an invalid credential');
    }
    return value;
  });
  const keyIds = credentials.map(value => CREDENTIAL_PATTERN.exec(value)![1]);
  if (new Set(keyIds).size !== keyIds.length) throw new Error('Machine keyring contains duplicate key IDs');
  return { credentials, keyIds };
}

async function main(): Promise<void> {
  const runtimeDir = process.env.TASK4_MACHINE_KEYRING_DIR?.trim();
  if (!runtimeDir || !path.isAbsolute(runtimeDir)) {
    throw new Error('TASK4_MACHINE_KEYRING_DIR must be an absolute path');
  }
  const apply = process.env.TASK4_MACHINE_KEYRING_ROTATION_APPLY === '1';
  const credential = await readCredential();
  const credentialMatch = CREDENTIAL_PATTERN.exec(credential);
  if (!credentialMatch) throw new Error('Input is not a valid TrackAI machine credential');

  await assertOwnerOnlyDirectory(runtimeDir);
  const keyringPath = path.join(runtimeDir, 'trackai-machine-credentials.json');
  const current = parseKeyring(await readOwnerOnlyFile(keyringPath));
  if (current.credentials.length !== 1) {
    throw new Error('Staging requires exactly one credential in the current keyring');
  }
  if (current.keyIds[0] === credentialMatch[1]) {
    throw new Error('Replacement credential must have a different key ID');
  }

  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`current_key_id=${current.keyIds[0]}`);
  console.log(`replacement_key_id=${credentialMatch[1]}`);
  console.log('keys_after_stage=2');
  console.log(`keyring_file=${keyringPath}`);
  console.log('credential=validated-not-printed');
  if (!apply) {
    console.log('filesystem_changes=none');
    console.log('next=rerun-with-explicit-apply-after-review');
    return;
  }

  await atomicWriteOwnerOnly(keyringPath, `${JSON.stringify({
    version: 1,
    credentials: [...current.credentials, credential],
  }, null, 2)}\n`);
  // Re-read after the atomic switch; never serialize its contents to output.
  const verified = parseKeyring(await readFile(keyringPath, 'utf8'));
  if (verified.keyIds.length !== 2 || !verified.keyIds.includes(credentialMatch[1])) {
    throw new Error('Staged keyring verification failed');
  }
  console.log('keyring=rotation-staged');
  console.log('keyring_permissions=600');
  console.log('credential_values=never-printed');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Machine keyring rotation staging failed');
  process.exitCode = 1;
});
