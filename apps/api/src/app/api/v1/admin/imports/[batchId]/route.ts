import { getImportBatch } from '@rm/domain-imports';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';

/** One batch with its full report: the preview before applying, the result after. */
export const GET = route({
  permission: 'import.manage',
  handler: async ({ params }) => getImportBatch(db(), params['batchId'] as string),
});
