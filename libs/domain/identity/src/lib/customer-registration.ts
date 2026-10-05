import { uniqueViolationIndex, type Db, type DbTransactionClient } from '@rm/db';
import type { EmailProvider } from '@rm/email';
import { fail, ok, type Result } from '@rm/shared-utils';
import { generateOtpCode, hashOtpCode, loadOtpSettings } from './otp';
import { hashPassword } from './password';
import { isRateLimited, recordFailedAttempt } from './rate-limiter';

export interface RegisterCustomerInput {
  email: string;
  password: string;
  fullName: string;
  phone: string;
  birthDate: Date;
  acceptTerms: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function buildVerificationEmail(code: string): { subject: string; html: string; text: string } {
  const text = `Tu código de verificación es ${code}. Vence pronto; si no lo solicitaste, ignora este correo.`;
  return { subject: 'Verifica tu correo', html: `<p>${text}</p>`, text };
}

/**
 * Sent instead of a verification code when someone tries to register with an
 * address that already has an account (see `registerCustomer`'s doc
 * comment). Deliberately carries no code: no new, unverified account was
 * created for this attempt, so there is nothing for the real owner to
 * confirm -- only something to be aware of.
 */
function buildRegistrationAttemptNoticeEmail(): { subject: string; html: string; text: string } {
  const text =
    'Alguien intentó crear una cuenta con tu correo. Si fuiste tú, ya tienes una cuenta: inicia sesión o ' +
    'recupera tu contraseña. Si no fuiste tú, puedes ignorar este mensaje.';
  return { subject: 'Intento de registro con tu correo', html: `<p>${text}</p>`, text };
}

/** The unique index backing `User.email` (see the `init` migration) -- same constant `staff-service.ts` defines for itself. */
const USER_EMAIL_UNIQUE_INDEX = 'users_email_key';

/**
 * Sends the "someone tried to register with your email" notice (see
 * `registerCustomer`'s doc comment) by re-reading the now-existing row.
 * Shared by the pre-check branch and the lost-race branch below, so both
 * paths to "this email already has an account" behave identically.
 */
async function sendRegistrationAttemptNotice(db: Db, email: string, emailProvider: EmailProvider): Promise<void> {
  const owner = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (!owner) return; // Should not happen (we only call this once the row is known to exist), but never throw over a notice email.
  await emailProvider.send({ to: owner.email, ...buildRegistrationAttemptNoticeEmail() });
}

async function createEmailVerification(
  tx: DbTransactionClient,
  userId: string,
  ttlMinutes: number
): Promise<{ code: string }> {
  const { code, codeHash } = generateOtpCode();
  await tx.emailVerification.create({
    data: {
      userId,
      codeHash,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    },
  });
  return { code };
}

/**
 * Registers a new customer and emails a six-digit verification code.
 *
 * **Enumeration decision (argued, per the brief's explicit ask):** this
 * function never reveals whether `input.email` already belongs to an
 * account. Phase 1 already chose silence over disclosure twice -- `login`
 * returns the same `INVALID_CREDENTIALS` for an unknown email and a wrong
 * password, and account recovery (Task 12's `requestPasswordReset`) answers
 * identically whether or not the account exists. Registration is treated
 * the same way, and arguably has the *stronger* case for it: unlike login,
 * a registration attempt needs no password at all, so a chatty
 * `EMAIL_ALREADY_REGISTERED` would turn this single public endpoint into a
 * zero-friction oracle for mass-checking a wordlist of emails against the
 * customer base. The usability cost -- someone who mistypes their own email
 * at signup gets no hint why nothing arrived -- is real but small (they can
 * always use "forgot password" instead, which is exactly what the notice
 * email below points them to), and it is outweighed by closing that oracle
 * on a brand-new, unauthenticated, password-free endpoint.
 *
 * Both branches (new email vs. already-registered) hash the submitted
 * password unconditionally, for the same reason `login` always runs argon2
 * against a real or dummy hash: skipping that work on the "already
 * registered" branch would reopen a timing side-channel even though the
 * HTTP response itself reveals nothing. The two branches still differ in
 * how many rows they write (none vs. several, inside one transaction), a
 * smaller and not independently tested gap -- see this module's test file
 * and the task report for why that asymmetry was accepted rather than
 * closed the way Task 12's `requestPasswordReset` closes its own.
 */
export async function registerCustomer(
  db: Db,
  emailProvider: EmailProvider,
  input: RegisterCustomerInput,
  ip = 'unknown'
): Promise<Result<null>> {
  const email = normalizeEmail(input.email);

  if (isRateLimited('register', email, ip)) return fail('RATE_LIMITED');
  recordFailedAttempt('register', email, ip);

  if (!input.acceptTerms) return fail('VALIDATION_FAILED', { field: 'acceptTerms' });

  // Paid unconditionally -- see the doc comment above.
  const passwordHash = await hashPassword(input.password);

  const existing = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (existing) {
    await sendRegistrationAttemptNotice(db, email, emailProvider);
    return ok(null);
  }

  const settings = await loadOtpSettings(db);

  let created: { code: string };
  try {
    created = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          type: 'CUSTOMER',
          passwordHash,
          customerProfile: {
            create: {
              fullName: input.fullName,
              phone: input.phone,
              birthDate: input.birthDate,
              origin: 'SELF_SIGNUP',
              acceptedTermsAt: new Date(),
            },
          },
        },
      });
      return createEmailVerification(tx, user.id, settings.ttlMinutes);
    });
  } catch (error) {
    // Closes the race the pre-check `findFirst` above cannot: two concurrent
    // registrations for the same brand-new email can both pass that check
    // before either has inserted, exactly the race `createStaff` already
    // guards against for staff accounts (see its own `isEmailConflict`).
    // The loser must fall back to the same enumeration-safe response as the
    // pre-check branch, not an unhandled exception surfacing as a bare 500.
    if (uniqueViolationIndex(error) === USER_EMAIL_UNIQUE_INDEX) {
      await sendRegistrationAttemptNotice(db, email, emailProvider);
      return ok(null);
    }
    throw error;
  }
  const { code } = created;

  // Sent only after the transaction above has committed: a rolled-back
  // registration (e.g. a unique-constraint race lost to a concurrent
  // request) must never result in an email going out. This is also why the
  // code is never queued through the Task 8 pg-boss outbox
  // (`SEND_NOTIFICATION_EMAIL_JOB`): that outbox durably persists its job
  // payload in Postgres until a worker picks it up, which would put the
  // plaintext code in a second place in clear storage, even if briefly --
  // exactly what "stored hashed, never in clear" is meant to rule out. A
  // direct, synchronous send after commit gives the same "rollback sends no
  // mail" guarantee without ever persisting the secret anywhere but the hash.
  await emailProvider.send({ to: email, ...buildVerificationEmail(code) });

  return ok(null);
}

interface VerifyEmailInput {
  email: string;
  code: string;
}

/**
 * Verifies a customer's email with a six-digit code. Only the single most
 * recent `EmailVerification` row for the user is ever considered "active" --
 * requesting a resend therefore implicitly supersedes any earlier code
 * without needing to mark it consumed.
 *
 * The generic per-process rate limiter (`./rate-limiter.ts`, scope
 * `verify-email`) is deliberately only consulted on the "no such user" /
 * "no pending verification" paths, never while an active code is being
 * guessed. Guessing an active code is already capped, precisely and
 * durably, by `otp.max_attempts` on the row itself -- layering the generic
 * limiter on top of that would collide at the default value both happen to
 * share (5): a test that exhausts `max_attempts` with wrong guesses and
 * then tries the correct code (expecting `OTP_MAX_ATTEMPTS`) would instead
 * observe `RATE_LIMITED` on that same call if every guess also counted
 * against the generic limiter. Keeping the generic limiter scoped to the
 * "nothing to guess against" paths avoids that collision while still
 * meeting the brief's requirement that this endpoint be rate-limited.
 */
export async function verifyEmail(db: Db, input: VerifyEmailInput, ip = 'unknown'): Promise<Result<null>> {
  const email = normalizeEmail(input.email);

  const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, type: 'CUSTOMER' } });
  if (!user) {
    if (isRateLimited('verify-email', email, ip)) return fail('RATE_LIMITED');
    recordFailedAttempt('verify-email', email, ip);
    return fail('OTP_INVALID');
  }

  const row = await db.emailVerification.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!row || row.consumedAt) {
    if (isRateLimited('verify-email', email, ip)) return fail('RATE_LIMITED');
    recordFailedAttempt('verify-email', email, ip);
    return fail('OTP_INVALID');
  }

  if (row.expiresAt <= new Date()) return fail('OTP_EXPIRED');

  const settings = await loadOtpSettings(db);
  if (row.attempts >= settings.maxAttempts) return fail('OTP_MAX_ATTEMPTS');

  if (hashOtpCode(input.code) !== row.codeHash) {
    await db.emailVerification.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    return fail('OTP_INVALID');
  }

  await db.$transaction([
    db.emailVerification.update({ where: { id: row.id }, data: { consumedAt: new Date() } }),
    db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } }),
    db.customerProfile.update({ where: { userId: user.id }, data: { activatedAt: new Date() } }),
  ]);

  return ok(null);
}

/**
 * Sends a fresh six-digit code, superseding whatever code was last issued
 * (see `verifyEmail`'s "most recent row wins" rule).
 *
 * Three independent throttles apply, checked in this order:
 * 1. the generic per-process limiter (scope `resend-code`), checked and
 *    recorded on *every* call regardless of outcome -- unlike `login`,
 *    which only records a failure, hammering this endpoint is itself the
 *    behaviour being defended against, whether or not any individual call
 *    would otherwise have succeeded;
 * 2. `otp.resend_cooldown_seconds` since the last code was issued
 *    (`OTP_RESEND_TOO_SOON`);
 * 3. `otp.max_resends_per_hour`, counted from actual `EmailVerification`
 *    rows created in the last hour -- a durable, DB-backed business rule
 *    (survives a restart, unlike the in-memory limiter above) that maps to
 *    the same `RATE_LIMITED` code as the generic limiter, since both mean
 *    "you are going too fast" to the caller.
 *
 * Does not reveal whether `email` belongs to an account, or whether that
 * account is already verified: either case returns the same success shape
 * with nothing sent, consistent with `registerCustomer`'s own enumeration
 * decision.
 */
export async function resendVerificationCode(
  db: Db,
  emailProvider: EmailProvider,
  rawEmail: string,
  ip = 'unknown'
): Promise<Result<null>> {
  const email = normalizeEmail(rawEmail);

  if (isRateLimited('resend-code', email, ip)) return fail('RATE_LIMITED');
  recordFailedAttempt('resend-code', email, ip);

  const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, type: 'CUSTOMER' } });
  if (!user || user.emailVerifiedAt) return ok(null);

  const settings = await loadOtpSettings(db);

  const lastRow = await db.emailVerification.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  if (lastRow) {
    const secondsSinceLast = (Date.now() - lastRow.createdAt.getTime()) / 1000;
    if (secondsSinceLast < settings.resendCooldownSeconds) return fail('OTP_RESEND_TOO_SOON');
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const resendsInLastHour = await db.emailVerification.count({
    where: { userId: user.id, createdAt: { gte: oneHourAgo } },
  });
  if (resendsInLastHour >= settings.maxResendsPerHour) return fail('RATE_LIMITED');

  const { code } = await createEmailVerification(db, user.id, settings.ttlMinutes);
  await emailProvider.send({ to: email, ...buildVerificationEmail(code) });

  return ok(null);
}
