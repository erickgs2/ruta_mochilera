import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from './permissions';

describe('PERMISSIONS catalog', () => {
  it('has no duplicate keys', () => {
    const keys = PERMISSIONS.map((permission) => permission.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses dot-separated lowercase keys', () => {
    for (const permission of PERMISSIONS) {
      expect(permission.key).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
  });

  it('gives every permission a non-empty category and description', () => {
    for (const permission of PERMISSIONS) {
      expect(permission.category.length).toBeGreaterThan(0);
      expect(permission.description.length).toBeGreaterThan(0);
    }
  });

  it('includes the permissions Phase 1 enforces', () => {
    const keys = PERMISSIONS.map((permission) => permission.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'role.view', 'role.manage',
        'staff.view', 'staff.manage',
        'trip.view', 'trip.create', 'trip.update', 'trip.publish',
        'trip.budget.view', 'trip.budget.manage',
        'data.backfill',
      ])
    );
  });
});
