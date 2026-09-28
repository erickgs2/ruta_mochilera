import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    APP_BASE_URL: z.url(),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_ROOT: z.string().optional(),
    STORAGE_S3_BUCKET: z.string().optional(),
    STORAGE_S3_REGION: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.STORAGE_DRIVER === 'local' && !value.STORAGE_LOCAL_ROOT) {
      ctx.addIssue({ code: 'custom', message: 'STORAGE_LOCAL_ROOT is required when STORAGE_DRIVER is local' });
    }
    if (value.STORAGE_DRIVER === 's3' && (!value.STORAGE_S3_BUCKET || !value.STORAGE_S3_REGION)) {
      ctx.addIssue({ code: 'custom', message: 'STORAGE_S3_BUCKET and STORAGE_S3_REGION are required when STORAGE_DRIVER is s3' });
    }
  });

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  appBaseUrl: string;
  storageDriver: 'local' | 's3';
  storageLocalRoot?: string;
  storageS3Bucket?: string;
  storageS3Region?: string;
}

export function loadEnv(source: Record<string, string | undefined>): AppEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    jwtSecret: value.JWT_SECRET,
    accessTokenTtlSeconds: value.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: value.REFRESH_TOKEN_TTL_DAYS,
    appBaseUrl: value.APP_BASE_URL,
    storageDriver: value.STORAGE_DRIVER,
    storageLocalRoot: value.STORAGE_LOCAL_ROOT,
    storageS3Bucket: value.STORAGE_S3_BUCKET,
    storageS3Region: value.STORAGE_S3_REGION,
  };
}
