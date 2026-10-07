import { listPaymentsForCustomer } from '@rm/domain-payments';
import { db } from '../../../../lib/db';
import { route } from '../../../../lib/http/route';

/**
 * Every payment of the authenticated customer, across all their
 * reservations, newest first (see `listPaymentsForCustomer`'s own doc
 * comment in `@rm/domain-payments`). No `permission` -- the scope is
 * ownership (`WHERE reservation.customerId = actor.userId`, inside the
 * domain query itself), not the RBAC catalogue.
 */
export const GET = route({
  handler: async ({ actor }) => listPaymentsForCustomer(db(), actor.userId),
});
