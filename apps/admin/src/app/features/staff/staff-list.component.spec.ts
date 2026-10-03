import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService, type SessionUser } from '@rm/auth-web';
import { StaffListComponent } from './staff-list.component';

const staff = [
  {
    id: 'staff-1',
    email: 'ana@rutamochilera.test',
    fullName: 'Ana Perez',
    employeeCode: 'EMP-1',
    status: 'ACTIVE',
    locale: 'es',
    roleIds: [],
  },
  {
    id: 'staff-2',
    email: 'luis@rutamochilera.test',
    fullName: 'Luis Gomez',
    employeeCode: null,
    status: 'DISABLED',
    locale: 'en',
    roleIds: [],
  },
];

function userWith(permissions: string[]): SessionUser {
  return { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions };
}

function configure(): void {
  TestBed.configureTestingModule({
    imports: [StaffListComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'staff/new', children: [] }]),
      provideNoopAnimations(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
}

describe('StaffListComponent', () => {
  it('loads the initial list on creation', () => {
    configure();
    const fixture = TestBed.createComponent(StaffListComponent);
    fixture.detectChanges();

    const request = TestBed.inject(HttpTestingController).expectOne((req) => req.url === '/api/v1/staff');
    request.flush(staff);
    fixture.detectChanges();

    expect(fixture.componentInstance.staff()).toHaveLength(2);
  });

  it('debounces search input before calling the API again', () => {
    // This app runs zoneless (see `test-setup.ts`), so Angular's own
    // `fakeAsync`/`tick` -- which rely on zone.js patching timers -- are not
    // available here. `debounceTime` schedules through RxJS's async
    // scheduler, which itself sits on the global `setTimeout`, so Jest's own
    // fake timers control it just as well.
    jest.useFakeTimers();
    try {
      configure();
      const fixture = TestBed.createComponent(StaffListComponent);
      fixture.detectChanges();
      const httpMock = TestBed.inject(HttpTestingController);
      httpMock.expectOne((req) => req.url === '/api/v1/staff').flush(staff);

      fixture.componentInstance.searchControl.setValue('ana');
      jest.advanceTimersByTime(100);
      httpMock.expectNone((req) => req.url === '/api/v1/staff' && req.params.get('search') === 'ana');

      jest.advanceTimersByTime(300);
      const request = httpMock.expectOne(
        (req) => req.url === '/api/v1/staff' && req.params.get('search') === 'ana'
      );
      request.flush([staff[0]]);

      expect(fixture.componentInstance.staff()).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the "new administrator" action to a user with staff.manage', () => {
    configure();
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', userWith(['staff.manage']));

    const fixture = TestBed.createComponent(StaffListComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne((req) => req.url === '/api/v1/staff').flush(staff);
    fixture.detectChanges();

    const html = (fixture.nativeElement as HTMLElement).innerHTML;
    expect(html).toContain('staff-new-button');
  });

  it('hides the "new administrator" action from a user without staff.manage', () => {
    configure();
    const auth = TestBed.inject(AuthService);
    auth.setSessionForTesting('access', userWith(['staff.view']));

    const fixture = TestBed.createComponent(StaffListComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne((req) => req.url === '/api/v1/staff').flush(staff);
    fixture.detectChanges();

    const html = (fixture.nativeElement as HTMLElement).innerHTML;
    expect(html).not.toContain('staff-new-button');
  });
});
