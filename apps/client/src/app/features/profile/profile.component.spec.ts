import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { customer } from '../../testing/reservation-fixtures';
import { ProfileComponent } from './profile.component';

const profile = { fullName: 'Ana Pérez', phone: '5512345678', email: 'ana@example.com', photoUrl: null };

function setup() {
  localStorage.clear();
  TestBed.configureTestingModule({
    imports: [ProfileComponent],
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
    keyedTranslations(['profile.saved', 'auth.validation.fullName', 'errors.VALIDATION_FAILED', 'errors.UNKNOWN'])
  );
  TestBed.inject(AuthService).setSessionForTesting('access-1', customer());
  const fixture = TestBed.createComponent(ProfileComponent);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/me/profile').flush(profile);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, http, element: fixture.nativeElement as HTMLElement };
}

describe('ProfileComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the email as text only: there is no way to edit it here', () => {
    const { component, element } = setup();

    expect(element.querySelector('.profile-email')?.textContent).toContain('ana@example.com');
    expect(element.querySelector('input[type="email"]')).toBeNull();
    expect(element.querySelector('input[formControlName="email"]')).toBeNull();
    expect(Object.keys(component.form.controls).sort()).toEqual(['fullName', 'phone']);
  });

  it('saves name and phone, and never sends an email', async () => {
    const { fixture, component, http, element } = setup();
    component.form.setValue({ fullName: 'Ana López', phone: '5598765432' });

    const saved = component.save();
    const request = http.expectOne('/api/v1/me/profile');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ fullName: 'Ana López', phone: '5598765432' });
    request.flush({ ...profile, fullName: 'Ana López', phone: '5598765432' });
    await saved;
    fixture.detectChanges();

    expect(element.textContent).toContain(shown('profile.saved'));
  });

  it('validates the name before calling the API', async () => {
    const { fixture, component, http, element } = setup();
    component.form.setValue({ fullName: 'Al', phone: '5512345678' });

    await component.save();
    fixture.detectChanges();

    http.expectNone('/api/v1/me/profile');
    expect(element.textContent).toContain(shown('auth.validation.fullName'));
  });

  it('uploads a new photo and shows it', async () => {
    const { fixture, component, http, element } = setup();
    const file = new File(['bytes'], 'me.png', { type: 'image/png' });

    const uploaded = component.uploadPhoto(file);
    const request = http.expectOne('/api/v1/me/profile/photo');
    expect((request.request.body as FormData).get('file')).toBe(file);
    request.flush({ ...profile, photoUrl: 'http://localhost/api/v1/files/customers/c1/new.png' });
    await uploaded;
    fixture.detectChanges();

    expect(element.querySelector('img.profile-photo')?.getAttribute('src')).toBe('http://localhost/api/v1/files/customers/c1/new.png');
  });

  it('shows a refused photo as a translated error, not the raw code', async () => {
    const { fixture, component, http, element } = setup();

    const uploaded = component.uploadPhoto(new File(['x'], 'x.png'));
    http
      .expectOne('/api/v1/me/profile/photo')
      .flush({ code: 'VALIDATION_FAILED', title: 'x', details: { field: 'contentType' } }, { status: 422, statusText: 'Unprocessable Entity' });
    await uploaded;
    fixture.detectChanges();

    expect(element.textContent).toContain(shown('errors.VALIDATION_FAILED'));
  });

  it('signing out clears the session and returns to the public catalogue', async () => {
    const { component, http } = setup();
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const signedOut = component.signOut();
    http.expectOne('/api/v1/auth/logout').flush(null);
    await signedOut;

    expect(TestBed.inject(AuthService).isAuthenticated()).toBe(false);
    expect(localStorage.getItem('rm.session')).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  it('links to my reservations and to the inbox', () => {
    const { element } = setup();

    expect(element.querySelector('a[href="/reservations"]')).not.toBeNull();
    expect(element.querySelector('a[href="/inbox"]')).not.toBeNull();
  });
});
