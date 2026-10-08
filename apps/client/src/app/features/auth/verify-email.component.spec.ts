import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { RESEND_COOLDOWN_SECONDS, VerifyEmailComponent } from './verify-email.component';

const CODE_SENT = { codeSent: true };

/** `state` is what `/register` passes along when it has just sent a code. */
async function open(url = '/verify-email?email=ana%40example.com', state?: Record<string, unknown>) {
  localStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'verify-email', component: VerifyEmailComponent }]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations([
      'auth.verify.success',
      'auth.verify.resent',
      'errors.OTP_INVALID',
      'errors.OTP_MAX_ATTEMPTS',
      'errors.UNKNOWN',
    ])
  );
  const harness = await RouterTestingHarness.create();
  let component: VerifyEmailComponent;
  if (state) {
    await TestBed.inject(Router).navigateByUrl(url, { state });
    component = harness.routeDebugElement!.componentInstance as VerifyEmailComponent;
  } else {
    component = await harness.navigateByUrl(url, VerifyEmailComponent);
  }
  harness.detectChanges();
  return { harness, component, http: TestBed.inject(HttpTestingController) };
}

function text(harness: RouterTestingHarness): string {
  return harness.routeNativeElement?.textContent ?? '';
}

function resendButton(harness: RouterTestingHarness): HTMLButtonElement {
  return harness.routeNativeElement!.querySelector('.verify-resend') as HTMLButtonElement;
}

async function submitCode(
  component: VerifyEmailComponent,
  http: HttpTestingController,
  code: string,
  reply: object | null,
  status = 200
) {
  component.form.controls.code.setValue(code);
  const submitted = component.submit();
  const request = http.expectOne('/api/v1/auth/verify-email');
  request.flush(reply, status === 200 ? undefined : { status, statusText: 'Error' });
  await submitted;
  return request;
}

describe('VerifyEmailComponent', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    jest.useRealTimers();
  });

  it('prefills the email from the query string and confirms a correct code', async () => {
    const { harness, component, http } = await open();

    expect(component.form.controls.email.value).toBe('ana@example.com');
    const request = await submitCode(component, http, '123456', null);
    harness.detectChanges();

    expect(request.request.body).toEqual({ email: 'ana@example.com', code: '123456' });
    expect(text(harness)).toContain(shown('auth.verify.success'));
  });

  it('refreshes the cached user after verifying, so a signed-in customer can reserve without signing in again', async () => {
    const { component, http } = await open();
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access-1', {
      id: 'c1',
      email: 'ana@example.com',
      type: 'CUSTOMER',
      locale: 'es',
      fullName: 'Ana',
      permissions: [],
      emailVerified: false,
    });

    await submitCode(component, http, '123456', null);
    http.expectOne('/api/v1/me').flush({ ...auth.user(), emailVerified: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(auth.user()?.emailVerified).toBe(true);
    expect(auth.accessToken()).toBe('access-1');
  });

  it('does not call /me after verifying when nobody is signed in on this device', async () => {
    const { component, http } = await open();

    await submitCode(component, http, '123456', null);

    http.expectNone('/api/v1/me');
  });

  it('does not call the API for a code that is not six digits', async () => {
    const { component, http } = await open();
    component.form.controls.code.setValue('12ab');

    await component.submit();

    http.expectNone('/api/v1/auth/verify-email');
  });

  it('shows the OTP_INVALID message for a wrong code', async () => {
    const { harness, component, http } = await open();

    await submitCode(component, http, '000000', { code: 'OTP_INVALID', title: 'x' }, 422);
    harness.detectChanges();

    expect(text(harness)).toContain(shown('errors.OTP_INVALID'));
    expect(text(harness)).not.toContain(shown('auth.verify.success'));
  });

  it('shows the OTP_MAX_ATTEMPTS message once attempts run out', async () => {
    const { harness, component, http } = await open();

    await submitCode(component, http, '000000', { code: 'OTP_MAX_ATTEMPTS', title: 'x' }, 422);
    harness.detectChanges();

    expect(text(harness)).toContain(shown('errors.OTP_MAX_ATTEMPTS'));
  });

  it('never shows backend text: an unknown code renders the generic message, not the raw code', async () => {
    const { harness, component, http } = await open();

    await submitCode(component, http, '000000', { code: 'BRAND_NEW_CODE', title: 'Backend sentence' }, 422);
    harness.detectChanges();

    expect(text(harness)).toContain(shown('errors.UNKNOWN'));
    expect(text(harness)).not.toContain('BRAND_NEW_CODE');
    expect(text(harness)).not.toContain('Backend sentence');
  });

  it('keeps the resend button disabled during the cooldown and re-enables it on its own', async () => {
    jest.useFakeTimers();
    const { harness } = await open(undefined, CODE_SENT);

    // The registration that brought the visitor here just sent a code.
    expect(resendButton(harness).disabled).toBe(true);

    jest.advanceTimersByTime((RESEND_COOLDOWN_SECONDS - 1) * 1000);
    harness.detectChanges();
    expect(resendButton(harness).disabled).toBe(true);

    jest.advanceTimersByTime(1000);
    harness.detectChanges();
    expect(resendButton(harness).disabled).toBe(false);
  });

  it('lets the visitor resend at once when no code was just sent (arriving from the reserve invitation)', async () => {
    jest.useFakeTimers();
    const { harness, component, http } = await open('/verify-email?email=ana%40example.com&returnUrl=%2Ftrips%2Fx%2Freserve');

    expect(resendButton(harness).disabled).toBe(false);
    expect(component.cooldownLeft()).toBe(0);

    const resent = component.resend();
    http.expectOne('/api/v1/auth/resend-code').flush(null);
    await resent;
    harness.detectChanges();

    // Sending a code is what starts the cooldown.
    expect(resendButton(harness).disabled).toBe(true);
  });

  it('sends a signed-in customer back to the returnUrl once the email is verified', async () => {
    const { harness, component, http } = await open('/verify-email?email=ana%40example.com&returnUrl=%2Ftrips%2Fx%2Freserve%3Fa%3D1');
    TestBed.inject(AuthService).setSessionForTesting('access-1', {
      id: 'c1',
      email: 'ana@example.com',
      type: 'CUSTOMER',
      locale: 'es',
      fullName: 'Ana',
      permissions: [],
      emailVerified: false,
    });

    await submitCode(component, http, '123456', null);
    http.expectOne('/api/v1/me').flush({ ...TestBed.inject(AuthService).user(), emailVerified: true });
    harness.detectChanges();

    const link = harness.routeNativeElement!.querySelector('.verify-continue') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/trips/x/reserve?a=1');
  });

  it('keeps the returnUrl on the sign-in link for a visitor who is not signed in', async () => {
    const { harness, component, http } = await open('/verify-email?email=ana%40example.com&returnUrl=%2Ftrips%2Fx%2Freserve');
    await submitCode(component, http, '123456', null);
    harness.detectChanges();
    const link = harness.routeNativeElement!.querySelector('a[href^="/login"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/login?returnUrl=%2Ftrips%2Fx%2Freserve');
  });

  it('ignores an external returnUrl', async () => {
    const { component } = await open('/verify-email?email=ana%40example.com&returnUrl=https%3A%2F%2Fevil.example%2F');

    expect(component.returnUrl).toBeNull();
    expect(component.returnTree).toBeNull();
  });

  it('resending a code starts the cooldown again', async () => {
    jest.useFakeTimers();
    const { harness, component, http } = await open(undefined, CODE_SENT);
    jest.advanceTimersByTime(RESEND_COOLDOWN_SECONDS * 1000);
    harness.detectChanges();

    const resent = component.resend();
    const request = http.expectOne('/api/v1/auth/resend-code');
    expect(request.request.body).toEqual({ email: 'ana@example.com' });
    request.flush(null);
    await resent;
    harness.detectChanges();

    expect(text(harness)).toContain(shown('auth.verify.resent'));
    expect(resendButton(harness).disabled).toBe(true);

    jest.advanceTimersByTime(RESEND_COOLDOWN_SECONDS * 1000);
    harness.detectChanges();
    expect(resendButton(harness).disabled).toBe(false);
  });
});
