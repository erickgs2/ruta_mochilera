import { createStorage, type StorageProvider } from '@rm/storage';
import { config } from './config';

let cached: StorageProvider | undefined;

export function storage(): StorageProvider {
  cached ??= createStorage(config());
  return cached;
}

/**
 * Test-only seam, mirroring `setDb` in `./db.ts`: overrides the singleton
 * every route handler resolves through `storage()`.
 *
 * Without this, `storage()` would build its provider from `config()`, whose
 * `storageLocalRoot` is the developer's own `STORAGE_LOCAL_ROOT` (relative to
 * whatever the process's working directory happens to be) -- not a location
 * the integration suite should be writing real files to or cleaning up.
 * `apps/api/src/app/api/v1/trips/[tripId]/images/images.integration.spec.ts`
 * points this at a throwaway directory under the OS temp folder instead.
 */
export function setStorage(provider: StorageProvider | undefined): void {
  cached = provider;
}
