import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { createPrismaClient, type Prisma } from '@rm/db';
import { PERMISSIONS } from '../../domain/rbac/src/lib/permissions';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env before running the seed.');
}

const db = createPrismaClient(databaseUrl);

const DEFAULT_SETTINGS: Record<string, Prisma.InputJsonValue> = {
  'reservation.default_hold_ttl_hours': 72,
  'risk.balance_threshold_percent': 40,
  'risk.lead_days': 30,
  'reminder.day_of_month': 28,
  'reminder.hour_local': 10,
  'organization.timezone': 'America/Mexico_City',
  'receipt.prefix': 'RM',
};

async function main() {
  // The permission catalog is idempotent: it is synchronised on every seed run.
  for (const permission of PERMISSIONS) {
    await db.permission.upsert({
      where: { key: permission.key },
      create: permission,
      update: { category: permission.category, description: permission.description },
    });
  }

  // Fully converge the table on the catalog, the same way the Super Admin
  // role is resynced below: a key removed or renamed in `PERMISSIONS` must
  // stop existing in the database too, otherwise a stale row keeps granting
  // whatever it used to grant to every role still linked to it. The foreign
  // key from `role_permissions` to `permissions` cascades on delete, so
  // removing the row is enough to drop those links as well.
  const catalogKeys = new Set(PERMISSIONS.map((permission) => permission.key));
  const stalePermissions = await db.permission.findMany({
    where: { key: { notIn: [...catalogKeys] } },
  });
  if (stalePermissions.length > 0) {
    for (const stale of stalePermissions) {
      console.log(`Pruning permission no longer in the catalog: ${stale.key}`);
    }
    await db.permission.deleteMany({
      where: { id: { in: stalePermissions.map((stale) => stale.id) } },
    });
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: {},
    });
  }

  const allPermissions = await db.permission.findMany();
  const superAdmin = await db.role.upsert({
    where: { name: 'Super Admin' },
    create: { name: 'Super Admin', description: 'Full access to every action', isSystem: true },
    update: { isSystem: true },
  });

  await db.rolePermission.deleteMany({ where: { roleId: superAdmin.id } });
  await db.rolePermission.createMany({
    data: allPermissions.map((permission) => ({
      roleId: superAdmin.id,
      permissionId: permission.id,
    })),
  });

  // Normalised the same way `createStaff` normalises every other write path:
  // login matches case-insensitively, so an un-normalised seed email would be
  // the one write path still able to create a second account differing only
  // in case.
  const email = (process.env['SEED_ADMIN_EMAIL'] ?? 'admin@rutamochilera.test').trim().toLowerCase();
  const password = process.env['SEED_ADMIN_PASSWORD'] ?? 'ChangeMe123!';
  const user = await db.user.upsert({
    where: { email },
    create: {
      email,
      type: 'STAFF',
      // Hashed directly with @node-rs/argon2 rather than the domain's
      // hashPassword(): libs/db cannot depend on libs/domain/identity
      // without creating the import cycle db -> domain/identity -> db
      // (identity imports the Db type from @rm/db). This is safe: an
      // encoded argon2 hash embeds its own m/t/p parameters, so
      // verifyPassword() can check a hash produced with different
      // options — only the cost of producing it differs, never whether
      // it verifies. Do not "fix" this duplication by importing
      // hashPassword here.
      passwordHash: await hash(password),
      emailVerifiedAt: new Date(),
      staffProfile: { create: { fullName: 'Initial Administrator' } },
    },
    update: {},
  });

  await db.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: superAdmin.id } },
    create: { userId: user.id, roleId: superAdmin.id },
    update: {},
  });

  console.log(`Seeded ${allPermissions.length} permissions and admin user ${email}`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
