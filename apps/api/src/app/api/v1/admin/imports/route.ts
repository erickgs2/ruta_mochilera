import { validateImportRequestSchema, type ValidateImportRequest } from '@rm/contracts';
import { listImportBatches, validateImport } from '@rm/domain-imports';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

/** The latest import batches, newest first (Phase 2B, §5.8). */
export const GET = route({
  permission: 'import.manage',
  handler: async () => listImportBatches(db()),
});

/**
 * Uploads a CSV and validates it row by row without writing anything but
 * the batch: the answer is the preview. Applying is a second, explicit step.
 */
export const POST = route<ValidateImportRequest, unknown>({
  permission: 'import.manage',
  body: validateImportRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) =>
    validateImport(db(), {
      type: body.type,
      fileName: body.fileName,
      content: body.content,
      sendEmails: body.sendEmails,
      actorId: actor.userId,
    }),
});
