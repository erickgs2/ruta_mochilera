import { createHash, randomBytes } from 'node:crypto';
import type { Db, DbTransactionClient, Locale } from '@rm/db';
import type { EmailMessage } from '@rm/email';
import { fail, ok, type Result } from '@rm/shared-utils';
import { hashPassword } from './password';

/**
 * Invitations for customers registered at the counter (Phase 2B, §5.1).
 *
 * A counter customer has a verified email and no password. The invitation
 * is a single-use link to `/invitation?token=…` in the client app, where
 * they choose a password and accept the terms. It reuses `password_resets`
 * with `purpose = INVITATION`: the same hashed-token shape, a longer life
 * (`invitation.ttl_days`, 7 by default), and only `acceptInvitation`
 * accepts it -- `resetPassword` refuses it and vice versa.
 *
 * Like a reset token, the plaintext token never goes through the pg-boss
 * outbox (which persists its payload): the caller sends the email directly,
 * after its transaction has committed.
 */

const DEFAULT_INVITATION_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function invitationTtlDays(db: Db | DbTransactionClient): Promise<number> {
  const setting = await db.systemSetting.findUnique({ where: { key: 'invitation.ttl_days' } });
  return typeof setting?.value === 'number' && setting.value > 0 ? setting.value : DEFAULT_INVITATION_TTL_DAYS;
}

/**
 * Issues a new invitation token for `userId` inside the caller's
 * transaction, **invalidating every earlier one** that is still unused, and
 * returns the plaintext token for the email. Only the hash is stored.
 */
export async function issueInvitationToken(tx: DbTransactionClient, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const now = new Date();
  await tx.passwordReset.updateMany({
    where: { userId, purpose: 'INVITATION', consumedAt: null },
    data: { consumedAt: now },
  });
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + (await invitationTtlDays(tx)) * DAY_MS);
  await tx.passwordReset.create({
    data: { userId, tokenHash: hashToken(token), purpose: 'INVITATION', expiresAt },
  });
  return { token, expiresAt };
}

/** The invitation email, in the customer's language. */
export function invitationEmailMessage(input: {
  to: string;
  fullName: string;
  locale: Locale;
  token: string;
  clientAppUrl: string;
  organizationName: string;
  expiresAt: Date;
}): EmailMessage {
  const link = `${input.clientAppUrl.replace(/\/$/, '')}/invitation?token=${input.token}`;
  const days = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / DAY_MS));
  const lines =
    input.locale === 'es'
      ? {
          subject: `Activa tu cuenta de ${input.organizationName}`,
          body: [
            `Hola, ${input.fullName}:`,
            `Te registramos en ${input.organizationName}. Activa tu cuenta para ver tus reservas, pagos y recibos desde la app:`,
            link,
            `El enlace sirve una sola vez y vence en ${days} días.`,
          ],
        }
      : {
          subject: `Activate your ${input.organizationName} account`,
          body: [
            `Hello ${input.fullName},`,
            `We registered you with ${input.organizationName}. Activate your account to see your reservations, payments and receipts in the app:`,
            link,
            `The link works once and expires in ${days} days.`,
          ],
        };
  const escape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return {
    to: input.to,
    subject: lines.subject,
    text: lines.body.join('\n\n'),
    html: lines.body
      .map((line) => (line === link ? `<p><a href="${escape(link)}">${escape(link)}</a></p>` : `<p>${escape(line)}</p>`))
      .join(''),
  };
}

/**
 * The customer accepts the invitation: chooses a password and accepts the
 * terms. One transaction consumes the token, sets the password and stamps
 * `activated_at` and `accepted_terms_at`.
 *
 * An unknown, used, expired or *reset* token is `TOKEN_INVALID` -- the same
 * answer for every case, as with password resets. So is an invitation for an
 * account that already has a password.
 */
export async function acceptInvitation(
  db: Db,
  input: { token: string; password: string }
): Promise<Result<{ email: string }>> {
  const row = await db.passwordReset.findUnique({ where: { tokenHash: hashToken(input.token) } });
  if (!row || row.purpose !== 'INVITATION' || row.consumedAt || row.expiresAt <= new Date()) {
    return fail('TOKEN_INVALID');
  }

  const passwordHash = await hashPassword(input.password);
  return db.$transaction(async (tx: DbTransactionClient): Promise<Result<{ email: string }>> => {
    // Conditional: two submissions of the same link cannot both win.
    const consumed = await tx.passwordReset.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) return fail('TOKEN_INVALID');

    // Conditional on "no password yet": an invitation never overwrites a
    // password the customer already chose (say, through a reset that ran
    // after the invitation was issued, even a concurrent one).
    const set = await tx.user.updateMany({ where: { id: row.userId, passwordHash: null }, data: { passwordHash } });
    if (set.count === 0) return fail('TOKEN_INVALID');

    const now = new Date();
    const user = await tx.user.findUniqueOrThrow({ where: { id: row.userId }, select: { email: true } });
    await tx.customerProfile.update({
      where: { userId: row.userId },
      data: { activatedAt: now, acceptedTermsAt: now },
    });
    return ok({ email: user.email });
  });
}
