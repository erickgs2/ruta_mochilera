import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '@rm/auth-web';
import { staffWith, testProviders } from '../customers/customers.spec-helpers';
import { OrganizationSettingsComponent } from './organization-settings.component';

const URL = '/api/v1/admin/settings/organization';
const profile = { name: 'La Ruta Mochilera', address: 'Mariano Jiménez 551 B', phone: '352 100 80 79', website: 'www.fb.com/larutamochilera' };

describe('OrganizationSettingsComponent', () => {
  afterEach(() => localStorage.clear());

  it('loads the details and saves the edited ones', () => {
    const setup = testProviders();
    TestBed.configureTestingModule({ imports: [OrganizationSettingsComponent], providers: setup.providers });
    TestBed.inject(AuthService).setSessionForTesting('access', staffWith(['settings.manage']));
    const fixture = TestBed.createComponent(OrganizationSettingsComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne(URL).flush(profile);

    expect(fixture.componentInstance.form.getRawValue()).toEqual(profile);
    fixture.componentInstance.form.controls.name.setValue('Casa Mochilera');
    fixture.componentInstance.save();

    const request = httpMock.expectOne((req) => req.method === 'PUT' && req.url === URL);
    expect(request.request.body).toEqual({ ...profile, name: 'Casa Mochilera' });
    request.flush({ ...profile, name: 'Casa Mochilera' });
    expect(setup.snackBarOpen).toHaveBeenCalledWith('adminSettings.saved', undefined, expect.anything());
  });

  it('does not save without a name', () => {
    const setup = testProviders();
    TestBed.configureTestingModule({ imports: [OrganizationSettingsComponent], providers: setup.providers });
    TestBed.inject(AuthService).setSessionForTesting('access', staffWith(['settings.manage']));
    const fixture = TestBed.createComponent(OrganizationSettingsComponent);
    fixture.detectChanges();
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.expectOne(URL).flush({ ...profile, name: '' });

    fixture.componentInstance.save();

    httpMock.expectNone((req) => req.method === 'PUT');
  });
});
