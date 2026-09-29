import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import type { MatSlideToggleChange } from '@angular/material/slide-toggle';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { BehaviorSubject, of } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import { StaffFormComponent } from './staff-form.component';

const roles = [{ id: 'role-1', name: 'Seller', description: '', isSystem: false, permissionKeys: [], userCount: 1 }];

const existingStaff = {
  id: 'staff-1',
  email: 'ana@rutamochilera.test',
  fullName: 'Ana Perez',
  employeeCode: 'EMP-1',
  status: 'ACTIVE' as const,
  locale: 'es' as const,
  roleIds: ['role-1'],
};

const otherStaff = {
  id: 'staff-2',
  email: 'luis@rutamochilera.test',
  fullName: 'Luis Gomez',
  employeeCode: null,
  status: 'ACTIVE' as const,
  locale: 'en' as const,
  roleIds: [],
};

/**
 * Builds the TestBed for a given initial route param map and a stubbed
 * `MatDialog.open()` result (only exercised by the disable-confirmation
 * tests). `paramMap` is exposed as a `BehaviorSubject`, not a one-shot
 * snapshot: `StaffFormComponent` reads it reactively (see its class doc
 * comment), so a test can call `.next(...)` to simulate Angular's
 * route-reuse strategy re-using this same instance across two URLs of the
 * same parameterised route.
 */
function configure(initialParams: Record<string, string> = {}, dialogConfirmed = false): BehaviorSubject<ParamMap> {
  const paramMap$ = new BehaviorSubject(convertToParamMap(initialParams));
  TestBed.configureTestingModule({
    imports: [StaffFormComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'staff', children: [] }]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      { provide: MatDialog, useValue: { open: jest.fn().mockReturnValue({ afterClosed: () => of(dialogConfirmed) }) } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap(initialParams) }, paramMap: paramMap$ },
      },
    ],
  });
  return paramMap$;
}

describe('StaffFormComponent', () => {
  describe('create mode', () => {
    beforeEach(() => {
      configure();
    });

    it('exposes email and password controls', () => {
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);

      const component = fixture.componentInstance;
      expect(component.isEdit()).toBe(false);
      expect(component.form.controls.email.disabled).toBe(false);
      expect(component.form.controls.password.disabled).toBe(false);
    });

    it('requires the password confirmation to match', () => {
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);

      const component = fixture.componentInstance;
      component.form.controls.password.setValue('supersecret1');
      component.form.controls.confirmPassword.setValue('different');
      expect(component.form.hasError('passwordMismatch')).toBe(true);

      component.form.controls.confirmPassword.setValue('supersecret1');
      expect(component.form.hasError('passwordMismatch')).toBe(false);
    });

    it('omits employeeCode from the request when left blank', () => {
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);

      const component = fixture.componentInstance;
      component.form.controls.email.setValue('new@rutamochilera.test');
      component.form.controls.fullName.setValue('New Person');
      component.form.controls.locale.setValue('es');
      component.form.controls.password.setValue('supersecret1');
      component.form.controls.confirmPassword.setValue('supersecret1');
      component.form.controls.roleIds.setValue(['role-1']);
      component.save();

      const request = TestBed.inject(HttpTestingController).expectOne('/api/v1/staff');
      expect(request.request.body.employeeCode).toBeUndefined();
      request.flush({ ...existingStaff, id: 'new-staff', email: 'new@rutamochilera.test', employeeCode: null });
    });

    it('surfaces EMAIL_ALREADY_REGISTERED on the email field, not as a page-level error', () => {
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);

      const component = fixture.componentInstance;
      component.form.controls.email.setValue('taken@rutamochilera.test');
      component.form.controls.fullName.setValue('New Person');
      component.form.controls.locale.setValue('es');
      component.form.controls.password.setValue('supersecret1');
      component.form.controls.confirmPassword.setValue('supersecret1');
      component.save();

      const request = TestBed.inject(HttpTestingController).expectOne('/api/v1/staff');
      request.flush(
        { type: 'about:blank', title: 'Conflict', status: 409, code: 'EMAIL_ALREADY_REGISTERED' },
        { status: 409, statusText: 'Conflict' }
      );

      expect(component.form.controls.email.hasError('conflict')).toBe(true);
    });
  });

  describe('edit mode', () => {
    beforeEach(() => {
      configure({ userId: 'staff-1' });
    });

    it('has no email or password controls to submit, and loads the existing values', () => {
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);
      TestBed.inject(HttpTestingController).expectOne('/api/v1/staff').flush([existingStaff]);
      fixture.detectChanges();

      const component = fixture.componentInstance;
      expect(component.isEdit()).toBe(true);
      expect(component.form.controls.email.disabled).toBe(true);
      expect(component.form.controls.password.disabled).toBe(true);
      expect(component.form.controls.fullName.value).toBe('Ana Perez');
      expect(component.form.controls.employeeCode.value).toBe('EMP-1');
    });

    it('sends an update without email or password, omitting employeeCode when cleared', () => {
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);
      TestBed.inject(HttpTestingController).expectOne('/api/v1/staff').flush([existingStaff]);
      fixture.detectChanges();

      const component = fixture.componentInstance;
      component.form.controls.employeeCode.setValue('');
      component.save();

      const request = TestBed.inject(HttpTestingController).expectOne('/api/v1/staff/staff-1');
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).not.toHaveProperty('email');
      expect(request.request.body).not.toHaveProperty('password');
      expect(request.request.body.employeeCode).toBeUndefined();
      request.flush(existingStaff);
    });
  });

  describe('disabling an account', () => {
    // These exercise `onStatusToggle()` directly rather than dispatching a
    // real `mat-slide-toggle` DOM event: the behaviour under test is what the
    // handler does with the confirmation result, which is identical either way.
    function toggleOffEvent(): MatSlideToggleChange {
      return { checked: false, source: { checked: true } } as unknown as MatSlideToggleChange;
    }

    it('reverts the toggle and leaves the account ACTIVE when the confirmation is dismissed', () => {
      configure({ userId: 'staff-1' }, false);
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);
      TestBed.inject(HttpTestingController).expectOne('/api/v1/staff').flush([existingStaff]);
      fixture.detectChanges();

      const dialogOpen = TestBed.inject(MatDialog).open as jest.Mock;
      const component = fixture.componentInstance;
      const event = toggleOffEvent();
      component.onStatusToggle(event);

      expect(dialogOpen).toHaveBeenCalled();
      // Reverted immediately (the toggle is a controlled component driven by
      // `form.controls.status.value`) and the dismissed confirmation must not
      // have changed anything underneath it.
      expect(event.source.checked).toBe(true);
      expect(component.form.controls.status.value).toBe('ACTIVE');
    });

    it('commits DISABLED when the confirmation is accepted', () => {
      configure({ userId: 'staff-1' }, true);
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);
      TestBed.inject(HttpTestingController).expectOne('/api/v1/staff').flush([existingStaff]);
      fixture.detectChanges();

      const component = fixture.componentInstance;
      component.onStatusToggle(toggleOffEvent());

      expect(component.form.controls.status.value).toBe('DISABLED');
    });
  });

  describe('navigating between two accounts on the same route (route reuse)', () => {
    it('reloads the form for the new id instead of keeping the previous account', async () => {
      const paramMap$ = configure({ userId: 'staff-1' });
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      const httpMock = TestBed.inject(HttpTestingController);
      httpMock.expectOne('/api/v1/rbac/roles').flush(roles);
      httpMock.expectOne('/api/v1/staff').flush([existingStaff, otherStaff]);
      await fixture.whenStable();

      const component = fixture.componentInstance;
      expect(component.form.controls.fullName.value).toBe('Ana Perez');

      // Angular's default route-reuse strategy would reuse this exact
      // component instance for a sibling URL of the same parameterised
      // route -- simulate that by pushing a new `paramMap` rather than
      // creating a fresh fixture.
      paramMap$.next(convertToParamMap({ userId: 'staff-2' }));
      fixture.detectChanges();
      await fixture.whenStable();
      httpMock.expectOne('/api/v1/staff').flush([existingStaff, otherStaff]);
      await fixture.whenStable();

      expect(component.form.controls.fullName.value).toBe('Luis Gomez');
      expect(component.form.controls.employeeCode.value).toBe('');
    });
  });
});
