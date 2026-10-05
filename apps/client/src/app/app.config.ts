import { provideHttpClient, withInterceptors } from '@angular/common/http';
import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { API_BASE_URL } from '@rm/api-client';
import { authInterceptor } from '@rm/auth-web';
import { provideI18n } from '@rm/i18n';
import { appRoutes } from './app.routes';
import { environment } from '../environments/environment';

/**
 * Deliberately the same shape as `apps/admin/src/app/app.config.ts` (same
 * `authInterceptor`, same `API_BASE_URL` token). No `@rm/ui` providers here
 * (no `provideNativeDateAdapter`, no Material animations): this app never
 * imports that library -- see its `README.md` for why.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes),
    provideHttpClient(withInterceptors([authInterceptor])),
    { provide: API_BASE_URL, useValue: environment.apiBaseUrl },
    provideI18n(),
  ],
};
