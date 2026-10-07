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
 * `Prisma.TransactionClient` is `PrismaClient` minus `$connect`, `$disconnect`,
 * `$on`, `$use` and `$extends` (Prisma's `ITXClientDenyList` — verified against
 * the runtime's own `denylist` array, not assumed). Note that `$transaction`
 * is *not* in that list: a value typed `DbTransactionClient` can still call
 * `.$transaction(...)` and open a nested transaction. This type does not
 * guard against that; it only fixes the parameter-typing problem below.
 *
 * The model delegates a helper actually needs are all still present, and a
 * full `Db` is structurally assignable to `DbTransactionClient` (`Omit` only
 * drops properties, it doesn't forbid extra ones), so callers pass either
 * `db` or `tx` to a helper typed this way with no cast.
 *
 * The reverse assignment does NOT hold: `DbTransactionClient` is not
 * assignable to `Db`, because it is genuinely missing `$connect`,
 * `$disconnect`, `$on` and `$extends`. Consequence for callers: a helper
 * typed `DbTransactionClient` can only pass its client on to other helpers
 * that are themselves typed `Db | DbTransactionClient`-compatible (i.e. typed
 * `DbTransactionClient`, or narrower) — never to one typed `Db`. Passing it to
 * a `Db`-typed helper is a real type error to fix by retyping that helper's
 * parameter (if it too can run inside a transaction) or by keeping the
 * `DbTransactionClient` helper's *callers* on the hook for such helpers
 * instead of trying to route through it. Do not reach for a cast here — see
 * Task 7 for a case where a helper (`describeUser`) was mistakenly typed
 * `DbTransactionClient` although every call site only ever passes the root
 * `Db`; the fix was to retype it `Db`, not to cast.
 *
 * Use `DbTransactionClient` for any domain helper that must run standalone or
 * inside a transaction (e.g. issuing a session as part of login and again as
 * part of refresh rotation); keep `Db` for the public entry points that own
 * the transaction boundary, and for any helper that only ever runs outside
 * one.
 */
export type DbTransactionClient = Prisma.TransactionClient;

export interface CreatePrismaClientOptions {
  /**
   * PostgreSQL schema every query is resolved against. Defaults to `public`.
   * The integration test helpers use it to give each Vitest worker its own
   * isolated copy of the schema inside the same test database.
   */
  schema?: string;
  /** Upper bound of the `pg` pool behind this client. Defaults to the driver's own (10). */
  poolMax?: number;
}

/**
 * Throws unless `schema` is a PostgreSQL schema name this workspace is willing
 * to drop into SQL and into a connection startup string unquoted.
 *
 * Lowercase on purpose, not merely "safe characters". An unquoted identifier
 * is case-folded to lowercase by PostgreSQL, so accepting `MySchema` here
 * would silently resolve to `myschema` and fail to match a schema actually
 * created as `"MySchema"` -- a mismatch that would surface as "relation does
 * not exist" far from its cause. Rejecting the name outright is the honest
 * answer; a caller that truly needs a mixed-case schema has to quote it
 * everywhere, which is a different design.
 *
 * The single definition both callers share: this file, building the
 * `search_path` startup option, and the test harness, naming each worker's
 * schema.
 */
export function assertSchemaIdentifier(schema: string): void {
  if (!/^[a-z0-9_]+$/.test(schema)) {
    throw new Error(`Refusing to use "${schema}" as a schema name: expected [a-z0-9_]+`);
  }
}

/**
 * Builds the libpq startup option that puts `schema` on the connection's
 * `search_path`.
 *
 * The driver adapter's own `schema` option only qualifies the SQL Prisma
 * *generates*; a `$queryRaw` naming a table without a schema is resolved by
 * the server's `search_path`, which otherwise stays `public`. Domain code
 * does issue such raw statements -- `lockTripForCapacity`'s
 * `SELECT ... FOR UPDATE` is the first -- and a test pointed at a worker
 * schema would have quietly read and locked rows in `public` instead, which
 * is the worst possible failure mode for a lock: silent, and green.
 *
 * The name is interpolated into a startup string, where quoting would not
 * save it anyway (a space splits the option), so it is validated rather than
 * escaped.
 *
 * Exported so the test harness's query-counting client, which builds its own
 * adapter to wire up Prisma's `log` events, resolves raw SQL against the
 * same schema as every other client instead of restating the string.
 */
export function searchPathStartupOption(schema: string): string {
  assertSchemaIdentifier(schema);
  return `-c search_path=${schema}`;
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
    {
      connectionString: databaseUrl,
      ...(options.schema === undefined ? {} : { options: searchPathStartupOption(options.schema) }),
      ...(options.poolMax === undefined ? {} : { max: options.poolMax }),
    },
    options.schema === undefined ? undefined : { schema: options.schema }
  );
  return new PrismaClient({ adapter });
}
