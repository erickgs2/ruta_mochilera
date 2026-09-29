import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertSafeKey, type StorageProvider, type StoredObject } from './storage-provider';

/** Filesystem-backed storage. Used in development, where the API runs on a Raspberry Pi. */
export class LocalFileStorage implements StorageProvider {
  constructor(
    private readonly root: string,
    private readonly baseUrl: string
  ) {}

  private path(key: string): string {
    assertSafeKey(key);
    return join(this.root, key);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    return { key, contentType, sizeBytes: body.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    // Resolve (and validate) the path before the try, so an unsafe key
    // throws instead of being absorbed by the catch below, which exists
    // only to turn a genuine filesystem miss into `false`.
    const target = this.path(key);
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  }

  publicUrl(key: string): string {
    assertSafeKey(key);
    return `${this.baseUrl.replace(/\/$/, '')}/${key}`;
  }
}
