import { hash, verify } from '@node-rs/argon2';

// OWASP recommended parameters for argon2id: 19 MiB of memory, 2 iterations, 1 thread.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain, OPTIONS);
  } catch {
    // A corrupted hash, or one produced by a foreign algorithm, is not a
    // business exception: it simply does not match.
    return false;
  }
}
