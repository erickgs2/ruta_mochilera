import type { AppEnv } from '@rm/shared-utils';
import { LocalFileStorage } from './local-file-storage';
import { S3Storage } from './s3-storage';
import type { StorageProvider } from './storage-provider';

/** Reads a driver-specific env value, failing fast with a clear message if it is missing. */
function requireEnvValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable for storage: ${name}`);
  }
  return value;
}

/** Chooses the implementation from the environment. Nothing else in the app branches on the driver. */
export function createStorage(env: AppEnv): StorageProvider {
  if (env.storageDriver === 's3') {
    const bucket = requireEnvValue(env.storageS3Bucket, 'STORAGE_S3_BUCKET');
    const region = requireEnvValue(env.storageS3Region, 'STORAGE_S3_REGION');
    return new S3Storage(bucket, region, `https://${bucket}.s3.${region}.amazonaws.com`);
  }
  const root = requireEnvValue(env.storageLocalRoot, 'STORAGE_LOCAL_ROOT');
  return new LocalFileStorage(root, `${env.appBaseUrl}/api/v1/files`);
}
