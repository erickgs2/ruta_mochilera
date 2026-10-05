import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { LoginComponent } from './login.component';

const session = {
  user: { id: 'c1', email: 'ana@example.com', type: 'CUSTOMER', locale: 'es', fullName: 'Ana', permissions: [] },
  tokens: { accessToken: 'access-1', expiresInSeconds: 900 },
};

function setup() {
  localStorage.clear();
  TestBed.configureTestingModule({
    imports: [LoginComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
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
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    component.form.setValue({ email: 'ana@example.com', password: 'secret-password' });

    const submitted = component.submit();
    http.expectOne('/api/v1/auth/login').flush(session);
    await submitted;

    expect(navigate).toHaveBeenCalledWith(['/']);
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
