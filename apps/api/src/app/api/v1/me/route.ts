import { describeUser } from '@rm/domain-identity';
import { ok } from '@rm/shared-utils';
import { db } from '../../../../lib/db';
import { route } from '../../../../lib/http/route';

export const GET = route({
  handler: async ({ actor }) => ok(await describeUser(db(), actor.userId)),
});
