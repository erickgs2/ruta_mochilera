import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService, type SessionUser } from '@rm/auth-web';
import { LanguageService } from '@rm/i18n';
import { ShellComponent } from './shell.component';

function userWith(locale: 'es' | 'en', fullName = 'Ana Ruiz'): SessionUser {
  return { id: 'u1', email: 'a@b.test', type: 'STAFF', locale, fullName, permissions: [] };
}

/**
 * `BreakpointObserver.observe` ultimately calls `window.matchMedia`, which
 * jsdom does not implement -- every spec that renders `ShellComponent` must
 * stub it, the same way `trips-list.component.spec.ts` does for the cards/
 * table breakpoint it reads from the same service.
 */
function configure(): void {
  TestBed.configureTestingModule({
    imports: [ShellComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'login', children: [] }]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: BreakpointObserver, useValue: { observe: () => of({ matches: true }) } },
    ],
  });
}

describe('ShellComponent', () => {
  beforeEach(() => localStorage.clear());

  it("shows the signed-in user's name in the toolbar", () => {
    configure();
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access-1', userWith('es', 'Ana Ruiz'));

    const fixture = TestBed.createComponent(ShellComponent);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Ana Ruiz');
  });

  it('shows no user name when there is no session', () => {
    configure();
    const fixture = TestBed.createComponent(ShellComponent);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.shell-user')).toBeNull();
  });

  describe('language synchronisation', () => {
    it("switches the active language to the signed-in user's locale on creation", async () => {
      configure();
      const auth = TestBed.inject(AuthService);
      const language = TestBed.inject(LanguageService);
      language.use('es');
      auth.setSessionForTesting('access-1', userWith('en'));

      const fixture = TestBed.createComponent(ShellComponent);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(language.current()).toBe('en');
    });

    it("does not touch the language when it already matches the user's locale", async () => {
      configure();
      const auth = TestBed.inject(AuthService);
      const language = TestBed.inject(LanguageService);
      language.use('es');
      auth.setSessionForTesting('access-1', userWith('es'));

      const fixture = TestBed.createComponent(ShellComponent);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(language.current()).toBe('es');
    });

    it('follows a later change to the session user -- e.g. a token refresh that carries an updated locale', async () => {
      // This is the scenario the component's own doc comment calls out:
      // "keeps the two in sync whenever the session's user record changes",
      // not only at construction time.
      configure();
      const auth = TestBed.inject(AuthService);
      const language = TestBed.inject(LanguageService);
      language.use('es');
      auth.setSessionForTesting('access-1', userWith('es'));

      const fixture = TestBed.createComponent(ShellComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(language.current()).toBe('es');

      auth.applyRefreshedSession('access-2', userWith('en'));
      fixture.detectChanges();
      await fixture.whenStable();

      expect(language.current()).toBe('en');
    });
  });

  describe('signing out', () => {
    it('clears the session and navigates to /login when the sign-out button is clicked', async () => {
      configure();
      const auth = TestBed.inject(AuthService);
      const router = TestBed.inject(Router);
      const navigateSpy = jest.spyOn(router, 'navigate').mockResolvedValue(true);
      auth.setSessionForTesting('access-1', userWith('es'));

      const fixture = TestBed.createComponent(ShellComponent);
      fixture.detectChanges();

      const signOutButton = (fixture.nativeElement as HTMLElement).querySelector(
        '.shell-sign-out'
      ) as HTMLButtonElement;
      expect(signOutButton).not.toBeNull();
      signOutButton.click();

      TestBed.inject(HttpTestingController).expectOne('/api/v1/auth/logout').flush(null);
      await fixture.whenStable();

      expect(auth.isAuthenticated()).toBe(false);
      expect(navigateSpy).toHaveBeenCalledWith(['/login']);
    });
  });
});
