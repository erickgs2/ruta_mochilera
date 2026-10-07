import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { setConfig, config } from '../../../../lib/config';
import { POST as googleRoute } from './oauth/google/route';
import { POST as appleRoute } from './oauth/apple/route';

const db = withTestDb();

function post(handler: typeof googleRoute, body: unknown) {
  return handler(
    new Request('http://localhost/api/v1/auth/oauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

describe('social login endpoints', () => {
  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    setConfig(undefined);
    await closeTestDb();
  });

  describe('POST /auth/oauth/google', () => {
    it('answers PROVIDER_DISABLED (503), never a 500, when GOOGLE_OAUTH_CLIENT_ID is unconfigured', async () => {
      // This workspace's own `.env` ships no Google/Apple credentials at
      // all (see Task 13's report): `config()` already resolves
      // `googleOauthClientId` to `undefined` with no override needed here,
      // which is exactly the state this test exists to pin down.
      expect(config().googleOauthClientId).toBeFalsy();

      const response = await post(googleRoute, { idToken: 'irrelevant-because-disabled' });

      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe('PROVIDER_DISABLED');
    });

    it('returns 422 when idToken is missing', async () => {
      const response = await post(googleRoute, {});
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('VALIDATION_FAILED');
    });

    it('rejects a non-JSON content type the same way every other public auth route does', async () => {
      const response = await googleRoute(
        new Request('http://localhost/api/v1/auth/oauth/google', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ idToken: 'x' }),
        })
      );
      expect(response.status).toBe(415);
    });
  });

  describe('POST /auth/oauth/apple', () => {
    it('answers PROVIDER_DISABLED (503), never a 500, when APPLE_OAUTH_CLIENT_ID is unconfigured', async () => {
      expect(config().appleOauthClientId).toBeFalsy();

      const response = await post(appleRoute, { idToken: 'irrelevant-because-disabled' });

      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe('PROVIDER_DISABLED');
    });

    it('returns 422 when idToken is missing', async () => {
      const response = await post(appleRoute, {});
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe('VALIDATION_FAILED');
    });
  });
});
