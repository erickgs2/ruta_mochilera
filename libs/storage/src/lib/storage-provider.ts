export interface StoredObject {
  key: string;
  contentType: string;
  sizeBytes: number;
}

export interface StorageProvider {
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  publicUrl(key: string): string;
}

// Only ASCII letters, digits, dot, underscore, slash and dash. This alone
// rules out absolute paths (must start alnum), backslashes, percent-encoded
// characters, null bytes, whitespace and any non-ASCII trick — none of those
// characters are in the allowed set, so they never need explicit decoding.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// S3 itself caps object keys at 1024 bytes; keeping local storage to the same
// bound means a key that is valid here is also valid once S3 is wired up.
const MAX_KEY_LENGTH = 1024;

/**
 * Rejects absolute paths, traversal, malformed segments and anything outside
 * the allowed charset. This is the only gate between a caller-supplied key
 * and the backing store (filesystem or S3 bucket) — every implementation
 * must call it before touching the key.
 */
export function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    !SAFE_KEY.test(key) ||
    key.includes('//') ||
    key.endsWith('/')
  ) {
    throw new Error(`Unsafe storage key: ${key}`);
  }

  // Reject any path segment that is only dots ('.', '..', '...', ...). The
  // '..' case is classic traversal; the others are malformed and have no
  // legitimate use, so we close the whole family rather than just '..'.
  for (const segment of key.split('/')) {
    if (/^\.+$/.test(segment)) {
      throw new Error(`Unsafe storage key: ${key}`);
    }
  }
}
