import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { recordAudit } from './audit';

const db = withTestDb();

describe('recordAudit', () => {
  beforeAll(async () => {
    await prepareTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('writes an entry with the given fields', async () => {
    await recordAudit(db, {
      actorUserId: '11111111-1111-1111-1111-111111111111',
      action: 'role.created',
      entityType: 'Role',
      entityId: 'role-1',
      before: null,
      after: { name: 'Seller' },
    });

    const [entry] = await db.auditLog.findMany();
    expect(entry.actorUserId).toBe('11111111-1111-1111-1111-111111111111');
    expect(entry.action).toBe('role.created');
    expect(entry.entityType).toBe('Role');
    expect(entry.entityId).toBe('role-1');
    expect(entry.before).toBeNull();
    expect(entry.after).toEqual({ name: 'Seller' });
  });

  it('defaults before and after to null when omitted', async () => {
    await recordAudit(db, { action: 'role.deleted', entityType: 'Role', entityId: 'role-1' });

    const [entry] = await db.auditLog.findMany();
    expect(entry.before).toBeNull();
    expect(entry.after).toBeNull();
  });

  it('accepts an actorless entry, since a deleted user must not erase its own trail', async () => {
    await recordAudit(db, { action: 'role.deleted', entityType: 'Role', entityId: 'role-1' });

    const [entry] = await db.auditLog.findMany();
    expect(entry.actorUserId).toBeNull();
  });

  it('can be called inside a transaction with no cast, and survives only if the transaction commits', async () => {
    await db.$transaction(async (tx) => {
      // `tx` is `DbTransactionClient`, matching `recordAudit`'s parameter type
      // exactly -- no cast required at this call site.
      await recordAudit(tx, { action: 'role.created', entityType: 'Role', entityId: 'role-2' });
    });

    const entries = await db.auditLog.findMany({ where: { entityId: 'role-2' } });
    expect(entries).toHaveLength(1);
  });
});
