import { listCreditEntries } from '@rm/domain-payments';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

/** The authenticated customer's own credit, read-only (Phase 2B, §5.5). */
export const GET = route({
  handler: async ({ actor }) => listCreditEntries(db(), actor.userId),
});
