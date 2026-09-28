import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';

/**
 * The database handle every domain service receives by injection.
 * It is an alias rather than a new type so that `libs/domain` never has to
 * know which Prisma version or driver adapter is underneath.
 */
export type Db = PrismaClient;

/**
 * A Prisma client usable both as the top-level handle and as the callback
 * argument of `db.$transaction(async (tx) => ...)`.
 *
 * `Prisma.TransactionClient` is `PrismaClient` minus `$transaction`,
 * `$connect` and `$disconnect` (Prisma's `ITXClientDenyList`): the model
 * delegates a helper actually needs are all still there, and a full `Db` is
 * structurally assignable to it, so callers pass either `db` or `tx` here
 * with no cast. A helper typed this way, unlike one typed `Db`, also cannot
 * call `$transaction` itself and silently nest one: the compiler removes
 * that possibility instead of a cast asserting it away.
 *
 * Use this for any domain helper that must run standalone or inside a
 * transaction (e.g. issuing a session as part of login and again as part of
 * refresh rotation); keep `Db` for the public entry points that own the
 * transaction boundary.
 */
export type DbTransactionClient = Prisma.TransactionClient;

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
