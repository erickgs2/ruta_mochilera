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

  const email = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@rutamochilera.test';
  const password = process.env['SEED_ADMIN_PASSWORD'] ?? 'ChangeMe123!';
  const user = await db.user.upsert({
    where: { email },
    create: {
      email,
      type: 'STAFF',
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
