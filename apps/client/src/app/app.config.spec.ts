import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from '@rm/auth-web';
import { LanguageService } from '@rm/i18n';
import { App } from './app';
import { appConfig } from './app.config';

/**
 * Same intent as `apps/admin/src/app/app.config.spec.ts`: use the real
 * `appConfig.providers` verbatim so a provider that is removed, reordered
 * into a conflict, or made to depend on something the real app injector
 * does not have fails here, not only when someone runs `nx serve client`.
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
