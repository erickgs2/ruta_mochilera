import { createStaffRequestSchema, type CreateStaffRequest } from '@rm/contracts';
import { createStaff, listStaff } from '@rm/domain-staff';
import { db } from '../../../../lib/db';
import { route } from '../../../../lib/http/route';

export const GET = route({
  permission: 'staff.view',
  handler: async ({ request }) => {
    const search = new URL(request.url).searchParams.get('search') ?? undefined;
    return listStaff(db(), { search });
  },
});

export const POST = route<CreateStaffRequest, unknown>({
  permission: 'staff.manage',
  body: createStaffRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) => createStaff(db(), actor, body),
});
