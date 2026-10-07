import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { generateOtpCode, hashOtpCode, loadOtpSettings } from './otp';

describe('generateOtpCode / hashOtpCode', () => {
  it('generates a six-digit numeric code', () => {
    for (let i = 0; i < 50; i += 1) {
      const { code } = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('hashes the code deterministically, and the hash never equals the plain code', () => {
    const { code, codeHash } = generateOtpCode();
    expect(codeHash).toBe(hashOtpCode(code));
    expect(codeHash).not.toBe(code);
  });

  it('produces different codes across calls (not a fixed sequence)', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateOtpCode().code));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('loadOtpSettings', () => {
  const db = withTestDb();

  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(() => resetDatabase(db));

  afterAll(() => closeTestDb());

  it('falls back to the seed defaults (15 / 5 / 60 / 5) when SystemSetting rows are absent', async () => {
    const settings = await loadOtpSettings(db);
    expect(settings).toEqual({
      ttlMinutes: 15,
      maxAttempts: 5,
      resendCooldownSeconds: 60,
      maxResendsPerHour: 5,
    });
  });

  it('reads overrides from SystemSetting instead of the constants', async () => {
    await db.systemSetting.create({ data: { key: 'otp.ttl_minutes', value: 30 } });
    await db.systemSetting.create({ data: { key: 'otp.max_attempts', value: 3 } });
    await db.systemSetting.create({ data: { key: 'otp.resend_cooldown_seconds', value: 90 } });
    await db.systemSetting.create({ data: { key: 'otp.max_resends_per_hour', value: 2 } });

    const settings = await loadOtpSettings(db);
    expect(settings).toEqual({
      ttlMinutes: 30,
      maxAttempts: 3,
      resendCooldownSeconds: 90,
      maxResendsPerHour: 2,
    });
  });
});
