import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { authGuard } from '@rm/auth-web';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { LoginComponent } from './login.component';

const session = {
  user: { id: 'c1', email: 'ana@example.com', type: 'CUSTOMER', locale: 'es', fullName: 'Ana', permissions: [] },
  tokens: { accessToken: 'access-1', expiresInSeconds: 900 },
};

function setup(query: Record<string, string> = {}) {
  localStorage.clear();
  TestBed.configureTestingModule({
    imports: [LoginComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations(['errors.INVALID_CREDENTIALS', 'errors.UNKNOWN'])
  );
  const fixture = TestBed.createComponent(LoginComponent);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, http: TestBed.inject(HttpTestingController) };
}

describe('LoginComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('signs in and goes to the catalogue', async () => {
    const { component, http } = setup();
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    component.form.setValue({ email: 'ana@example.com', password: 'secret-password' });

    const submitted = component.submit();
    http.expectOne('/api/v1/auth/login').flush(session);
    await submitted;

    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('goes back to the returnUrl after signing in', async () => {
    const { component, http } = setup({ returnUrl: '/trips/ruta-oaxaca/reserve' });
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    component.form.setValue({ email: 'ana@example.com', password: 'secret-password' });

    const submitted = component.submit();
    http.expectOne('/api/v1/auth/login').flush(session);
    await submitted;

    expect(navigate).toHaveBeenCalledWith('/trips/ruta-oaxaca/reserve');
  });

  it.each(['https://evil.example/phish', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
    'ignores the external returnUrl %s and goes to the catalogue',
    async (returnUrl) => {
      const { component, http } = setup({ returnUrl });
      const navigate = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      component.form.setValue({ email: 'ana@example.com', password: 'secret-password' });

      const submitted = component.submit();
      http.expectOne('/api/v1/auth/login').flush(session);
      await submitted;

      expect(component.returnUrl).toBeNull();
      expect(navigate).toHaveBeenCalledWith('/');
    }
  );

  it('keeps the returnUrl on the link to register', () => {
    const { fixture } = setup({ returnUrl: '/trips/ruta-oaxaca/reserve' });

    const link: HTMLAnchorElement = fixture.nativeElement.querySelector('a[href^="/register"]');
    expect(link.getAttribute('href')).toBe('/register?returnUrl=%2Ftrips%2Fruta-oaxaca%2Freserve');
  });

  it('shows the translated INVALID_CREDENTIALS message on a wrong password', async () => {
    const { fixture, component, http } = setup();
    component.form.setValue({ email: 'ana@example.com', password: 'wrong-password' });

    const submitted = component.submit();
    http
      .expectOne('/api/v1/auth/login')
      .flush({ code: 'INVALID_CREDENTIALS', title: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    await submitted;
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(shown('errors.INVALID_CREDENTIALS'));
  });

  it('links to the forgot-password screen', () => {
    const { fixture } = setup();

    const link: HTMLAnchorElement | null = fixture.nativeElement.querySelector('a[href="/forgot-password"]');
    expect(link).not.toBeNull();
  });
});

@Component({ template: 'reserve' })
class ReserveStub {}

describe('guard to login round trip', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('sends a signed-out visitor to login and back to the page they wanted', async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'trips/:slug/reserve', canActivate: [authGuard], component: ReserveStub },
          { path: 'login', component: LoginComponent },
        ]),
        provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
        { provide: API_BASE_URL, useValue: '' },
      ],
    });
    const harness = await RouterTestingHarness.create();

    const login = await harness.navigateByUrl('/trips/ruta-oaxaca/reserve', LoginComponent);
    expect(TestBed.inject(Router).url).toBe('/login?returnUrl=%2Ftrips%2Fruta-oaxaca%2Freserve');

    login.form.setValue({ email: 'ana@example.com', password: 'secret-password' });
    const submitted = login.submit();
    TestBed.inject(HttpTestingController).expectOne('/api/v1/auth/login').flush(session);
    await submitted;

    expect(TestBed.inject(Router).url).toBe('/trips/ruta-oaxaca/reserve');
  });
});
