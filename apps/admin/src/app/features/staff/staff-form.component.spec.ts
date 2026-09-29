import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
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

function configure(paramMap: Record<string, string> = {}): void {
  TestBed.configureTestingModule({
    imports: [StaffFormComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'staff', children: [] }]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: (key: string) => paramMap[key] ?? null } } },
      },
    ],
  });
}

describe('StaffFormComponent', () => {
  describe('create mode', () => {
    beforeEach(() => configure());

    it('exposes email and password controls', () => {
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);

      const component = fixture.componentInstance;
      expect(component.isEdit).toBe(false);
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
    beforeEach(() => configure({ userId: 'staff-1' }));

    it('has no email or password controls to submit, and loads the existing values', () => {
      const fixture = TestBed.createComponent(StaffFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);
      TestBed.inject(HttpTestingController).expectOne('/api/v1/staff').flush([existingStaff]);
      fixture.detectChanges();

      const component = fixture.componentInstance;
      expect(component.isEdit).toBe(true);
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
});
