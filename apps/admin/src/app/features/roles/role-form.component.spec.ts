import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { RoleFormComponent } from './role-form.component';

const permissions = [
  { key: 'trip.view', category: 'trips', description: 'View trips' },
  { key: 'trip.create', category: 'trips', description: 'Create trips' },
  { key: 'staff.view', category: 'staff', description: 'View administrators' },
];

const systemRole = {
  id: 'role-1',
  name: 'Super Admin',
  description: 'Full access',
  isSystem: true,
  permissionKeys: ['trip.view'],
  userCount: 1,
};

/**
 * Builds the TestBed for a given route param map, since `RoleFormComponent`
 * reads `roleId` off `ActivatedRoute` to tell create and edit apart.
 */
function configure(paramMap: Record<string, string> = {}): void {
  TestBed.configureTestingModule({
    imports: [RoleFormComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'roles', children: [] }]),
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

describe('RoleFormComponent', () => {
  beforeEach(() => {
    configure();
  });

  it('groups the permission catalog by category', () => {
    const fixture = TestBed.createComponent(RoleFormComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/permissions').flush(permissions);
    fixture.detectChanges();

    const groups = fixture.componentInstance.groupedPermissions();
    expect(groups.map((group) => group.category)).toEqual(['staff', 'trips']);
    expect(groups.find((group) => group.category === 'trips')?.permissions).toHaveLength(2);
  });

  it('requires a name of at least two characters', () => {
    const fixture = TestBed.createComponent(RoleFormComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/permissions').flush(permissions);
    const form = fixture.componentInstance.form;

    form.controls.name.setValue('x');
    expect(form.controls.name.valid).toBe(false);

    form.controls.name.setValue('Seller');
    expect(form.controls.name.valid).toBe(true);
  });

  it('collects only the checked permission keys on submit', () => {
    const fixture = TestBed.createComponent(RoleFormComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/permissions').flush(permissions);
    fixture.detectChanges();

    const component = fixture.componentInstance;
    component.form.controls.name.setValue('Seller');
    component.form.controls.description.setValue('Sells trips');
    component.togglePermission('trip.view', true);
    component.togglePermission('trip.create', true);
    component.togglePermission('trip.create', false);

    expect(component.selectedPermissions()).toEqual(['trip.view']);
  });

  it('sends a POST to create a new role when there is no roleId in the route', () => {
    const fixture = TestBed.createComponent(RoleFormComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/permissions').flush(permissions);
    fixture.detectChanges();

    const component = fixture.componentInstance;
    component.form.controls.name.setValue('Seller');
    component.form.controls.description.setValue('Sells trips');
    component.togglePermission('trip.view', true);
    component.save();

    const request = TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      name: 'Seller',
      description: 'Sells trips',
      permissionKeys: ['trip.view'],
    });
    request.flush({ id: 'new-role', name: 'Seller', description: 'Sells trips', isSystem: false, permissionKeys: ['trip.view'], userCount: 0 });
  });

  describe('editing a system role', () => {
    beforeEach(() => {
      configure({ roleId: 'role-1' });
    });

    it('disables the whole form so a system role cannot be submitted into a rejection', () => {
      const fixture = TestBed.createComponent(RoleFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/permissions').flush(permissions);
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush([systemRole]);
      fixture.detectChanges();

      expect(fixture.componentInstance.form.disabled).toBe(true);
      expect(fixture.componentInstance.readOnly()).toBe(true);
    });
  });

  describe('a duplicate role name', () => {
    beforeEach(() => {
      configure();
    });

    it('surfaces CONFLICT on the name field instead of as a page-level error', () => {
      const fixture = TestBed.createComponent(RoleFormComponent);
      fixture.detectChanges();
      TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/permissions').flush(permissions);
      fixture.detectChanges();

      const component = fixture.componentInstance;
      component.form.controls.name.setValue('Seller');
      component.form.controls.description.setValue('Sells trips');
      component.save();

      const request = TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles');
      request.flush(
        { type: 'about:blank', title: 'Conflict', status: 409, code: 'CONFLICT', details: { field: 'name' } },
        { status: 409, statusText: 'Conflict' }
      );

      expect(component.form.controls.name.hasError('conflict')).toBe(true);
    });
  });
});
