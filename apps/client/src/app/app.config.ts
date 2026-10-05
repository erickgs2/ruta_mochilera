import { provideHttpClient, withInterceptors } from '@angular/common/http';
import type { ApplicationConfig } from '@angular/core';
import { provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { API_BASE_URL } from '@rm/api-client';
import { authInterceptor, REFRESH_TOKEN_STORE, WebRefreshTokenStore } from '@rm/auth-web';
import { provideI18n } from '@rm/i18n';
import { NativeRefreshTokenStore } from './core/native-refresh-token-store';
import { appRoutes } from './app.routes';
import { environment } from '../environments/environment';

/**
 * Deliberately the same shape as `apps/admin/src/app/app.config.ts` (same
 * `authInterceptor`, same `API_BASE_URL` token). No `@rm/ui` providers here
 * (no `provideNativeDateAdapter`, no Material animations): this app never
 * imports that library -- see its `README.md` for why.
 *
 * Platform selection for the refresh-token transport (Task 15b) happens
 * exactly once, right here, via `Capacitor.isNativePlatform()` -- not
 * inside `AuthService`, `authInterceptor`, or any other consumer, all of
 * which call `RefreshTokenStore` uniformly regardless of which concrete
 * implementation this factory hands them. This one Angular bundle runs both
 * ways: as a plain web page during `nx serve client` / in CI, and inside
 * the packaged iOS/Android shell, so the choice cannot be made at build
 * time -- `Capacitor.isNativePlatform()` is Capacitor's own supported way
 * to tell those apart at runtime, and it reliably returns `false` in every
 * ordinary browser context (including this file's own Jest/jsdom tests;
 * see `app.config.spec.ts`).
 */
const nativeRefreshTokenStore = new NativeRefreshTokenStore();

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes),
    provideHttpClient(withInterceptors([authInterceptor])),
    { provide: API_BASE_URL, useValue: environment.apiBaseUrl },
    provideI18n(),
    {
      provide: REFRESH_TOKEN_STORE,
      useFactory: () => (Capacitor.isNativePlatform() ? nativeRefreshTokenStore : new WebRefreshTokenStore()),
    },
    // Loads whatever Keychain/Keystore already holds into the native
    // store's in-memory cache before the app finishes bootstrapping, so the
    // very first request this app makes (e.g. a guarded route's initial
    // `/me` call) already carries a session if one exists. A no-op on the
    // web path (`isNativePlatform()` false) and in every test that injects
    // `appConfig.providers` directly.
    provideAppInitializer(() => (Capacitor.isNativePlatform() ? nativeRefreshTokenStore.restore() : undefined)),
  ],
};
