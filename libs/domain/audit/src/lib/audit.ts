import type { DbTransactionClient, Prisma } from '@rm/db';

export interface AuditInput {
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/**
 * Appends an immutable audit entry. Call it inside the same transaction as the
 * mutation it records, so an audit trail can never disagree with the data.
 *
 * Typed to accept `DbTransactionClient` rather than `Db` so every call site —
 * standalone or inside `db.$transaction(async (tx) => ...)` — passes its
 * client through with no cast: a full `Db` is structurally assignable to
 * `DbTransactionClient`.
 */
export async function recordAudit(db: DbTransactionClient, input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: (input.before ?? null) as Prisma.InputJsonValue,
      after: (input.after ?? null) as Prisma.InputJsonValue,
      ip: input.ip,
    },
  });
}
