import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://rm:rm@localhost:5432/rm_dev',
  JWT_SECRET: 'x'.repeat(32),
  APP_BASE_URL: 'http://localhost:3000',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_ROOT: './storage',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(valid);
    expect(env.databaseUrl).toBe(valid.DATABASE_URL);
    expect(env.accessTokenTtlSeconds).toBe(900);
    expect(env.refreshTokenTtlDays).toBe(30);
    expect(env.storageDriver).toBe('local');
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
  });

  it('requires STORAGE_S3_BUCKET when the driver is s3', () => {
    expect(() =>
      loadEnv({ ...valid, STORAGE_DRIVER: 's3', STORAGE_LOCAL_ROOT: undefined })
    ).toThrow(/STORAGE_S3_BUCKET/);
  });
});
