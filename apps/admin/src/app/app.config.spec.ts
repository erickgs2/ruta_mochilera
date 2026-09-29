import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from '@rm/auth-web';
import { LanguageService } from '@rm/i18n';
import { App } from './app';
import { appConfig } from './app.config';

/**
 * Every other spec in this workspace configures `TestBed` against a
 * hand-assembled provider list (a fake `AuthService`, `provideRouter([])`
 * with no real routes, etc.), and each of the three test harnesses
 * (`apps/admin`/`libs/ui` via jest, `libs/auth-web`/`libs/i18n` via vitest)
 * forces zoneless change detection explicitly in its own setup file. None of
 * that proves the *actual* `appConfig` the app bootstraps with -- the one in
 * `app.config.ts` -- is itself wired correctly, or that it agrees with
 * how it is tested.
 *
 * This spec uses `appConfig.providers` verbatim, so a provider that is
 * removed, reordered into a conflict, or made to depend on something the
 * real app injector does not have fails *this* test -- rather than only
 * surfacing when someone happens to run `nx serve admin` in a browser.
 */
describe('appConfig (the real production providers)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: appConfig.providers,
    });
  });

  it('resolves every core service the app depends on, from the exact providers app.config.ts declares', () => {
    expect(() => TestBed.inject(Router)).not.toThrow();
    expect(() => TestBed.inject(HttpClient)).not.toThrow();
    expect(() => TestBed.inject(AuthService)).not.toThrow();
    expect(() => TestBed.inject(LanguageService)).not.toThrow();
  });

  it('bootstraps the real root component through the real providers without throwing', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.componentInstance).toBeTruthy();
    expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();
  });
});
