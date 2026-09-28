import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The database handle every domain service receives by injection.
 * It is an alias rather than a new type so that `libs/domain` never has to
 * know which Prisma version or driver adapter is underneath.
 */
export type Db = PrismaClient;

export interface CreatePrismaClientOptions {
  /**
   * PostgreSQL schema every generated query is qualified with. Defaults to
   * `public`. The integration test helpers use it to give each Vitest worker
   * its own isolated copy of the schema inside the same test database.
   */
  schema?: string;
}

/**
 * Builds a Prisma client bound to an explicit connection string.
 *
 * Prisma 7 no longer reads the URL from the schema: a driver adapter is
 * required, so the caller owns the connection string and the API app, the
 * seed and the test helpers can each point at a different database.
 */
export function createPrismaClient(
  databaseUrl: string,
  options: CreatePrismaClientOptions = {}
): Db {
  const adapter = new PrismaPg(
    { connectionString: databaseUrl },
    options.schema === undefined ? undefined : { schema: options.schema }
  );
  return new PrismaClient({ adapter });
}
