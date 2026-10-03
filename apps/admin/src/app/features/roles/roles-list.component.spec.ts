import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService, type SessionUser } from '@rm/auth-web';
import { RolesListComponent } from './roles-list.component';

const roles = [
  { id: 'role-1', name: 'Seller', description: 'Sells trips', isSystem: false, permissionKeys: ['trip.view'], userCount: 0 },
  { id: 'role-2', name: 'Super Admin', description: 'Full access', isSystem: true, permissionKeys: ['trip.view'], userCount: 3 },
];

function userWith(permissions: string[]): SessionUser {
  return { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions };
}

describe('RolesListComponent', () => {
  let dialogOpen: jest.Mock;
  let snackBarOpen: jest.Mock;

  function configure(dialogResult: boolean): void {
    dialogOpen = jest.fn().mockReturnValue({ afterClosed: () => of(dialogResult) });
    snackBarOpen = jest.fn();
    TestBed.configureTestingModule({
      imports: [RolesListComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'roles/new', children: [] }]),
        provideNoopAnimations(),
        provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
        { provide: API_BASE_URL, useValue: '' },
        { provide: MatDialog, useValue: { open: dialogOpen } },
        { provide: MatSnackBar, useValue: { open: snackBarOpen } },
      ],
    });
  }

  it('shows the "new role" action and per-row edit/delete actions to a user with role.manage', () => {
    configure(false);
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', userWith(['role.manage']));

    const fixture = TestBed.createComponent(RolesListComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);
    fixture.detectChanges();

    const html = (fixture.nativeElement as HTMLElement).innerHTML;
    expect(html).toContain('role-new-button');
    expect(html).toContain('role-delete-button');
  });

  it('hides the "new role" action and per-row edit/delete actions from a user without role.manage', () => {
    configure(false);
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', userWith(['role.view']));

    const fixture = TestBed.createComponent(RolesListComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/v1/rbac/roles').flush(roles);
    fixture.detectChanges();

    const html = (fixture.nativeElement as HTMLElement).innerHTML;
    expect(html).not.toContain('role-new-button');
    expect(html).not.toContain('role-delete-button');
  });

  it('does not call deleteRole when the confirmation dialog is dismissed', () => {
    configure(false);
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', userWith(['role.manage']));

    const fixture = TestBed.createComponent(RolesListComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne('/api/v1/rbac/roles').flush(roles);
    fixture.detectChanges();

    fixture.componentInstance.delete(roles[0]);

    expect(dialogOpen).toHaveBeenCalled();
    httpMock.expectNone('/api/v1/rbac/roles/role-1');
  });

  it('calls deleteRole when the confirmation dialog is accepted, and reloads the list', () => {
    configure(true);
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', userWith(['role.manage']));

    const fixture = TestBed.createComponent(RolesListComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne('/api/v1/rbac/roles').flush(roles);
    fixture.detectChanges();

    fixture.componentInstance.delete(roles[0]);

    const deleteRequest = httpMock.expectOne('/api/v1/rbac/roles/role-1');
    expect(deleteRequest.request.method).toBe('DELETE');
    deleteRequest.flush(null);

    httpMock.expectOne('/api/v1/rbac/roles').flush(roles);
  });

  it('shows the userCount the backend sent with ROLE_IN_USE, not a generic message', () => {
    configure(true);
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', userWith(['role.manage']));
    TestBed.inject(TranslateService).setTranslation('es', {
      errors: { ROLE_IN_USE: 'Tiene {{userCount}} usuarios asignados.' },
    });

    const fixture = TestBed.createComponent(RolesListComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne('/api/v1/rbac/roles').flush(roles);
    fixture.detectChanges();

    fixture.componentInstance.delete(roles[1]);

    const deleteRequest = httpMock.expectOne('/api/v1/rbac/roles/role-2');
    deleteRequest.flush(
      { type: 'about:blank', title: 'Conflict', status: 409, code: 'ROLE_IN_USE', details: { userCount: 3 } },
      { status: 409, statusText: 'Conflict' }
    );

    // The administrator sees the actual count (3), not just "some users" --
    // that is the difference between "I'll go fix that" and "I'll leave it".
    expect(snackBarOpen).toHaveBeenCalledWith('Tiene 3 usuarios asignados.', undefined, { duration: 6000 });
    // And the list is not silently reloaded on failure.
    httpMock.expectNone('/api/v1/rbac/roles');
  });
});
