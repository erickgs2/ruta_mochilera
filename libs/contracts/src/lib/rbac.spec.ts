import { describe, expect, it } from 'vitest';
import { permissionSchema, roleInputSchema, roleSchema } from './rbac';

describe('roleInputSchema', () => {
  it('accepts a valid role input', () => {
    const parsed = roleInputSchema.safeParse({
      name: 'Seller',
      description: 'Sells trips',
      permissionKeys: ['trip.view', 'trip.create'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty permission set', () => {
    expect(roleInputSchema.safeParse({ name: 'Seller', description: '', permissionKeys: [] }).success).toBe(true);
  });

  it('rejects a name shorter than two characters', () => {
    expect(roleInputSchema.safeParse({ name: 'S', description: '', permissionKeys: [] }).success).toBe(false);
  });
});

describe('roleSchema', () => {
  it('parses a full role DTO', () => {
    const parsed = roleSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Seller',
      description: 'Sells trips',
      isSystem: false,
      permissionKeys: ['trip.view'],
      userCount: 3,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a negative user count', () => {
    const parsed = roleSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Seller',
      description: 'Sells trips',
      isSystem: false,
      permissionKeys: [],
      userCount: -1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('permissionSchema', () => {
  it('parses a permission catalog entry', () => {
    const parsed = permissionSchema.safeParse({
      key: 'role.manage',
      category: 'rbac',
      description: 'Create, edit and delete roles',
    });
    expect(parsed.success).toBe(true);
  });
});
