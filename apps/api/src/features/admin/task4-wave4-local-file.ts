import { lstat, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export async function readOwnerOnlyFile(filePath: string): Promise<string> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o077) !== 0) {
    throw new Error(`${path.basename(filePath)} must be an owner-only regular file (0600)`);
  }
  return readFile(filePath, 'utf8');
}

export async function assertOwnerOnlyDirectory(directory: string): Promise<void> {
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error('Machine runtime directory must be owner-only (0700)');
  }
}

export async function atomicWriteOwnerOnly(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
    const writtenStat = await lstat(filePath);
    if (!writtenStat.isFile() || writtenStat.isSymbolicLink() || (writtenStat.mode & 0o077) !== 0) {
      throw new Error(`${path.basename(filePath)} replacement is not owner-only`);
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
