import { listPaymentsForReservation } from '@rm/domain-payments';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';

/**
 * One reservation's payment history, for the panel's detail screen (Task 19).
 * Gated on `payment.view` -- not `reservation.view` -- because the catalogue
 * already separates who sees money from who sees reservations; the detail
 * screen only asks for this when the viewer holds it.
 */
export const GET = route({
  permission: 'payment.view',
  handler: async ({ params }) => listPaymentsForReservation(db(), params['reservationId'] as string),
});
