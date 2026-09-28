import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The database handle every domain service receives by injection.
 * It is an alias rather than a new type so that `libs/domain` never has to
 * know which Prisma version or driver adapter is underneath.
 */
export type Db = PrismaClient;

/**
 * Builds a Prisma client bound to an explicit connection string.
 *
 * Prisma 7 no longer reads the URL from the schema: a driver adapter is
 * required, so the caller owns the connection string and the API app, the
 * seed and the test helpers can each point at a different database.
 */
export function createPrismaClient(databaseUrl: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
