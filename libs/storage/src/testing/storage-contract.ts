import { beforeEach, describe, expect, it } from 'vitest';
import type { StorageProvider } from '../lib/storage-provider';

/**
 * Behaviour every StorageProvider must satisfy. Run it against each
 * implementation so local and S3 can never drift apart.
 */
export function runStorageContract(name: string, factory: () => Promise<StorageProvider>): void {
  describe(`${name} storage contract`, () => {
    let storage: StorageProvider;

    beforeEach(async () => {
      storage = await factory();
    });

    it('stores and reads back the exact bytes', async () => {
      const body = Buffer.from('hello world');
      const stored = await storage.put('trips/a/cover.txt', body, 'text/plain');

      expect(stored.key).toBe('trips/a/cover.txt');
      expect(stored.sizeBytes).toBe(body.byteLength);
      expect(await storage.get('trips/a/cover.txt')).toEqual(body);
    });

    it('reports existence correctly', async () => {
      expect(await storage.exists('trips/a/missing.txt')).toBe(false);
      await storage.put('trips/a/there.txt', Buffer.from('x'), 'text/plain');
      expect(await storage.exists('trips/a/there.txt')).toBe(true);
    });

    it('overwrites an existing key', async () => {
      await storage.put('k.txt', Buffer.from('first'), 'text/plain');
      await storage.put('k.txt', Buffer.from('second'), 'text/plain');
      expect((await storage.get('k.txt')).toString()).toBe('second');
    });

    it('deletes and is idempotent about it', async () => {
      await storage.put('gone.txt', Buffer.from('x'), 'text/plain');
      await storage.delete('gone.txt');
      expect(await storage.exists('gone.txt')).toBe(false);
      await expect(storage.delete('gone.txt')).resolves.toBeUndefined();
    });

    it('rejects keys that try to escape the namespace', async () => {
      await expect(storage.put('../escape.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow();
      await expect(storage.get('../../etc/passwd')).rejects.toThrow();
    });

    it('builds a public url containing the key', () => {
      expect(storage.publicUrl('trips/a/cover.jpg')).toContain('trips/a/cover.jpg');
    });

    // --- Malformed and traversal-adjacent keys. Every one of these must be
    // rejected the same way by every implementation, because `assertSafeKey`
    // is the only thing standing between a caller-supplied key and the
    // backing store. A case that passes on one implementation and not the
    // other is a security bug, not a quirk.

    it('rejects an absolute path', async () => {
      await expect(storage.put('/etc/passwd', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    });

    it('rejects a key using backslashes', async () => {
      await expect(storage.put('trips\\..\\secret.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    });

    it('rejects an empty key', async () => {
      await expect(storage.put('', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    });

    it('rejects a key made only of dots', async () => {
      await expect(storage.put('...', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    });

    it('rejects a key with a single-dot segment', async () => {
      await expect(storage.put('trips/./cover.jpg', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    });

    it('rejects a key with an empty segment (double slash)', async () => {
      await expect(storage.put('trips//cover.jpg', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    });

    it('rejects a key ending in a slash', async () => {
      await expect(storage.put('trips/a/', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    });

    it('rejects a percent-encoded traversal attempt', async () => {
      // The literal '%' character is outside the allowed charset, so this is
      // rejected as-is — we never decode a key before validating it.
      await expect(storage.put('a/%2e%2e%2fsecret.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    });

    it('rejects a key longer than the maximum length', async () => {
      const tooLong = `a${'x'.repeat(1100)}.txt`;
      await expect(storage.put(tooLong, Buffer.from('x'), 'text/plain')).rejects.toThrow();
    });

    it('rejects building a public url for an unsafe key', () => {
      expect(() => storage.publicUrl('../escape.txt')).toThrow();
    });
  });
}
