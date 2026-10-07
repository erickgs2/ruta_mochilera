import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { acceptInvitation, hashPassword, resetPassword, verifyPassword } from '@rm/domain-identity';
import { PROVIDER_REJECTED_TEST_ADDRESS, type EmailMessage, type EmailProvider } from '@rm/email';
import { fail, ok } from '@rm/shared-utils';
import { createBranchCustomer, getCustomerForStaff, searchCustomers, sendCustomerInvitation } from './customer-service';

const db = withTestDb();

class RecordingEmail implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    if (message.to === PROVIDER_REJECTED_TEST_ADDRESS) return fail('EMAIL_PROVIDER_ERROR');
    this.sent.push(message);
    return ok({ providerMessageId: `msg-${this.sent.length}` });
  }
}

let email: RecordingEmail;
let staffId: string;
const mail = () => ({ email, clientAppUrl: 'https://rutamochilera.test/app/' });

function tokenFrom(message: EmailMessage | undefined): string {
  const match = /invitation\?token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '');
  if (!match?.[1]) throw new Error('no invitation link in the email');
  return match[1];
}

async function register(overrides: Partial<{ fullName: string; email: string; phone: string }> = {}, sendInvitation = true) {
  const result = await createBranchCustomer(
    db,
    mail(),
    {
      fullName: overrides.fullName ?? 'María Peña',
      email: overrides.email ?? 'maria@example.com',
      phone: overrides.phone ?? '352 100 80 79',
      birthDate: '1990-05-17',
    },
    { sendInvitation, actorId: staffId }
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

beforeAll(async () => {
  await prepareTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  email = new RecordingEmail();
  const staff = await db.user.create({ data: { email: 'cashier@agency.test', type: 'STAFF' } });
  staffId = staff.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe('searchCustomers', () => {
  beforeEach(async () => {
    await register({ fullName: 'María Peña', email: 'maria@example.com', phone: '352 100 80 79' }, false);
    await register({ fullName: 'José Núñez', email: 'jose@example.com', phone: '(333) 555-1234' }, false);
    await register({ fullName: 'Ana López', email: 'ana.lopez@example.com', phone: '5512345678' }, false);
  });

  it('finds by partial name without accents or case', async () => {
    const result = await searchCustomers(db, { query: 'maria' });
    expect(result.ok && result.value.items.map((c) => c.fullName)).toEqual(['María Peña']);

    const accented = await searchCustomers(db, { query: 'NÚÑ' });
    expect(accented.ok && accented.value.items.map((c) => c.fullName)).toEqual(['José Núñez']);
  });

  it('finds by email and by phone digits', async () => {
    const byEmail = await searchCustomers(db, { query: 'ana.lopez@' });
    expect(byEmail.ok && byEmail.value.items.map((c) => c.fullName)).toEqual(['Ana López']);

    const byPhone = await searchCustomers(db, { query: '333-555' });
    expect(byPhone.ok && byPhone.value.items.map((c) => c.fullName)).toEqual(['José Núñez']);
  });

  it('treats LIKE wildcards as plain text', async () => {
    const result = await searchCustomers(db, { query: '%' });
    expect(result.ok && result.value.total).toBe(0);
  });

  it('paginates and never returns staff', async () => {
    const first = await searchCustomers(db, { page: 1, pageSize: 2 });
    const second = await searchCustomers(db, { page: 2, pageSize: 2 });

    expect(first.ok && first.value.total).toBe(3);
    expect(first.ok && first.value.items).toHaveLength(2);
    expect(second.ok && second.value.items).toHaveLength(1);
    const all = [...(first.ok ? first.value.items : []), ...(second.ok ? second.value.items : [])];
    expect(all.map((c) => c.email)).not.toContain('cashier@agency.test');
    expect(new Set(all.map((c) => c.id)).size).toBe(3);
  });
});

describe('createBranchCustomer', () => {
  it('creates a verified customer with no password, origin BRANCH, audited, and invites them', async () => {
    const created = await register();

    expect(created).toMatchObject({
      fullName: 'María Peña',
      email: 'maria@example.com',
      origin: 'BRANCH',
      hasPassword: false,
      activatedAt: null,
      acceptedTermsAt: null,
      invitationSent: true,
    });
    expect(created.emailVerifiedAt).not.toBeNull();
    expect(created.invitedAt).not.toBeNull();
    const audit = await db.auditLog.findFirst({ where: { action: 'customer.created', entityId: created.id } });
    expect(audit?.actorUserId).toBe(staffId);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: 'maria@example.com' });
    expect(email.sent[0]?.text).toContain('https://rutamochilera.test/app/invitation?token=');
  });

  it('does not invite when staff unticks it', async () => {
    const created = await register({}, false);

    expect(created.invitationSent).toBe(false);
    expect(created.invitedAt).toBeNull();
    expect(email.sent).toHaveLength(0);
    expect(await db.passwordReset.count()).toBe(0);
  });

  it('rejects a birth date after today in the organization time zone and creates nothing', async () => {
    const tomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const result = await createBranchCustomer(
      db,
      mail(),
      { fullName: 'Futura', email: 'futura@example.com', phone: '1234567', birthDate: tomorrow },
      { sendInvitation: true, actorId: staffId }
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'birthDate' } } });
    expect(await db.user.count({ where: { type: 'CUSTOMER' } })).toBe(0);
    expect(email.sent).toHaveLength(0);
  });

  it('rejects an impossible calendar date such as 2020-02-31', async () => {
    const result = await createBranchCustomer(
      db,
      mail(),
      { fullName: 'Rara', email: 'rara@example.com', phone: '1234567', birthDate: '2020-02-31' },
      { sendInvitation: false, actorId: staffId }
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'birthDate' } } });
  });

  it('answers CUSTOMER_ALREADY_EXISTS with the existing id and creates nothing', async () => {
    const first = await register();

    const again = await createBranchCustomer(
      db,
      mail(),
      { fullName: 'Otra', email: ' MARIA@example.com ', phone: '1234567', birthDate: '1990-01-01' },
      { sendInvitation: true, actorId: staffId }
    );

    expect(again).toMatchObject({ ok: false, error: { code: 'CUSTOMER_ALREADY_EXISTS', details: { customerId: first.id } } });
    expect(await db.user.count({ where: { type: 'CUSTOMER' } })).toBe(1);
  });

  it('keeps the customer when the invitation email fails', async () => {
    const created = await register({ email: PROVIDER_REJECTED_TEST_ADDRESS });

    expect(created.invitationSent).toBe(false);
    expect(await db.user.count({ where: { type: 'CUSTOMER' } })).toBe(1);
  });
});

describe('invitations', () => {
  it('accepting sets the password, activates the account, records the terms and consumes the token', async () => {
    const created = await register();
    const token = tokenFrom(email.sent[0]);

    const accepted = await acceptInvitation(db, { token, password: 'Correct-Horse-1' });

    expect(accepted).toEqual({ ok: true, value: { email: 'maria@example.com' } });
    const customer = await getCustomerForStaff(db, created.id);
    expect(customer.ok && customer.value.hasPassword).toBe(true);
    expect(customer.ok && customer.value.activatedAt).not.toBeNull();
    expect(customer.ok && customer.value.acceptedTermsAt).not.toBeNull();
    expect(await acceptInvitation(db, { token, password: 'Another-Horse-2' })).toMatchObject({
      ok: false,
      error: { code: 'TOKEN_INVALID' },
    });
  });

  it('refuses an expired invitation, and a reset token used as an invitation', async () => {
    await register();
    const token = tokenFrom(email.sent[0]);
    await db.passwordReset.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await acceptInvitation(db, { token, password: 'Correct-Horse-1' })).toMatchObject({
      ok: false,
      error: { code: 'TOKEN_INVALID' },
    });
  });

  it('never lets an invitation token reset a password', async () => {
    await register();
    const token = tokenFrom(email.sent[0]);

    expect(await resetPassword(db, token, 'Correct-Horse-1')).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
  });

  it('resending invalidates the previous invitation', async () => {
    const created = await register();
    const first = tokenFrom(email.sent[0]);

    const resent = await sendCustomerInvitation(db, mail(), { customerId: created.id, actorId: staffId });

    expect(resent.ok).toBe(true);
    const second = tokenFrom(email.sent[1]);
    expect(await acceptInvitation(db, { token: first, password: 'Correct-Horse-1' })).toMatchObject({ ok: false });
    expect(await acceptInvitation(db, { token: second, password: 'Correct-Horse-1' })).toMatchObject({ ok: true });
  });

  /** A live reset token for the user, as `requestPasswordReset` would have issued it. */
  async function issueResetToken(userId: string, token: string) {
    await db.passwordReset.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        purpose: 'RESET',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  it('refuses a stale invitation after the customer set a password with a reset, and keeps that password', async () => {
    const created = await register();
    const invitation = tokenFrom(email.sent[0]);
    await issueResetToken(created.id, 'reset-token-1');
    expect(await resetPassword(db, 'reset-token-1', 'Chosen-Horse-1')).toMatchObject({ ok: true });

    const stale = await acceptInvitation(db, { token: invitation, password: 'Attacker-Horse-9' });

    expect(stale).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
    const user = await db.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(await verifyPassword(user.passwordHash!, 'Chosen-Horse-1')).toBe(true);
    expect(await verifyPassword(user.passwordHash!, 'Attacker-Horse-9')).toBe(false);
  });

  it('refuses a live invitation for an account that already has a password, and keeps that password', async () => {
    const created = await register();
    const invitation = tokenFrom(email.sent[0]);
    // The password arrives some way that leaves the invitation untouched and
    // unconsumed (unlike a reset, which consumes it): the guard on
    // `password_hash IS NULL` is then the only thing standing in the way.
    await db.user.update({ where: { id: created.id }, data: { passwordHash: await hashPassword('Chosen-Horse-1') } });
    expect(await db.passwordReset.count({ where: { userId: created.id, purpose: 'INVITATION', consumedAt: null } })).toBe(1);

    const refused = await acceptInvitation(db, { token: invitation, password: 'Attacker-Horse-9' });

    expect(refused).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
    const user = await db.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(await verifyPassword(user.passwordHash!, 'Chosen-Horse-1')).toBe(true);
    expect(await verifyPassword(user.passwordHash!, 'Attacker-Horse-9')).toBe(false);
    const customer = await getCustomerForStaff(db, created.id);
    expect(customer.ok && customer.value.activatedAt).toBeNull();
    // The refusal still commits the consumption (documented in customers.md).
    const row = await db.passwordReset.findFirstOrThrow({ where: { userId: created.id, purpose: 'INVITATION' } });
    expect(row.consumedAt).not.toBeNull();
  });

  it('consumes the pending invitations when the customer resets the password', async () => {
    const created = await register();
    await issueResetToken(created.id, 'reset-token-2');

    await resetPassword(db, 'reset-token-2', 'Chosen-Horse-1');

    expect(await db.passwordReset.count({ where: { userId: created.id, purpose: 'INVITATION', consumedAt: null } })).toBe(0);
  });

  it('lets exactly one of two simultaneous uses of the same reset token win', async () => {
    const created = await register();
    await issueResetToken(created.id, 'reset-token-3');

    const results = await Promise.all([
      resetPassword(db, 'reset-token-3', 'First-Horse-1'),
      resetPassword(db, 'reset-token-3', 'Second-Horse-2'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
  });

  it('survives accepting the invitation and resetting the password at the same time, 30 times over', async () => {
    const iterations = 30;
    const outcomes: PromiseSettledResult<{ ok: boolean }>[][] = [];
    for (let i = 0; i < iterations; i++) {
      const created = await register({ email: `race${i}@example.com` });
      const invitation = tokenFrom(email.sent.at(-1));
      await issueResetToken(created.id, `race-reset-${i}`);

      const settled = await Promise.allSettled([
        acceptInvitation(db, { token: invitation, password: 'Accepted-Horse-1' }),
        resetPassword(db, `race-reset-${i}`, 'Reset-Horse-2'),
      ]);
      outcomes.push(settled);

      // Neither side may blow up (a 500 for the caller)...
      expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      // ...the holder of the reset token always ends with their password: if the
      // invitation ran first the reset overwrites it, if the reset ran first the
      // invitation is TOKEN_INVALID and must not touch it.
      const user = await db.user.findUniqueOrThrow({ where: { id: created.id } });
      expect(await verifyPassword(user.passwordHash!, 'Reset-Horse-2')).toBe(true);
      expect(await db.passwordReset.count({ where: { userId: created.id, consumedAt: null } })).toBe(0);
    }
    expect(outcomes).toHaveLength(iterations);
  });

  it('activates a counter customer who sets a password through a reset, without recording terms they never accepted', async () => {
    const created = await register();
    await issueResetToken(created.id, 'reset-activation');

    await resetPassword(db, 'reset-activation', 'Chosen-Horse-1');

    const customer = await getCustomerForStaff(db, created.id);
    expect(customer.ok && customer.value.hasPassword).toBe(true);
    expect(customer.ok && customer.value.activatedAt).not.toBeNull();
    expect(customer.ok && customer.value.acceptedTermsAt).toBeNull();
  });

  it('keeps the original activation date when an already active customer resets the password', async () => {
    const created = await register();
    await acceptInvitation(db, { token: tokenFrom(email.sent[0]), password: 'Correct-Horse-1' });
    const before = await db.customerProfile.findUniqueOrThrow({ where: { userId: created.id } });
    await issueResetToken(created.id, 'reset-again');

    await resetPassword(db, 'reset-again', 'Chosen-Horse-1');

    const after = await db.customerProfile.findUniqueOrThrow({ where: { userId: created.id } });
    expect(after.activatedAt).toEqual(before.activatedAt);
    expect(after.acceptedTermsAt).toEqual(before.acceptedTermsAt);
  });

  it('resets a staff password, who has no customer profile', async () => {
    await issueResetToken(staffId, 'reset-staff');

    expect(await resetPassword(db, 'reset-staff', 'Staff-Horse-1')).toMatchObject({ ok: true });
  });

  it('refuses to invite a customer who already has a password', async () => {
    const created = await register();
    await acceptInvitation(db, { token: tokenFrom(email.sent[0]), password: 'Correct-Horse-1' });

    const again = await sendCustomerInvitation(db, mail(), { customerId: created.id, actorId: staffId });

    expect(again).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('lives invitation.ttl_days', async () => {
    await db.systemSetting.create({ data: { key: 'invitation.ttl_days', value: 3 } });
    await register();

    const row = await db.passwordReset.findFirstOrThrow({ where: { purpose: 'INVITATION' } });
    const days = (row.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
  });
});
