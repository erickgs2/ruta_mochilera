import { refreshRequestSchema, type RefreshRequest } from '@rm/contracts';
import { logout } from '@rm/domain-identity';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

export const POST = route<RefreshRequest, null>({
  auth: 'public',
  body: refreshRequestSchema,
  handler: async ({ body }) => logout(db(), { refreshToken: body.refreshToken }),
});
