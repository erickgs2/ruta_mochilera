import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { organizationProfile, updateOrganizationProfile } from './organization-profile';

const db = withTestDb();

describe('organizationProfile', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('falls back to the agency name and blank contact lines without settings', async () => {
    await expect(organizationProfile(db)).resolves.toEqual({
      name: 'La Ruta Mochilera',
      address: '',
      phone: '',
      website: '',
    });
  });

  it('reads the configured values', async () => {
    await db.systemSetting.createMany({
      data: [
        { key: 'organization.name', value: 'Casa Mochilera' },
        { key: 'organization.address', value: 'Mariano Jiménez 551 B' },
        { key: 'organization.phone', value: '352 100 80 79' },
        { key: 'organization.website', value: 'www.fb.com/larutamochilera' },
      ],
    });

    await expect(organizationProfile(db)).resolves.toEqual({
      name: 'Casa Mochilera',
      address: 'Mariano Jiménez 551 B',
      phone: '352 100 80 79',
      website: 'www.fb.com/larutamochilera',
    });
  });
});

describe('updateOrganizationProfile', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('saves the four details, trimmed, and audits the change', async () => {
    const staff = await db.user.create({ data: { email: 'admin@agency.test', type: 'STAFF' } });
    await db.systemSetting.create({ data: { key: 'organization.name', value: 'Antes' } });

    const saved = await updateOrganizationProfile(
      db,
      { name: ' Casa Mochilera ', address: 'Mariano Jiménez 551 B', phone: '352 100 80 79', website: 'www.fb.com/larutamochilera' },
      staff.id
    );

    expect(saved).toEqual({ name: 'Casa Mochilera', address: 'Mariano Jiménez 551 B', phone: '352 100 80 79', website: 'www.fb.com/larutamochilera' });
    await expect(organizationProfile(db)).resolves.toEqual(saved);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'settings.organization_updated' } });
    expect(audit).toMatchObject({ actorUserId: staff.id, before: expect.objectContaining({ name: 'Antes' }) });
  });
});
