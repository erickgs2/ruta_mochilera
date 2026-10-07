import { organizationProfileSchema, type OrganizationProfileContract } from '@rm/contracts';
import { organizationProfile, updateOrganizationProfile } from '@rm/domain-settings';
import { ok } from '@rm/shared-utils';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';

/** The agency details receipts print (Phase 2B, §4.6). */
export const GET = route({
  permission: 'settings.manage',
  handler: async () => ok(await organizationProfile(db())),
});

/** Only receipts generated from now on use the new details; issued ones keep theirs. */
export const PUT = route<OrganizationProfileContract, unknown>({
  permission: 'settings.manage',
  body: organizationProfileSchema,
  handler: async ({ actor, body }) => ok(await updateOrganizationProfile(db(), body, actor.userId)),
});
