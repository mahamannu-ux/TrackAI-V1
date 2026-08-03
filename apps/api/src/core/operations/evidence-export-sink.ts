import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export interface EvidenceExportWriteResult {
  storageReference: string;
  bytes: number;
}

export interface EvidenceExportSink {
  write(exportId: string, content: string): Promise<EvidenceExportWriteResult>;
  read(storageReference: string): Promise<string>;
  remove(storageReference: string): Promise<void>;
}

export class LocalFileEvidenceExportSink implements EvidenceExportSink {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error('Export directory is required');
    this.rootDirectory = resolve(rootDirectory);
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.rootDirectory, 0o700);
  }

  async write(exportId: string, content: string): Promise<EvidenceExportWriteResult> {
    if (!/^[0-9a-f-]{36}$/i.test(exportId)) throw new Error('Export ID is invalid');
    await this.prepareDirectory();
    const nonce = randomBytes(8).toString('hex');
    const fileName = `trackai-export-${exportId}-${nonce}.json`;
    const finalPath = join(this.rootDirectory, fileName);
    const temporaryPath = `${finalPath}.tmp`;
    try {
      await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
      const metadata = await stat(finalPath);
      if (!metadata.isFile() || metadata.size === 0) throw new Error('Export artifact is empty');
      return { storageReference: `local-file:${fileName}`, bytes: metadata.size };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async read(storageReference: string): Promise<string> {
    const filePath = await this.resolveStorageReference(storageReference);
    return readFile(filePath, 'utf8');
  }

  async remove(storageReference: string): Promise<void> {
    const filePath = await this.resolveStorageReference(storageReference);
    await unlink(filePath);
  }

  private async resolveStorageReference(storageReference: string): Promise<string> {
    if (!storageReference.startsWith('local-file:')) {
      throw new Error('Export storage reference is unsupported');
    }
    const fileName = storageReference.slice('local-file:'.length);
    if (!/^trackai-export-[0-9a-f-]{36}-[0-9a-f]{16}\.json$/i.test(fileName)
      || basename(fileName) !== fileName) {
      throw new Error('Export storage reference is invalid');
    }
    const filePath = join(this.rootDirectory, fileName);
    const metadata = await stat(filePath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error('Export artifact permissions are insecure');
    }
    return filePath;
  }
}
