import type { DbTransactionClient } from '@rm/db';

/** What a receipt prints about the agency (Phase 2B, §4.6). Edited from the panel. */
export interface OrganizationProfile {
  name: string;
  address: string;
  phone: string;
  website: string;
}

export const ORGANIZATION_PROFILE_KEYS = {
  name: 'organization.name',
  address: 'organization.address',
  phone: 'organization.phone',
  website: 'organization.website',
} as const satisfies Record<keyof OrganizationProfile, string>;

/**
 * Falls back to the agency's name and blank contact lines for a database
 * that has run migrations but never the seed -- a receipt can still be
 * drawn, it just says less.
 */
const DEFAULT_PROFILE: OrganizationProfile = {
  name: 'La Ruta Mochilera',
  address: '',
  phone: '',
  website: '',
};

export async function organizationProfile(db: DbTransactionClient): Promise<OrganizationProfile> {
  const rows = await db.systemSetting.findMany({
    where: { key: { in: Object.values(ORGANIZATION_PROFILE_KEYS) } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const read = (field: keyof OrganizationProfile): string => {
    const value = byKey.get(ORGANIZATION_PROFILE_KEYS[field]);
    return typeof value === 'string' ? value : DEFAULT_PROFILE[field];
  };
  return { name: read('name'), address: read('address'), phone: read('phone'), website: read('website') };
}
