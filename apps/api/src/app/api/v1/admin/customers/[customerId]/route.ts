import { getCustomerForStaff } from '@rm/domain-customers';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';

/** One customer with their reservations, for the panel. */
export const GET = route({
  permission: 'customer.view',
  handler: async ({ params }) => getCustomerForStaff(db(), params['customerId'] as string),
});
