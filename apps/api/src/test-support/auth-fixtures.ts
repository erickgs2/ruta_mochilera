import type { Db } from '@rm/db';
import { hashPassword } from '@rm/domain-identity';
import { PERMISSIONS } from '@rm/domain-rbac';
import { POST as loginRoute } from '../app/api/v1/auth/login/route';

/**
 * Seeds the full permission catalog (`@rm/domain-rbac`'s `PERMISSIONS`) into
 * the test database. The trips, costing and images integration suites each
 * need only a handful of these keys, but seeding the real catalog rather
 * than inventing ad hoc permission rows keeps every suite honest against
 * what the application actually checks.
 */
export async function seedPermissionCatalog(db: Db): Promise<void> {
  await db.permission.createMany({
    data: PERMISSIONS.map((permission) => ({
      key: permission.key,
      category: permission.category,
      description: permission.description,
    })),
  });
}

/**
 * Creates a STAFF user holding exactly the given permission keys (which must
 * already exist in the catalog -- see `seedPermissionCatalog`), logs in
 * through the real login route, and returns the resulting access token.
 * Shared across the trips, costing and images integration suites so the
 * fixture stays in one place instead of being retyped in each file.
 */
export async function loginAs(db: Db, email: string, permissionKeys: string[]): Promise<string> {
  const role = await db.role.create({ data: { name: `role-for-${email}`, description: 'test role' } });
  const permissions = await db.permission.findMany({ where: { key: { in: permissionKeys } } });
  await db.rolePermission.createMany({
    data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
  });
  await db.user.create({
    data: {
      email,
      type: 'STAFF',
      passwordHash: await hashPassword('Correct-Horse-1'),
      emailVerifiedAt: new Date(),
      staffProfile: { create: { fullName: email } },
      roles: { create: { roleId: role.id } },
    },
  });

  const response = await loginRoute(
    new Request('http://localhost/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Correct-Horse-1' }),
    })
  );
  const body = await response.json();
  return body.tokens.accessToken as string;
}

/**
 * Creates a CUSTOMER user (with a `CustomerProfile`, the row
 * `@rm/domain-reservations`' `createReservation` requires), logs in through
 * the real login route, and returns both the access token and the user's
 * id -- callers almost always need the id too, to seed a reservation
 * directly against this exact customer.
 *
 * Email is verified by default: most of the reservations/payments/inbox
 * suite is not testing the verification gate itself, and login never checks
 * `emailVerifiedAt` (only `createReservation` does, per business rule 5.2),
 * so leaving it unset here would make every other test implicitly depend on
 * that gate too. Pass `emailVerified: false` for the one test that is about
 * the gate.
 */
export async function loginAsCustomer(
  db: Db,
  email: string,
  options: { emailVerified?: boolean } = {}
): Promise<{ userId: string; token: string }> {
  const user = await db.user.create({
    data: {
      email,
      type: 'CUSTOMER',
      passwordHash: await hashPassword('Correct-Horse-1'),
      emailVerifiedAt: options.emailVerified === false ? null : new Date(),
      customerProfile: {
        create: {
          fullName: email,
          phone: '5512345678',
          birthDate: new Date('1990-01-01'),
          origin: 'SELF_SIGNUP',
        },
      },
    },
  });

  const response = await loginRoute(
    new Request('http://localhost/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Correct-Horse-1' }),
    })
  );
  const body = await response.json();
  return { userId: user.id, token: body.tokens.accessToken as string };
}
