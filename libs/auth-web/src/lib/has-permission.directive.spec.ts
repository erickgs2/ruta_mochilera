import { HttpClientTestingModule } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService } from './auth.service';
import { HasPermissionDirective } from './has-permission.directive';

@Component({
  standalone: true,
  imports: [HasPermissionDirective],
  template: `<span *rmHasPermission="'trip.create'">allowed</span>`,
})
class HostComponent {}

describe('HasPermissionDirective', () => {
  let auth: AuthService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, HostComponent],
      providers: [{ provide: API_BASE_URL, useValue: '' }],
    });
    auth = TestBed.inject(AuthService);
  });

  it('does not render the template when the permission is missing', async () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('renders the template when the user has the permission', async () => {
    auth.setSessionForTesting('access-1', 'refresh-1', {
      id: 'u1',
      email: 'a@b.test',
      type: 'STAFF',
      locale: 'es',
      fullName: 'Ana',
      permissions: ['trip.create'],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent.trim()).toBe('allowed');
  });
});
