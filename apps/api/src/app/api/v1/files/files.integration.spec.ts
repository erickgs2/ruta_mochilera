import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFileStorage } from '@rm/storage';
import { config, setConfig } from '../../../../lib/config';
import { setStorage, storage } from '../../../../lib/storage';
import { GET as filesRoute } from './[...key]/route';

describe('files route', () => {
  let storageRoot: string;

  beforeEach(() => {
    // A throwaway directory rather than the developer's own
    // `STORAGE_LOCAL_ROOT`: this suite writes real files to disk.
    storageRoot = mkdtempSync(join(tmpdir(), 'rm-files-test-'));
    setStorage(new LocalFileStorage(storageRoot, 'http://localhost/api/v1/files'));
  });

  afterEach(() => {
    setStorage(undefined);
    setConfig(undefined);
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('serves a locally stored file when the driver is local', async () => {
    await storage().put('trips/a/cover.jpg', Buffer.from('hello world'), 'image/jpeg');

    const response = await filesRoute(new Request('http://localhost/api/v1/files/trips/a/cover.jpg'), {
      params: Promise.resolve({ key: ['trips', 'a', 'cover.jpg'] }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello world');
  });

  it('returns 404 for a key that was never stored', async () => {
    const response = await filesRoute(new Request('http://localhost/api/v1/files/trips/a/missing.jpg'), {
      params: Promise.resolve({ key: ['trips', 'a', 'missing.jpg'] }),
    });
    expect(response.status).toBe(404);
  });

  it('refuses to serve anything when the driver is s3, even for a key that exists locally', async () => {
    await storage().put('trips/a/cover.jpg', Buffer.from('hello world'), 'image/jpeg');
    // In qa and production the driver is S3 and the bucket serves files
    // directly, so this route must never fall back to the local disk.
    setConfig({ ...config(), storageDriver: 's3' });

    const response = await filesRoute(new Request('http://localhost/api/v1/files/trips/a/cover.jpg'), {
      params: Promise.resolve({ key: ['trips', 'a', 'cover.jpg'] }),
    });
    expect(response.status).toBe(404);
  });
});
