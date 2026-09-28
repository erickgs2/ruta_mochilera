/**
 * `@rm/db` is the only place in the workspace that may import Prisma.
 *
 * Prisma 7 generates its client into a project-owned directory instead of
 * publishing it under `@prisma/client`, so that directory is gitignored and
 * rebuilt by `pnpm db:generate`. Re-exporting it here keeps a single, stable
 * import path: nothing outside this library ever reaches into
 * `src/generated/prisma`.
 *
 * The generated `client` entry point is Prisma's own public surface. It carries
 * the `PrismaClient` class, the `Prisma` namespace (query argument types,
 * `Prisma.InputJsonValue`, error classes, `Prisma.sql`), every enum as both a
 * value and a type, the `$Enums` alias, and one row type per model
 * (`User`, `Trip`, `RefreshToken`, ...).
 */
export * from './generated/prisma/client';

export * from './lib/client';
