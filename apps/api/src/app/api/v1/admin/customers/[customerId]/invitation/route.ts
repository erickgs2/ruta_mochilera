import { sendCustomerInvitation } from '@rm/domain-customers';
import { config } from '../../../../../../../lib/config';
import { db } from '../../../../../../../lib/db';
import { email } from '../../../../../../../lib/email';
import { route } from '../../../../../../../lib/http/route';

/** Sends (or re-sends) the activation invitation; each one invalidates the previous. */
export const POST = route({
  permission: 'customer.manage',
  handler: async ({ actor, params }) =>
    sendCustomerInvitation(
      db(),
      { email: email(), clientAppUrl: config().clientAppUrl },
      { customerId: params['customerId'] as string, actorId: actor.userId }
    ),
});
