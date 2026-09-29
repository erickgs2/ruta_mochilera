import { roleInputSchema, type RoleInputDto } from '@rm/contracts';
import { createRole, listRoles } from '@rm/domain-rbac';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

export const GET = route({
  permission: 'role.view',
  handler: async () => listRoles(db()),
});

export const POST = route<RoleInputDto, unknown>({
  permission: 'role.manage',
  body: roleInputSchema,
  successStatus: 201,
  handler: async ({ actor, body }) => createRole(db(), actor, body),
});
