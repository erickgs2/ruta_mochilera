import { InjectionToken } from '@angular/core';

/**
 * Where the refresh token lives once a session exists, abstracted behind
 * one interface so `AuthService` and `authInterceptor` never branch on
 * platform -- they call these methods uniformly and the concrete
 * implementation (bound once, at each application's composition root)
 * decides what actually happens.
 *
 * `WebRefreshTokenStore` below is the only implementation this library
 * ships, and it is a complete no-op: the browser path keeps relying
 * entirely on the httpOnly, Secure, SameSite=Strict cookie
 * `apps/api/src/lib/http/refresh-cookie.ts` sets, exactly as it always has.
 *
 * A second implementation exists in `apps/client` (not here, so this
 * platform-agnostic library never pulls in a Capacitor dependency): it
 * reads and writes Keychain (iOS) / Keystore (Android) through a native
 * secure-storage plugin. That implementation is necessary because Task 15
 * found the httpOnly cookie does not survive inside a packaged Capacitor
 * app -- a different origin (`capacitor://localhost`), and
 * `SameSite=Strict` forbids attaching a cookie cross-origin. See
 * `.superpowers/sdd/2026-10-03-fase-2a-reservas-y-pagos/task-15-report.md`
 * and `task-15b-report.md` for the full decision record.
 */
export interface RefreshTokenStore {
  /**
   * Extra headers `authInterceptor` attaches to an outgoing request so the
   * API knows which refresh-token transport this caller uses (see
   * `apps/api/src/lib/http/refresh-cookie.ts`'s `clientPlatform` and
   * `readRefreshToken`). Web: `{}` -- today's request shape, unchanged.
   *
   * `includeRefreshToken` is `true` only for the two calls that consume the
   * token (`/auth/refresh` and `/auth/logout`), decided by the interceptor
   * from the URL -- not from the platform, which it never looks at. The
   * refresh token is long-lived; attaching it to every API call would spread
   * it into every access log and proxy on the way for no benefit.
   *
   * Synchronous on purpose: the interceptor calls this before every request
   * and its single-flight refresh depends on that staying synchronous (see
   * the comment above `inFlightRefresh` in `auth.interceptor.ts`). A native
   * implementation therefore answers from an in-memory copy it loads once at
   * startup, never from a live Keychain/Keystore read.
   */
  requestHeaders(options: { includeRefreshToken: boolean }): Record<string, string>;

  /**
   * Called once a login or refresh response resolves, with that response's
   * `tokens`. Web: a true no-op -- the Set-Cookie header already delivered
   * the token to the browser's own cookie jar, and `refreshToken` here is
   * `undefined` besides (the server never puts it in a web response body).
   */
  persist(tokens: { refreshToken?: string }): Promise<void>;

  /**
   * Called on logout, and whenever a refresh attempt itself fails (a dead
   * token must not be retried after the app restarts). Web: a no-op -- the
   * server already cleared the cookie in its own response.
   */
  clear(): Promise<void>;
}

/** DI token for the active `RefreshTokenStore`. Bound once per application, at its composition root (`app.config.ts`); never resolved conditionally by consumer code. */
export const REFRESH_TOKEN_STORE = new InjectionToken<RefreshTokenStore>('REFRESH_TOKEN_STORE');

/** The default binding: today's cookie-only behaviour, completely unchanged. See the interface doc comment above. */
export class WebRefreshTokenStore implements RefreshTokenStore {
  requestHeaders(): Record<string, string> {
    return {};
  }

  async persist(): Promise<void> {
    // Intentionally empty: see the class doc comment.
  }

  async clear(): Promise<void> {
    // Intentionally empty: see the class doc comment.
  }
}
