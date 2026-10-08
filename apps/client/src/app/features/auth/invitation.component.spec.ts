import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { InvitationComponent } from './invitation.component';

const PASSWORD = 'a-brand-new-password';

async function open(url: string) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'invitation', component: InvitationComponent }]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation(
    'es',
    keyedTranslations(['auth.invitation.linkInvalid', 'auth.invitation.success', 'auth.validation.acceptTerms', 'errors.UNKNOWN'])
  );
  const harness = await RouterTestingHarness.create();
  const component = await harness.navigateByUrl(url, InvitationComponent);
  harness.detectChanges();
  return { harness, component, http: TestBed.inject(HttpTestingController) };
}

function text(harness: RouterTestingHarness): string {
  return harness.routeNativeElement?.textContent ?? '';
}

describe('InvitationComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('sets the password with a valid link and leads to sign in with the activated email', async () => {
    const { harness, component, http } = await open('/invitation?token=tok-123');
    component.form.setValue({ password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true });

    const submitted = component.submit();
    const request = http.expectOne('/api/v1/auth/invitation/accept');
    expect(request.request.body).toEqual({ token: 'tok-123', password: PASSWORD, acceptTerms: true });
    request.flush({ email: 'maria@example.com' });
    await submitted;
    harness.detectChanges();

    expect(text(harness)).toContain(shown('auth.invitation.success'));
    const link = harness.routeNativeElement!.querySelector('a[href^="/login"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/login?email=maria@example.com');
  });

  it('passes a same-app returnUrl on to the sign-in link, and drops an external one', async () => {
    for (const [returnUrl, href] of [
      ['/trips/ruta-oaxaca/reserve', '/login?email=maria@example.com&returnUrl=%2Ftrips%2Fruta-oaxaca%2Freserve'],
      ['https://evil.example/', '/login?email=maria@example.com'],
    ]) {
      TestBed.resetTestingModule();
      const { harness, component, http } = await open(`/invitation?token=tok-123&returnUrl=${encodeURIComponent(returnUrl)}`);
      component.form.setValue({ password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true });

      const submitted = component.submit();
      http.expectOne('/api/v1/auth/invitation/accept').flush({ email: 'maria@example.com' });
      await submitted;
      harness.detectChanges();

      const link = harness.routeNativeElement!.querySelector('a[href^="/login"]') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe(href);
    }
  });

  it('shows the translated invalid-link message when the token no longer works', async () => {
    const { harness, component, http } = await open('/invitation?token=used');
    component.form.setValue({ password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true });

    const submitted = component.submit();
    http.expectOne('/api/v1/auth/invitation/accept').flush({ code: 'TOKEN_INVALID' }, { status: 401, statusText: 'Unauthorized' });
    await submitted;
    harness.detectChanges();

    expect(text(harness)).toContain(shown('auth.invitation.linkInvalid'));
    expect(harness.routeNativeElement!.querySelector('form')).toBeNull();
  });

  it('does not send the form without accepting the terms', async () => {
    const { component, http } = await open('/invitation?token=tok-123');
    component.form.setValue({ password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: false });

    await component.submit();

    http.expectNone('/api/v1/auth/invitation/accept');
  });

  it('removes the token from the address bar', async () => {
    await open('/invitation?token=tok-123');

    expect(TestBed.inject(Router).url).toBe('/invitation');
  });
});
