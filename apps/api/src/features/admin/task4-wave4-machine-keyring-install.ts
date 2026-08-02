import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

async function main(): Promise<void> {
  const runtimeDir = process.env.TASK4_MACHINE_KEYRING_DIR?.trim();
  if (!runtimeDir || !path.isAbsolute(runtimeDir)) {
    throw new Error('TASK4_MACHINE_KEYRING_DIR must be an absolute path');
  }
  const credential = await readCredential();
  const match = CREDENTIAL_PATTERN.exec(credential);
  if (!match) throw new Error('Input is not a valid TrackAI machine credential');

  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const directoryStat = await stat(runtimeDir);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error('Machine keyring directory must be owner-only (0700)');
  }
  const keyringPath = path.join(runtimeDir, 'trackai-machine-credentials.json');
  await writeFile(keyringPath, `${JSON.stringify({ version: 1, credentials: [credential] }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  const keyringStat = await stat(keyringPath);
  if ((keyringStat.mode & 0o077) !== 0) {
    throw new Error('Machine keyring file permissions are not owner-only');
  }

  console.log('keyring=created');
  console.log(`key_id=${match[1]}`);
  console.log(`keyring_file=${keyringPath}`);
  console.log('directory_permissions=700');
  console.log('keyring_permissions=600');
  console.log('credential=accepted-not-printed');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Machine keyring installation failed');
  process.exitCode = 1;
});
