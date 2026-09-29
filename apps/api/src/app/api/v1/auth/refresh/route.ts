import { refreshRequestSchema, type RefreshRequest } from '@rm/contracts';
import { refreshSession } from '@rm/domain-identity';
import { config } from '../../../../../lib/config';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

export const POST = route<RefreshRequest, unknown>({
  auth: 'public',
  body: refreshRequestSchema,
  handler: async ({ body, request }) =>
    refreshSession(db(), config(), {
      refreshToken: body.refreshToken,
      userAgent: request.headers.get('user-agent') ?? undefined,
    }),
});
