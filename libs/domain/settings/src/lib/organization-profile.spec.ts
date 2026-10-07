import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { organizationProfile } from './organization-profile';

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
