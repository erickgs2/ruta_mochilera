import { PERMISSIONS } from '@rm/domain-rbac';
import { ok } from '@rm/shared-utils';
import { route } from '../../../../../lib/http/route';

export const GET = route({
  permission: 'role.view',
  handler: async () => ok(PERMISSIONS),
});
