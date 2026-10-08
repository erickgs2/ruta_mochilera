import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';
import { parseReturnUrl, RETURN_URL_PARAM } from './return-url';

/**
 * Blocks navigation into the authenticated area when there is no session,
 * sending the visitor to `/login` instead. This is convenience for the
 * browser UI, not a security boundary: every API endpoint independently
 * checks the access token on every request, so a guard that failed to run
 * (or was bypassed) would still not grant access to any data.
 *
 * The attempted URL travels in `?returnUrl=` so the login, register and
 * verify screens can bring the visitor back to what they were doing.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) return true;
  const returnUrl = parseReturnUrl(state?.url);
  const queryParams = returnUrl && returnUrl !== '/' ? { [RETURN_URL_PARAM]: returnUrl } : undefined;
  return router.createUrlTree(['/login'], { queryParams });
};

/**
 * Hides a route from an actor without the given permission. This is
 * convenience, not security: the API checks the same permission
 * independently on every call a screen behind this guard would make, so
 * this guard only spares the user a screen that would fail anyway.
 */
export function permissionGuard(permission: string): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    if (!auth.isAuthenticated()) return router.createUrlTree(['/login']);
    return auth.hasPermission(permission) ? true : router.createUrlTree(['/forbidden']);
  };
}
