import { getReservationForStaff } from '@rm/domain-reservations';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';

/**
 * One reservation, any customer's, for the panel's detail screen (Task 19).
 * The payment history is a separate endpoint (`./payments`) because it is
 * governed by a separate permission, `payment.view`.
 */
export const GET = route({
  permission: 'reservation.view',
  handler: async ({ params }) => getReservationForStaff(db(), params['reservationId'] as string),
});
