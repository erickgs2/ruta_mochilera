import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('produces an argon2id hash that verifies against the original', async () => {
    const hash = await hashPassword('Correct-Horse-1');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'Correct-Horse-1')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('Correct-Horse-1');
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('produces a different hash for the same password (unique salt)', async () => {
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(first).not.toBe(second);
  });

  it('returns false instead of throwing on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});
