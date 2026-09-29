import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalFileStorage } from './local-file-storage';
import { runStorageContract } from '../testing/storage-contract';

const roots: string[] = [];

runStorageContract('local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rm-storage-'));
  roots.push(root);
  return new LocalFileStorage(root, 'http://localhost:3000/files');
});

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalFileStorage', () => {
  it('creates nested directories on demand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rm-storage-'));
    roots.push(root);
    const storage = new LocalFileStorage(root, 'http://localhost:3000/files');

    await storage.put('trips/deep/nested/file.txt', Buffer.from('x'), 'text/plain');
    expect(await storage.exists('trips/deep/nested/file.txt')).toBe(true);
  });
});
