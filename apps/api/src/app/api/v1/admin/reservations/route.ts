import { listStaffReservationsQuerySchema } from '@rm/contracts';
import { listReservationsForStaff } from '@rm/domain-reservations';
import { fail } from '@rm/shared-utils';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

/**
 * The panel's reservation list (Task 19): every customer's reservations,
 * unresolved cancellation requests first -- the administrator's work queue.
 *
 * Under `/admin/` because `/reservations` is already the customer's own
 * resource, scoped by ownership; this one is scoped by the RBAC catalogue
 * instead, and a `CUSTOMER` actor never reaches it whatever roles they hold
 * (`requirePermission` refuses any actor that is not `STAFF`).
 *
 * The query string is validated by hand against
 * `listStaffReservationsQuerySchema`, the same object `registry.ts`
 * documents -- the pattern `GET /notifications` established, since `route()`
 * only validates JSON bodies.
 */
export const GET = route({
  permission: 'reservation.view',
  handler: async ({ request }) => {
    const params = new URL(request.url).searchParams;
    const parsed = listStaffReservationsQuerySchema.safeParse({
      tripId: params.get('tripId') ?? undefined,
      status: params.get('status') ?? undefined,
      cancellationPending: params.get('cancellationPending') ?? undefined,
    });
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      });
    }
    return listReservationsForStaff(db(), parsed.data);
  },
});
