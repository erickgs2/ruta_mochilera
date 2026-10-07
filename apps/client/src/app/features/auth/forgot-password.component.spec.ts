import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { ForgotPasswordComponent } from './forgot-password.component';

function setup() {
  TestBed.configureTestingModule({
    imports: [ForgotPasswordComponent],
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
    keyedTranslations(['auth.forgot.sent', 'auth.validation.email', 'errors.RATE_LIMITED', 'errors.UNKNOWN'])
  );
  const fixture = TestBed.createComponent(ForgotPasswordComponent);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, http: TestBed.inject(HttpTestingController) };
}

describe('ForgotPasswordComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('requests a reset link and shows the same neutral confirmation whatever the email', async () => {
    const { fixture, component, http } = setup();
    component.form.setValue({ email: 'ana@example.com' });

    const submitted = component.submit();
    const request = http.expectOne('/api/v1/auth/forgot-password');
    expect(request.request.body).toEqual({ email: 'ana@example.com' });
    request.flush(null);
    await submitted;
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(shown('auth.forgot.sent'));
  });

  it('rejects a malformed email before calling the API', async () => {
    const { fixture, component, http } = setup();
    component.form.setValue({ email: 'not-an-email' });

    await component.submit();
    fixture.detectChanges();

    http.expectNone('/api/v1/auth/forgot-password');
    expect(fixture.nativeElement.textContent).toContain(shown('auth.validation.email'));
  });

  it('shows the translated message when rate limited', async () => {
    const { fixture, component, http } = setup();
    component.form.setValue({ email: 'ana@example.com' });

    const submitted = component.submit();
    http
      .expectOne('/api/v1/auth/forgot-password')
      .flush({ code: 'RATE_LIMITED', title: 'x' }, { status: 429, statusText: 'Too Many Requests' });
    await submitted;
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(shown('errors.RATE_LIMITED'));
    expect(fixture.nativeElement.textContent).not.toContain(shown('auth.forgot.sent'));
  });
});
