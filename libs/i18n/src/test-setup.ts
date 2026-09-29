// Registers Angular's runtime JIT template compiler. Vite/vitest transpile
// TypeScript with esbuild only -- there is no ngtsc AOT pass -- so any spec
// that renders a component or directive template (e.g. via
// `TestBed.createComponent`) needs this import or Angular cannot compile it.
import '@angular/compiler';
import { COMPILER_OPTIONS, ErrorHandler, NgModule, provideZonelessChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

// This workspace runs Angular zoneless (see CLAUDE.md), so tests must
// initialize the same way `apps/admin` and `libs/ui` do under jest: no
// zone.js, an explicit `provideZonelessChangeDetection()`, and errors
// re-thrown instead of swallowed. `jest-preset-angular` ships a ready-made
// `setupZonelessTestEnv` helper for jest; this file is its vitest equivalent
// since `auth-web` runs on vitest (see libs/auth-web/vitest.config.mts).
@NgModule({
  providers: [
    provideZonelessChangeDetection(),
    {
      provide: ErrorHandler,
      useValue: {
        handleError: (error: unknown) => {
          throw error;
        },
      },
    },
  ],
})
class ZonelessTestModule {}

getTestBed().initTestEnvironment(
  [BrowserTestingModule, ZonelessTestModule],
  platformBrowserTesting([{ provide: COMPILER_OPTIONS, useValue: {}, multi: true }])
);
