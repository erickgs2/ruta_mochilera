import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, finalize, map, Observable, of, shareReplay, switchMap, throwError } from 'rxjs';
import { AuthApi } from '@rm/api-client';
import { AuthService, type SessionUser } from './auth.service';
import { REFRESH_TOKEN_STORE, WebRefreshTokenStore, type RefreshTokenStore } from './refresh-token-store';

const REFRESH_PATH = '/api/v1/auth/refresh';
const LOGOUT_PATH = '/api/v1/auth/logout';

/**
 * The only two calls that consume the refresh token itself: the server
 * rotates it on one and revokes it on the other. Everything else
 * authenticates with the short-lived bearer token alone, so the store is
 * asked to add the refresh token (native only; the web store adds nothing)
 * just for these. Deciding by URL here is not platform branching -- the
 * interceptor asks the same question of whichever store it was given.
 */
function consumesRefreshToken(url: string): boolean {
  return url.includes(REFRESH_PATH) || url.includes(LOGOUT_PATH);
}

/**
 * Shared module-level state so a burst of requests that all fail with 401 at
 * roughly the same time triggers exactly one refresh call. Every request that
 * hits a 401 while a refresh is already in flight subscribes to this same
 * shared observable instead of starting its own -- see the "single-flight"
 * spec in `auth.interceptor.spec.ts`. It is built with plain RxJS (no
 * Promise/async-await) on purpose: `HttpTestingController.flush()` delivers
 * synchronously, and a Promise-based bridge would push the retry past a
 * microtask boundary the tests never wait for.
 */
let inFlightRefresh: Observable<boolean> | null = null;

/**
 * Attaches the bearer token to every request and, on a 401 (missing or
 * invalid token -- `TOKEN_INVALID`), refreshes the session exactly once and
 * retries. A 403 (`PERMISSION_DENIED`, an authenticated actor lacking a
 * permission) is deliberately NOT retried here: refreshing on 403 would loop
 * forever, since a new token does not grant a permission the actor's role
 * does not have.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const api = inject(AuthApi);
  const router = inject(Router);
  // `{ optional: true }`, same reasoning as `AuthService`'s own fallback:
  // `apps/admin` never provides this token, and must get the exact no-op
  // behaviour it would get if this concept did not exist.
  const store = inject(REFRESH_TOKEN_STORE, { optional: true }) ?? new WebRefreshTokenStore();

  const token = auth.accessToken();
  // `store.requestHeaders()` is synchronous and `{}` on the web -- attaching
  // it here never delays the request the way a Promise-based read would
  // (see the single-flight comment above `inFlightRefresh`: this whole file
  // depends on `HttpTestingController.flush()` staying synchronous).
  const storeHeaders = store.requestHeaders({ includeRefreshToken: consumesRefreshToken(request.url) });
  const headers = token ? { ...storeHeaders, Authorization: `Bearer ${token}` } : storeHeaders;
  const authorized = Object.keys(headers).length > 0 ? request.clone({ setHeaders: headers }) : request;

  return next(authorized).pipe(
    catchError((error: unknown) => {
      const isUnauthorized = error instanceof HttpErrorResponse && error.status === 401;
      // Never attempt to refresh the refresh call itself: that would be an
      // infinite loop. The refresh token itself is no longer readable here
      // (it lives in an httpOnly cookie, or -- native only -- inside
      // `store`) so "was there ever a session" is now judged from
      // `isAuthenticated()` -- a visitor who never logged in on this device
      // has no local session to refresh, cookie or not.
      if (!isUnauthorized || request.url.includes(REFRESH_PATH) || !auth.isAuthenticated()) {
        return throwError(() => error);
      }

      return refreshOnce(auth, api, store).pipe(
        switchMap((refreshed) => {
          if (!refreshed) {
            auth.clear();
            void router.navigate(['/login']);
            return throwError(() => error) as Observable<never>;
          }
          // Re-read rather than reusing `storeHeaders`: a native refresh
          // just rotated the token the store holds.
          const retryHeaders = {
            ...store.requestHeaders({ includeRefreshToken: consumesRefreshToken(request.url) }),
            Authorization: `Bearer ${auth.accessToken()}`,
          };
          return next(request.clone({ setHeaders: retryHeaders }));
        })
      );
    })
  );
};

/**
 * Starts a refresh call if none is in flight, otherwise returns the one
 * already running. `api.refresh()` itself still takes no argument: the
 * refresh token travels either as the httpOnly cookie `ApiClient`'s
 * `withCredentials` attaches automatically (web), or as the
 * `X-Refresh-Token` header `store.requestHeaders()` already put on this
 * very request above (native) -- either way, this function does not need to
 * know which.
 */
function refreshOnce(auth: AuthService, api: AuthApi, store: RefreshTokenStore): Observable<boolean> {
  inFlightRefresh ??= api.refresh().pipe(
    map((response) => {
      auth.applyRefreshedSession(response.tokens.accessToken, response.user as SessionUser);
      // Fire-and-forget: a web no-op (there is no `refreshToken` in a web
      // response body to persist), and native's write to Keychain/Keystore
      // need not block handing the already-rotated access token back to the
      // caller that triggered this refresh.
      void store.persist(response.tokens).catch(() => undefined);
      return true;
    }),
    catchError(() => of(false)),
    // Reset the shared state once this refresh settles so the *next* 401
    // (e.g. minutes later, after the new token itself expires) starts fresh.
    finalize(() => {
      inFlightRefresh = null;
    }),
    shareReplay(1)
  );
  return inFlightRefresh;
}
