import { updateStaffRequestSchema, type UpdateStaffRequest } from '@rm/contracts';
import { updateStaff } from '@rm/domain-staff';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

export const PUT = route<UpdateStaffRequest, unknown>({
  permission: 'staff.manage',
  body: updateStaffRequestSchema,
  handler: async ({ actor, body, params }) => updateStaff(db(), actor, params['userId'], body),
});
