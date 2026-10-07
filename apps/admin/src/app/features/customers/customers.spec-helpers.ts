import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import type { EnvironmentProviders, Provider } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import type { SessionUser } from '@rm/auth-web';

export function staffWith(permissions: string[]): SessionUser {
  return { id: 'u1', email: 'desk@agency.test', type: 'STAFF', locale: 'es', fullName: 'Mostrador', permissions };
}

/** The providers every customers screen needs, with the dialog answering `dialogResult`. */
export function testProviders(dialogResult = true): { providers: (Provider | EnvironmentProviders)[]; dialogOpen: jest.Mock; snackBarOpen: jest.Mock } {
  const dialogOpen = jest.fn().mockReturnValue({ afterClosed: () => of(dialogResult) });
  const snackBarOpen = jest.fn();
  return {
    dialogOpen,
    snackBarOpen,
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: MatDialog, useValue: { open: dialogOpen } },
      { provide: MatSnackBar, useValue: { open: snackBarOpen } },
    ],
  };
}

export function customerDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cust-1',
    fullName: 'María Peña',
    email: 'maria@example.com',
    phone: '352 100 80 79',
    origin: 'BRANCH',
    activatedAt: null,
    invitedAt: '2026-10-01T10:00:00.000Z',
    hasPassword: false,
    createdAt: '2026-10-01T10:00:00.000Z',
    birthDate: '1990-05-17T00:00:00.000Z',
    locale: 'es',
    emailVerifiedAt: '2026-10-01T10:00:00.000Z',
    acceptedTermsAt: null,
    reservations: [],
    ...overrides,
  };
}
