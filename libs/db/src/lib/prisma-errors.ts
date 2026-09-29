/**
 * Returns the name of the violated unique index when `error` is Prisma's
 * unique-constraint failure (P2002), and `undefined` for anything else.
 *
 * Asserting on this rather than on `rejects.toThrow()` is what makes a
 * constraint test fail for the right reason: a connection error, a validation
 * error or a violation of a *different* unique index all return `undefined`.
 *
 * Note for Prisma 7: with a driver adapter the classic `meta.target` is no
 * longer populated. The violated index arrives inside the adapter error, which
 * is why this helper exists instead of an inline property read.
 *
 * Lives in `@rm/db` proper rather than under `@rm/db/testing` even though the
 * doc comment above reads test-first: domain services (e.g. `role-service`'s
 * `createRole`/`updateRole`) need it too, to turn a race-condition unique
 * violation into the same `CONFLICT` a pre-check returns. `@rm/db/testing`
 * computes a per-worker schema name at module load and is unsafe to import
 * from production code for that reason; this file has no such side effect.
 */
export function uniqueViolationIndex(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, meta } = error as { code?: unknown; meta?: unknown };
  if (code !== 'P2002' || typeof meta !== 'object' || meta === null) return undefined;
  const cause = (meta as { driverAdapterError?: { cause?: unknown } }).driverAdapterError?.cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const index = (cause as { constraint?: { index?: unknown } }).constraint?.index;
  return typeof index === 'string' ? index : undefined;
}
