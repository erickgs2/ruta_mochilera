import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, finalize, map, Observable, of, shareReplay, switchMap, throwError } from 'rxjs';
import { AuthApi } from '@rm/api-client';
import { AuthService, type SessionUser } from './auth.service';

const REFRESH_PATH = '/api/v1/auth/refresh';

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

  const token = auth.accessToken();
  const authorized = token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request;

  return next(authorized).pipe(
    catchError((error: unknown) => {
      const isUnauthorized = error instanceof HttpErrorResponse && error.status === 401;
      // Never attempt to refresh the refresh call itself: that would be an infinite loop.
      if (!isUnauthorized || request.url.includes(REFRESH_PATH) || !auth.refreshToken()) {
        return throwError(() => error);
      }

      return refreshOnce(auth, api).pipe(
        switchMap((refreshed) => {
          if (!refreshed) {
            auth.clear();
            void router.navigate(['/login']);
            return throwError(() => error) as Observable<never>;
          }
          return next(request.clone({ setHeaders: { Authorization: `Bearer ${auth.accessToken()}` } }));
        })
      );
    })
  );
};

/** Starts a refresh call if none is in flight, otherwise returns the one already running. */
function refreshOnce(auth: AuthService, api: AuthApi): Observable<boolean> {
  inFlightRefresh ??= api.refresh(auth.refreshToken()!).pipe(
    map((response) => {
      auth.applyRefreshedSession(response.tokens.accessToken, response.tokens.refreshToken, response.user as SessionUser);
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
