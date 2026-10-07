import type { Db, DbTransactionClient } from '@rm/db';
import type { Result } from '@rm/shared-utils';

/**
 * The counter's side of reviving a reservation whose hold ran out
 * (Phase 2B, decision 13): the money half. The seat half is
 * `reviveReservationSeat` in `@rm/domain-reservations`, which the caller
 * injects as a `ReviveReservation` -- the two domains do not import each
 * other, so the type is written here structurally.
 */
export type ReviveReservation = (
  tx: DbTransactionClient,
  input: { reservationId: string; actorId: string }
) => Promise<
  Result<{ outcome: 'LIVE' } | { outcome: 'REVIVED'; previousStatus: 'EXPIRED' | 'HELD' }>
>;

/** Carries a failed `Result` out of a transaction so the transaction rolls back. */
export class RollbackWith extends Error {
  constructor(readonly result: Result<never>) {
    super('rolled back');
  }
}

/** Runs `run` in a transaction, turning a thrown `RollbackWith` back into its `Result`. */
export async function rollbackable<T>(
  db: Db,
  run: (tx: DbTransactionClient) => Promise<Result<T>>
): Promise<Result<T>> {
  try {
    return await db.$transaction(run);
  } catch (error) {
    if (error instanceof RollbackWith) return error.result;
    throw error;
  }
}
