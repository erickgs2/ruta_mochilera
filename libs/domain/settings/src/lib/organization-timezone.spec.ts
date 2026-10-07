import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { organizationTimeZone } from './organization-timezone';

const db = withTestDb();

describe('organizationTimeZone', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('falls back to America/Mexico_City when no SystemSetting row exists', async () => {
    await expect(organizationTimeZone(db)).resolves.toBe('America/Mexico_City');
  });

  it('returns the configured value when SystemSetting carries one', async () => {
    await db.systemSetting.create({
      data: { key: 'organization.timezone', value: 'Pacific/Kiritimati' },
    });

    await expect(organizationTimeZone(db)).resolves.toBe('Pacific/Kiritimati');
  });
});
