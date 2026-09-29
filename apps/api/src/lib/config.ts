import { loadEnv, type AppEnv } from '@rm/shared-utils';

let cached: AppEnv | undefined;

export function config(): AppEnv {
  cached ??= loadEnv(process.env);
  return cached;
}
