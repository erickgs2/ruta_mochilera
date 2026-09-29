import { ok } from '@rm/shared-utils';
import { db } from '../../../../lib/db';
import { route } from '../../../../lib/http/route';

export const GET = route({
  handler: async ({ actor }) => {
    const user = await db().user.findUniqueOrThrow({
      where: { id: actor!.userId },
      include: { staffProfile: true, customerProfile: true },
    });
    return ok({
      id: user.id,
      email: user.email,
      type: user.type,
      locale: user.locale,
      fullName: user.staffProfile?.fullName ?? user.customerProfile?.fullName ?? '',
      permissions: actor!.permissions,
    });
  },
});
