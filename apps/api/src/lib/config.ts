import { loadEnv, type AppEnv } from '@rm/shared-utils';

let cached: AppEnv | undefined;

export function config(): AppEnv {
  cached ??= loadEnv(process.env);
  return cached;
}

/**
 * Test-only seam, mirroring `setDb` in `./db.ts` and `setStorage` in
 * `./storage.ts`: overrides the singleton every caller resolves through
 * `config()`.
 *
 * Without this, a suite could never exercise a branch that depends on a
 * setting different from this machine's own `.env` (e.g.
 * `STORAGE_DRIVER=local`) -- see the files route's integration suite, which
 * uses this to prove the route refuses when `storageDriver` is `'s3'`.
 */
export function setConfig(value: AppEnv | undefined): void {
  cached = value;
}
