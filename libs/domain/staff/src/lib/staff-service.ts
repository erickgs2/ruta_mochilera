import type { Db } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { hashPassword } from '@rm/domain-identity';
import type { Actor } from '@rm/domain-rbac';
import { fail, ok, type Result } from '@rm/shared-utils';

export interface StaffDto {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string | null;
  status: 'ACTIVE' | 'DISABLED';
  locale: 'es' | 'en';
  roleIds: string[];
}

export interface CreateStaffInput {
  email: string;
  fullName: string;
  employeeCode?: string;
  locale: 'es' | 'en';
  password: string;
  roleIds: string[];
}

export interface UpdateStaffInput {
  fullName: string;
  employeeCode?: string;
  locale: 'es' | 'en';
  status: 'ACTIVE' | 'DISABLED';
  roleIds: string[];
}

const STAFF_SHAPE = { staffProfile: true, roles: { select: { roleId: true } } } as const;

type StaffRow = {
  id: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
  locale: 'es' | 'en';
  staffProfile: { fullName: string; employeeCode: string | null } | null;
  roles: { roleId: string }[];
};

function toDto(user: StaffRow): StaffDto {
  return {
    id: user.id,
    email: user.email,
    fullName: user.staffProfile?.fullName ?? '',
    employeeCode: user.staffProfile?.employeeCode ?? null,
    status: user.status,
    locale: user.locale,
    roleIds: user.roles.map((link) => link.roleId),
  };
}

async function assertRolesExist(db: Db, roleIds: string[]): Promise<Result<null>> {
  if (roleIds.length === 0) return ok(null);
  const found = await db.role.findMany({ where: { id: { in: roleIds } }, select: { id: true } });
  const missing = roleIds.filter((id) => !found.some((role) => role.id === id));
  if (missing.length > 0) return fail('VALIDATION_FAILED', { unknownRoles: missing });
  return ok(null);
}

/** Lists staff accounts. Never includes customers: this reads `User` filtered to `type: 'STAFF'` only. */
export async function listStaff(db: Db, query: { search?: string }): Promise<Result<StaffDto[]>> {
  const search = query.search?.trim();
  const users = await db.user.findMany({
    where: {
      type: 'STAFF',
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { staffProfile: { fullName: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: STAFF_SHAPE,
    orderBy: { createdAt: 'asc' },
  });
  return ok(users.map(toDto));
}

/**
 * Creates a staff (administrator) account. There is no self-registration for
 * staff: an existing administrator vouches for the new one in person, which
 * is why the account is created with its email already verified and why this
 * function takes the initial password directly instead of sending an
 * invitation.
 */
export async function createStaff(
  db: Db,
  actor: Actor,
  input: CreateStaffInput
): Promise<Result<StaffDto>> {
  // Lowercased before both the duplicate check and the write: login matches
  // case-insensitively, so an un-normalised write here is how two accounts
  // differing only in case could become reachable by a single login.
  const email = input.email.trim().toLowerCase();
  if (await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })) {
    return fail('EMAIL_ALREADY_REGISTERED');
  }

  const rolesOk = await assertRolesExist(db, input.roleIds);
  if (!rolesOk.ok) return rolesOk;

  const passwordHash = await hashPassword(input.password);

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email,
        type: 'STAFF',
        locale: input.locale,
        passwordHash,
        // An account created by another administrator is born trusted: it
        // does not go through email verification.
        emailVerifiedAt: new Date(),
        staffProfile: { create: { fullName: input.fullName, employeeCode: input.employeeCode } },
        roles: { create: input.roleIds.map((roleId) => ({ roleId })) },
      },
      include: STAFF_SHAPE,
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'staff.created',
      entityType: 'User',
      entityId: created.id,
      after: { email, fullName: input.fullName, roleIds: input.roleIds },
    });
    return created;
  });

  return ok(toDto(user));
}

/**
 * Updates a staff account. Deliberately does not accept an email: identity is
 * immutable here, and password reset is its own operation in a later phase.
 */
export async function updateStaff(
  db: Db,
  actor: Actor,
  userId: string,
  input: UpdateStaffInput
): Promise<Result<StaffDto>> {
  const existing = await db.user.findFirst({ where: { id: userId, type: 'STAFF' }, include: STAFF_SHAPE });
  if (!existing) return fail('NOT_FOUND');

  const rolesOk = await assertRolesExist(db, input.roleIds);
  if (!rolesOk.ok) return rolesOk;

  const user = await db.$transaction(async (tx) => {
    // The role set is replaced wholesale, like the role service's permission
    // set: the caller sends the final state, not a diff.
    await tx.userRole.deleteMany({ where: { userId } });
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        locale: input.locale,
        status: input.status,
        staffProfile: { update: { fullName: input.fullName, employeeCode: input.employeeCode } },
        roles: { create: input.roleIds.map((roleId) => ({ roleId })) },
      },
      include: STAFF_SHAPE,
    });

    // Disabling an account must revoke its live sessions in the same
    // transaction: it has to lose access immediately, not whenever its
    // access token happens to expire. `getActor` re-reading user status on
    // every request is a separate, complementary safeguard -- this one
    // matters for the window before that access token expires.
    if (input.status === 'DISABLED') {
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }

    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'staff.updated',
      entityType: 'User',
      entityId: userId,
      before: toDto(existing),
      after: { ...input },
    });
    return updated;
  });

  return ok(toDto(user));
}
