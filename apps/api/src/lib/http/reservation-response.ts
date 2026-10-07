import type { Db } from '@rm/db';
import { suggestedMonthlyForReservation } from '@rm/domain-payments';
import type { ReservationDto } from '@rm/domain-reservations';
import { ok, type Result } from '@rm/shared-utils';

/** A reservation as the customer's reserve and detail screens read it: the DTO plus the suggested monthly payment. */
export type ReservationDetail = ReservationDto & { suggestedMonthlyCents: number };

/**
 * Adds `suggestedMonthlyCents` to a successful reservation `Result`, passing a
 * failure through untouched -- same shape as `withImageUrlsResult`.
 *
 * Composed here, at the HTTP boundary, rather than inside either domain
 * library: `@rm/domain-payments` (which owns the rule, see
 * `docs/business-rules/payments.md`, "Mensualidad sugerida") and
 * `@rm/domain-reservations` must not depend on each other in either
 * direction (see `payment-service.spec.ts`). The value is the one
 * `suggestedMonthlyForReservation` computes, never a second implementation.
 * It is only ever called after the reservation itself was loaded or created
 * for its owner, so it reads no reservation the caller could not already see.
 */
export async function withSuggestedMonthly(
  db: Db,
  result: Result<ReservationDto>
): Promise<Result<ReservationDetail>> {
  if (!result.ok) return result;
  const monthly = await suggestedMonthlyForReservation(db, result.value.id);
  if (!monthly.ok) return monthly;
  return ok({ ...result.value, suggestedMonthlyCents: monthly.value });
}
