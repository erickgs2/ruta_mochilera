import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { RefreshTokenStore } from '@rm/auth-web';

/** Same name on both platforms deliberately -- there is only ever one refresh token per device, and this key never collides with anything else this app stores. */
const STORAGE_KEY = 'rm_refresh_token';

/**
 * Keychain (iOS) / Keystore-backed EncryptedSharedPreferences (Android) via
 * `@aparajita/capacitor-secure-storage`. This exists because Task 15 found,
 * on a real iOS Simulator, that the httpOnly refresh cookie
 * `apps/api/src/lib/http/refresh-cookie.ts` sets does not survive inside a
 * packaged Capacitor app: the WebView's origin (`capacitor://localhost` on
 * iOS, `https://localhost` on Android) is cross-origin from the API's real
 * origin, and `SameSite=Strict` forbids attaching the cookie cross-origin.
 * See `.superpowers/sdd/2026-10-03-fase-2a-reservas-y-pagos/task-15-report.md`
 * and `task-15b-report.md` for the full decision record.
 *
 * `requestHeaders()` answers from an in-memory cache, not a live Keychain
 * read, for a hard technical reason, not a convenience one:
 * `authInterceptor` (in `@rm/auth-web`) calls it on every single outgoing
 * request, synchronously,
 * before the HTTP call is made, because the existing single-flight refresh
 * logic depends on that timing staying synchronous (see the comment above
 * `inFlightRefresh` in `auth.interceptor.ts`). Capacitor's native bridge
 * has no synchronous API at all, so the cache has to be populated ahead of
 * time -- by `restore()`, called once from `app.config.ts` via
 * `provideAppInitializer`, before the app finishes bootstrapping -- and kept
 * current from then on by `persist()` and `clear()`.
 *
 * The one call site that ever reads the raw token value out of this class
 * into the rest of the page's JS is `requestHeaders()` itself, handing it
 * straight to an HTTP header on the way out -- and only for `/auth/refresh`
 * and `/auth/logout` (`includeRefreshToken`), never on an ordinary API
 * call. Nothing else in this app ever touches it, and it is never written
 * to `localStorage`, `sessionStorage`, or a plain cookie.
 */
export class NativeRefreshTokenStore implements RefreshTokenStore {
  private cached: string | null = null;

  /** Loads whatever Keychain/Keystore currently holds into the in-memory cache. Call once, before the app finishes bootstrapping (see `app.config.ts`). */
  async restore(): Promise<void> {
    try {
      this.cached = await SecureStorage.getItem(STORAGE_KEY);
    } catch {
      // A fresh install (nothing stored yet) and a genuine OS-level error
      // look the same from here: either way, there is no valid session to
      // resume, so the user simply sees the login screen -- not a crash.
      this.cached = null;
    }
  }

  requestHeaders({ includeRefreshToken }: { includeRefreshToken: boolean }): Record<string, string> {
    const headers: Record<string, string> = { 'X-Client-Platform': 'native' };
    if (includeRefreshToken && this.cached) headers['X-Refresh-Token'] = this.cached;
    return headers;
  }

  async persist(tokens: { refreshToken?: string }): Promise<void> {
    // `refreshToken` is only absent here if the server ever stopped
    // honouring `X-Client-Platform: native` -- defensive, not expected in
    // practice. Either way, a missing value must never overwrite a good
    // cached token with nothing.
    if (!tokens.refreshToken) return;
    this.cached = tokens.refreshToken;
    await SecureStorage.setItem(STORAGE_KEY, tokens.refreshToken);
  }

  async clear(): Promise<void> {
    this.cached = null;
    // The in-memory cache is cleared unconditionally above even if the
    // underlying Keychain/Keystore write fails -- a logged-out app must
    // never keep offering a dead token on its next request either way.
    await SecureStorage.removeItem(STORAGE_KEY).catch(() => undefined);
  }
}
