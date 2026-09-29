import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { BehaviorSubject } from 'rxjs';
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

const roleOne = {
  id: 'role-1',
  name: 'Seller',
  description: 'Sells trips',
  isSystem: false,
  permissionKeys: ['trip.view'],
  userCount: 0,
};

const roleTwo = {
  id: 'role-2',
  name: 'Support',
  description: 'Handles support',
  isSystem: false,
  permissionKeys: ['trip.create'],
  userCount: 0,
};

/**
 * Builds the TestBed for a given route param map, since `RoleFormComponent`
 * reads `roleId` off `ActivatedRoute` to tell create and edit apart.
 *
 * `paramMap` is exposed as a `BehaviorSubject`, not a one-shot snapshot: the
 * component reads it reactively (see the class doc comment on why), so a
 * test can call `.next(...)` on the returned subject to simulate Angular's
 * route-reuse strategy re-using this same component instance across two
 * URLs of the same parameterised route.
 */
function configure(initialParams: Record<string, string> = {}): BehaviorSubject<ParamMap> {
  const paramMap$ = new BehaviorSubject(convertToParamMap(initialParams));
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
        useValue: { snapshot: { paramMap: convertToParamMap(initialParams) }, paramMap: paramMap$ },
      },
    ],
  });
  return paramMap$;
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

  it('renders the permission catalogue through translation keys, never the raw API prose', () => {
    // `Permission.category`/`.description` from the backend are stable,
    // English, developer-facing labels (see `PERMISSIONS` in
    // `@rm/domain-rbac`), not presentation -- the same rule error codes
    // already follow. This asserts the template actually resolves
    // `permissions.<key>.label` / `.description` / `permissions.categories.<category>`
    // rather than falling back to printing the API's own strings.
    const fixture = TestBed.createComponent(RoleFormComponent);
    fixture.detectChanges();
    TestBed.inject(TranslateService).setTranslation('es', {
      permissions: {
        categories: { trips: 'Viajes (ES)' },
        trip: { view: { label: 'Ver viajes (ES)', description: 'Descripción traducida (ES)' } },
      },
    });
    TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/permissions').flush(permissions);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Viajes (ES)');
    expect(text).toContain('Ver viajes (ES)');
    expect(text).toContain('Descripción traducida (ES)');
    // The raw English strings the fake API response carries must never leak through.
    expect(text).not.toContain('View trips');
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

  describe('navigating between two roles on the same route (route reuse)', () => {
    it('reloads the form for the new id instead of keeping the previous role', async () => {
      const paramMap$ = configure({ roleId: 'role-1' });
      const fixture = TestBed.createComponent(RoleFormComponent);
      fixture.detectChanges();
      const httpMock = TestBed.inject(HttpTestingController);
      httpMock.expectOne('/api/v1/rbac/permissions').flush(permissions);
      httpMock.expectOne('/api/v1/rbac/roles').flush([roleOne, roleTwo]);
      await fixture.whenStable();

      const component = fixture.componentInstance;
      expect(component.form.controls.name.value).toBe('Seller');

      // Angular's default route-reuse strategy would reuse this exact
      // component instance for a sibling URL of the same parameterised
      // route -- simulate that by pushing a new `paramMap` rather than
      // creating a fresh fixture.
      paramMap$.next(convertToParamMap({ roleId: 'role-2' }));
      fixture.detectChanges();
      await fixture.whenStable();
      httpMock.expectOne('/api/v1/rbac/roles').flush([roleOne, roleTwo]);
      await fixture.whenStable();

      expect(component.form.controls.name.value).toBe('Support');
      expect(component.selectedPermissions()).toEqual(['trip.create']);
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
