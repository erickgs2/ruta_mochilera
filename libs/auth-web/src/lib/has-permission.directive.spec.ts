import { HttpClientTestingModule } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from '@rm/api-client';
import { AuthService, type SessionUser } from './auth.service';
import { HasPermissionDirective } from './has-permission.directive';

@Component({
  selector: 'rm-test-host',
  standalone: true,
  imports: [HasPermissionDirective],
  template: `<span *rmHasPermission="'trip.create'">allowed</span>`,
})
class HostComponent {}

@Component({
  selector: 'rm-test-empty-binding-host',
  standalone: true,
  imports: [HasPermissionDirective],
  template: `<span *rmHasPermission="''">allowed</span>`,
})
class EmptyBindingHostComponent {}

function userWith(permissions: string[]): SessionUser {
  return { id: 'u1', email: 'a@b.test', type: 'STAFF', locale: 'es', fullName: 'Ana', permissions };
}

describe('HasPermissionDirective', () => {
  let auth: AuthService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, HostComponent, EmptyBindingHostComponent],
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
    auth.setSessionForTesting('access-1', userWith(['trip.create']));
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent.trim()).toBe('allowed');
  });

  it('reacts to a permission being revoked or granted at runtime, on the same fixture', async () => {
    // This is the safety-relevant path: every successful token refresh
    // returns a fresh permissions list, and an actor whose permission was
    // just revoked must stop seeing the gated control without a page reload.
    auth.setSessionForTesting('access-1', userWith(['trip.create']));
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent.trim()).toBe('allowed');

    // Simulate a refresh response that no longer carries the permission --
    // same AuthService instance, same fixture, no re-creation.
    auth.setSessionForTesting('access-2', userWith([]));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent.trim()).toBe('');

    // And the reverse: the permission is granted back in a later refresh.
    auth.setSessionForTesting('access-3', userWith(['trip.create']));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent.trim()).toBe('allowed');
  });

  it('throws loudly if the permission is not bound, instead of silently rendering nothing forever', () => {
    const fixture = TestBed.createComponent(EmptyBindingHostComponent);
    expect(() => fixture.detectChanges()).toThrow(/requires a permission key/);
  });
});
