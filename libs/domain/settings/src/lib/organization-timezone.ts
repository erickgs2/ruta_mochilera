import type { DbTransactionClient } from '@rm/db';

const DEFAULT_TIMEZONE = 'America/Mexico_City';
const TIMEZONE_SETTING_KEY = 'organization.timezone';

/**
 * Reads the organisation's IANA timezone from `SystemSetting`, falling back
 * to the seed's own default when the row is missing -- e.g. a database that
 * has run migrations but never the seed. Calendar rules must never hardcode
 * a timezone (a workspace-wide constraint), so every date comparison that
 * needs "today" or "this calendar day" resolves it through here instead of a
 * literal.
 *
 * Used to live as four duplicated lines in `trips`, `reservations` and
 * `payments`: the only edge in the domain graph runs `trips -> reservations`,
 * and `payments` is a leaf neither of them imports, so sharing it from any
 * one of those three would have meant creating a dependency edge for four
 * lines, or in the `trips`/`reservations` direction, reinstating a cycle.
 * A tiny `@rm/db`-only leaf library -- the same shape as `@rm/domain-audit`
 * -- removes the dilemma: nobody's graph passes through `settings`, so
 * depending on it from any of the three creates no cycle.
 */
export async function organizationTimeZone(db: DbTransactionClient): Promise<string> {
  const setting = await db.systemSetting.findUnique({ where: { key: TIMEZONE_SETTING_KEY } });
  return typeof setting?.value === 'string' ? setting.value : DEFAULT_TIMEZONE;
}
