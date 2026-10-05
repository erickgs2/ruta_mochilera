import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { RegisterComponent } from './register.component';

const valid = {
  fullName: 'Ana Customer',
  email: 'ana@example.com',
  phone: '+52 55 1234 5678',
  birthDate: '1990-05-17',
  password: 'a-long-enough-password',
  acceptTerms: true,
};

function setup() {
  TestBed.configureTestingModule({
    imports: [RegisterComponent],
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
    keyedTranslations([
      'auth.validation.email',
      'auth.validation.birthDate',
      'errors.UNKNOWN',
      'errors.RATE_LIMITED',
    ])
  );
  const fixture = TestBed.createComponent(RegisterComponent);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, http: TestBed.inject(HttpTestingController) };
}

function isoDate(daysFromToday: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

describe('RegisterComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('rejects a malformed email before calling the API', async () => {
    const { fixture, component, http } = setup();
    component.form.setValue({ ...valid, email: 'ana@example' });

    await component.submit();
    fixture.detectChanges();

    http.expectNone('/api/v1/auth/register');
    expect(fixture.nativeElement.textContent).toContain(shown('auth.validation.email'));
  });

  it('rejects a birth date in the future before calling the API', async () => {
    const { fixture, component, http } = setup();
    component.form.setValue({ ...valid, birthDate: isoDate(1) });

    await component.submit();
    fixture.detectChanges();

    http.expectNone('/api/v1/auth/register');
    expect(fixture.nativeElement.textContent).toContain(shown('auth.validation.birthDate'));
  });

  it('rejects an impossible calendar date before calling the API', async () => {
    const { fixture, component, http } = setup();
    component.form.setValue({ ...valid, birthDate: '1990-02-31' });

    await component.submit();
    fixture.detectChanges();

    http.expectNone('/api/v1/auth/register');
    expect(fixture.nativeElement.textContent).toContain(shown('auth.validation.birthDate'));
  });

  it('takes the visitor to the verification-code screen for that email after registering', async () => {
    const { component, http } = setup();
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    component.form.setValue(valid);

    const submitted = component.submit();
    const request = http.expectOne('/api/v1/auth/register');
    expect(request.request.body).toEqual({
      email: valid.email,
      password: valid.password,
      fullName: valid.fullName,
      phone: valid.phone,
      birthDate: valid.birthDate,
      acceptTerms: true,
    });
    request.flush(null);
    await submitted;

    expect(navigate).toHaveBeenCalledWith(['/verify-email'], { queryParams: { email: valid.email } });
  });

  it('shows the translated message for a known error code', async () => {
    const { fixture, component, http } = setup();
    component.form.setValue(valid);

    const submitted = component.submit();
    http
      .expectOne('/api/v1/auth/register')
      .flush({ code: 'RATE_LIMITED', title: 'Too Many Requests' }, { status: 429, statusText: 'Too Many Requests' });
    await submitted;
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(shown('errors.RATE_LIMITED'));
  });

  it('never shows backend text: an unknown code renders the generic message, not the raw code', async () => {
    const { fixture, component, http } = setup();
    component.form.setValue(valid);

    const submitted = component.submit();
    http
      .expectOne('/api/v1/auth/register')
      .flush(
        { code: 'BRAND_NEW_CODE', title: 'Something the backend said', details: { reason: 'raw detail' } },
        { status: 422, statusText: 'Unprocessable Entity' }
      );
    await submitted;
    fixture.detectChanges();

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain(shown('errors.UNKNOWN'));
    expect(text).not.toContain('BRAND_NEW_CODE');
    expect(text).not.toContain('Something the backend said');
    expect(text).not.toContain('raw detail');
  });
});
