import { requestImportApply } from '@rm/domain-imports';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';
import { queue } from '../../../../../../../lib/queue';

/**
 * Confirms a validated batch. The rows are applied by the worker; the panel
 * follows the batch until it is APPLIED.
 */
export const POST = route({
  permission: 'import.manage',
  successStatus: 202,
  handler: async ({ actor, params }) =>
    requestImportApply(db(), await queue(), { batchId: params['batchId'] as string, actorId: actor.userId }),
});
