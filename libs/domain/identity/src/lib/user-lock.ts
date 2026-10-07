import type { DbTransactionClient } from '@rm/db';

/**
 * Locks the user's row for the rest of the transaction.
 *
 * Accepting an invitation and resetting a password both write the same
 * account and the token rows of the same table. Taken in different orders
 * (token first vs user first) two concurrent calls deadlock, and one of them
 * surfaces as a 500. Both therefore take THIS lock first, then touch the
 * tokens: one lock order for everyone.
 */
export async function lockUser(tx: DbTransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}

/** Prisma's "write conflict or deadlock, retry the transaction" error (P2034). */
export function isWriteConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2034';
}
