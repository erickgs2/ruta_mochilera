import { listCreditEntries } from '@rm/domain-payments';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';

/** A customer's credit balance and every movement behind it (Phase 2B, §5.5). */
export const GET = route({
  permission: 'payment.view',
  handler: async ({ params }) => listCreditEntries(db(), params['customerId'] as string),
});
