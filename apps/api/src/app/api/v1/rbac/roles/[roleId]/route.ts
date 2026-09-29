import { roleInputSchema, type RoleInputDto } from '@rm/contracts';
import { deleteRole, updateRole } from '@rm/domain-rbac';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';

export const PUT = route<RoleInputDto, unknown>({
  permission: 'role.manage',
  body: roleInputSchema,
  handler: async ({ actor, body, params }) => updateRole(db(), actor, params['roleId'], body),
});

export const DELETE = route({
  permission: 'role.manage',
  successStatus: 204,
  handler: async ({ actor, params }) => deleteRole(db(), actor, params['roleId']),
});
