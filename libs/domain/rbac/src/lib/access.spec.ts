import { describe, expect, it } from 'vitest';
import { requirePermission, type Actor } from './access';

const staff = (permissions: Actor['permissions']): Actor => ({
  userId: 'user-1',
  type: 'STAFF',
  locale: 'es',
  permissions,
});

describe('requirePermission', () => {
  it('allows an actor holding the permission', () => {
    const result = requirePermission(staff(['trip.create']), 'trip.create');
    expect(result.ok).toBe(true);
  });

  it('denies an actor missing the permission', () => {
    const result = requirePermission(staff(['trip.view']), 'trip.create');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('denies an anonymous actor', () => {
    const result = requirePermission(null, 'trip.view');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED');
  });

  it('denies a customer regardless of the permission list', () => {
    const customer: Actor = { userId: 'u', type: 'CUSTOMER', locale: 'es', permissions: ['trip.view'] };
    const result = requirePermission(customer, 'trip.view');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED');
  });
});
