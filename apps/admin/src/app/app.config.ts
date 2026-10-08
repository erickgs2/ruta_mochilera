import { provideHttpClient, withInterceptors } from '@angular/common/http';
import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';
import { API_BASE_URL } from '@rm/api-client';
import { authInterceptor } from '@rm/auth-web';
import { provideI18n } from '@rm/i18n';
import { appRoutes } from './app.routes';
import { provideLocaleDateAdapter } from './shared/locale-date-adapter';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideAnimationsAsync(),
    // The trip form's `mat-datepicker` fields (departure, return, payment
    // deadline) need a `DateAdapter` in the injector; the native JS `Date`
    // adapter is enough since this panel has no need for a third-party
    // calendar library. This one reads and prints dates in the interface
    // language's order (dd/MM/yyyy in Spanish) instead of always month-first.
    provideLocaleDateAdapter(),
    { provide: API_BASE_URL, useValue: environment.apiBaseUrl },
    provideI18n(),
  ],
};
