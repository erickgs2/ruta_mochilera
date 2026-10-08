import { inject } from '@angular/core';
import { AuthService } from '@rm/auth-web';

/** Sections in nav order, each with the permission its route is guarded by in `app.routes.ts`. */
const LANDING_SECTIONS = [
  { path: '/trips', permission: 'trip.view' },
  { path: '/reservations', permission: 'reservation.view' },
  { path: '/customers', permission: 'customer.view' },
  { path: '/imports', permission: 'import.manage' },
  { path: '/staff', permission: 'staff.view' },
  { path: '/roles', permission: 'role.view' },
  { path: '/settings/organization', permission: 'settings.manage' },
] as const;

/** The first section the signed-in user may open, or `null` when their permissions allow none. */
export function firstAllowedSection(auth: AuthService): string | null {
  return LANDING_SECTIONS.find((section) => auth.hasPermission(section.permission))?.path ?? null;
}

/** Root redirect: the first allowed section, or `/forbidden` (which never redirects back) when there is none. */
export function landingRedirect(): string {
  return firstAllowedSection(inject(AuthService)) ?? '/forbidden';
}
