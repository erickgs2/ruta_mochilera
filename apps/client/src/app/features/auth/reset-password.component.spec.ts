import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { ResetPasswordComponent } from './reset-password.component';

const NEW_PASSWORD = 'a-brand-new-password';

async function open(url: string) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'reset-password', component: ResetPasswordComponent }]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations([
      'auth.reset.linkInvalid',
      'auth.reset.success',
      'auth.validation.password',
      'auth.validation.passwordMismatch',
      'errors.TOKEN_INVALID',
      'errors.RATE_LIMITED',
      'errors.UNKNOWN',
    ])
  );
  const harness = await RouterTestingHarness.create();
  const component = await harness.navigateByUrl(url, ResetPasswordComponent);
  harness.detectChanges();
  return { harness, component, http: TestBed.inject(HttpTestingController) };
}

function text(harness: RouterTestingHarness): string {
  return harness.routeNativeElement?.textContent ?? '';
}

async function submit(
  harness: RouterTestingHarness,
  component: ResetPasswordComponent,
  http: HttpTestingController,
  reply: object | null,
  status = 200
) {
  component.form.setValue({ newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  const submitted = component.submit();
  const request = http.expectOne('/api/v1/auth/reset-password');
  request.flush(reply, status === 200 ? undefined : { status, statusText: 'Error' });
  await submitted;
  harness.detectChanges();
  return request;
}

describe('ResetPasswordComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the invalid-link state, and no form, when the link carries no token', async () => {
    const { harness, http } = await open('/reset-password');

    expect(text(harness)).toContain(shown('auth.reset.linkInvalid'));
    expect(harness.routeNativeElement!.querySelector('form')).toBeNull();
    http.expectNone('/api/v1/auth/reset-password');
  });

  it('rejects a password shorter than 10 characters before calling the API', async () => {
    const { harness, component, http } = await open('/reset-password?token=tok-123');
    component.form.setValue({ newPassword: 'short', confirmPassword: 'short' });

    await component.submit();
    harness.detectChanges();

    http.expectNone('/api/v1/auth/reset-password');
    expect(text(harness)).toContain(shown('auth.validation.password'));
  });

  it('rejects a password longer than 128 characters before calling the API', async () => {
    const { harness, component, http } = await open('/reset-password?token=tok-123');
    const tooLong = 'x'.repeat(129);
    component.form.setValue({ newPassword: tooLong, confirmPassword: tooLong });

    await component.submit();
    harness.detectChanges();

    http.expectNone('/api/v1/auth/reset-password');
    expect(text(harness)).toContain(shown('auth.validation.password'));
  });

  it('rejects a confirmation that does not match before calling the API', async () => {
    const { harness, component, http } = await open('/reset-password?token=tok-123');
    component.form.setValue({ newPassword: NEW_PASSWORD, confirmPassword: `${NEW_PASSWORD}-typo` });

    await component.submit();
    harness.detectChanges();

    http.expectNone('/api/v1/auth/reset-password');
    expect(text(harness)).toContain(shown('auth.validation.passwordMismatch'));
  });

  it('sends the token from the link with the new password, then confirms and points to sign in', async () => {
    const { harness, component, http } = await open('/reset-password?token=tok-123');

    const request = await submit(harness, component, http, null);

    expect(request.request.body).toEqual({ token: 'tok-123', newPassword: NEW_PASSWORD });
    expect(text(harness)).toContain(shown('auth.reset.success'));
    expect(harness.routeNativeElement!.querySelector('a[href="/login"]')).not.toBeNull();
    expect(harness.routeNativeElement!.querySelector('form')).toBeNull();
  });

  it('shows the invalid-link message for TOKEN_INVALID, not the session-expired one', async () => {
    const { harness, component, http } = await open('/reset-password?token=used-token');

    await submit(harness, component, http, { code: 'TOKEN_INVALID', title: 'Unauthorized' }, 401);

    expect(text(harness)).toContain(shown('auth.reset.linkInvalid'));
    expect(text(harness)).not.toContain(shown('errors.TOKEN_INVALID'));
    expect(text(harness)).not.toContain(shown('auth.reset.success'));
  });

  it('shows the translated message for any other known code', async () => {
    const { harness, component, http } = await open('/reset-password?token=tok-123');

    await submit(harness, component, http, { code: 'RATE_LIMITED', title: 'x' }, 429);

    expect(text(harness)).toContain(shown('errors.RATE_LIMITED'));
  });

  it('never shows backend text: an unknown code renders the generic message, not the raw code', async () => {
    const { harness, component, http } = await open('/reset-password?token=tok-123');

    await submit(harness, component, http, { code: 'BRAND_NEW_CODE', title: 'Backend sentence' }, 422);

    expect(text(harness)).toContain(shown('errors.UNKNOWN'));
    expect(text(harness)).not.toContain('BRAND_NEW_CODE');
    expect(text(harness)).not.toContain('Backend sentence');
  });
});
