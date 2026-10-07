import { Prisma, uniqueViolationIndex, type CustomerOrigin, type Db, type DbTransactionClient, type Locale, type ReservationStatus } from '@rm/db';
import { recordAudit } from '@rm/domain-audit';
import { invitationEmailMessage, issueInvitationToken } from '@rm/domain-identity';
import { organizationProfile } from '@rm/domain-settings';
import type { EmailProvider } from '@rm/email';
import { fail, ok, type Result } from '@rm/shared-utils';

/**
 * Customers at the counter (Phase 2B, business rule 5.1): find them, register
 * them when they have no account, and invite them to activate it.
 * See `docs/business-rules/customers.md`.
 */

export interface CustomerSummaryDto {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  origin: CustomerOrigin;
  /** Null until the customer sets a password (self-registered customers always have one). */
  activatedAt: Date | null;
  invitedAt: Date | null;
  hasPassword: boolean;
  createdAt: Date;
}

export interface CustomerReservationDto {
  id: string;
  code: string;
  status: ReservationStatus;
  tripName: string;
  departureDate: Date;
  totalPriceCents: number;
  paidCents: number;
  createdAt: Date;
}

export interface CustomerDetailDto extends CustomerSummaryDto {
  birthDate: Date;
  locale: Locale;
  emailVerifiedAt: Date | null;
  acceptedTermsAt: Date | null;
  reservations: CustomerReservationDto[];
}

export interface CustomerPageDto {
  items: CustomerSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SearchCustomersInput {
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface CreateBranchCustomerInput {
  fullName: string;
  email: string;
  phone: string;
  /** `YYYY-MM-DD`, a calendar date. */
  birthDate: string;
  locale?: Locale;
}

export interface CustomerMailContext {
  email: EmailProvider;
  clientAppUrl: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 50;

/**
 * Lower-cases and strips accents, the same way the SQL below folds the
 * stored values with `translate()`: «María» and «maria» meet in the middle.
 * No `unaccent` extension, so nothing to install on the database.
 */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
const ACCENTED = 'áàäâãåéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ';
const PLAIN = 'aaaaaaeeeeiiiiooooouuuuncaaaaaaeeeeiiiiooooouuuunc';

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

type CustomerRow = Prisma.CustomerProfileGetPayload<{ include: { user: true } }>;

function toSummary(row: CustomerRow): CustomerSummaryDto {
  return {
    id: row.userId,
    fullName: row.fullName,
    email: row.user.email,
    phone: row.phone,
    origin: row.origin,
    activatedAt: row.activatedAt,
    invitedAt: row.invitedAt,
    hasPassword: row.user.passwordHash !== null,
    createdAt: row.user.createdAt,
  };
}

/**
 * Finds customers by name, email or phone, accent- and case-insensitive,
 * paginated (`customer.view`). Only `CUSTOMER` users: staff never show up.
 * The phone matches on digits alone, so «352-100» finds «352 100 80 79».
 * No query lists every customer, newest first.
 */
export async function searchCustomers(db: Db, input: SearchCustomersInput = {}): Promise<Result<CustomerPageDto>> {
  const pageSize = Math.min(Math.max(1, Math.trunc(input.pageSize ?? 20)), MAX_PAGE_SIZE);
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const query = (input.query ?? '').trim();

  let where = Prisma.sql`u.type = 'CUSTOMER'`;
  if (query !== '') {
    const text = likePattern(fold(query));
    const digits = query.replace(/\D/g, '');
    const phoneMatch =
      digits.length >= 3
        ? Prisma.sql`OR regexp_replace(cp.phone, '\\D', '', 'g') LIKE ${likePattern(digits)}`
        : Prisma.empty;
    where = Prisma.sql`${where} AND (
      translate(lower(cp.full_name), ${ACCENTED}, ${PLAIN}) LIKE ${text}
      OR lower(u.email) LIKE ${text}
      ${phoneMatch}
    )`;
  }

  const [ids, counted] = await Promise.all([
    db.$queryRaw<{ user_id: string }[]>`
      SELECT cp.user_id FROM customer_profiles cp JOIN users u ON u.id = cp.user_id
      WHERE ${where}
      ORDER BY ${query === '' ? Prisma.sql`u.created_at DESC` : Prisma.sql`cp.full_name ASC`}, cp.user_id
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `,
    db.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total FROM customer_profiles cp JOIN users u ON u.id = cp.user_id WHERE ${where}
    `,
  ]);

  const rows = await db.customerProfile.findMany({
    where: { userId: { in: ids.map((row) => row.user_id) } },
    include: { user: true },
  });
  const byId = new Map(rows.map((row) => [row.userId, row]));
  return ok({
    items: ids.flatMap((row) => {
      const found = byId.get(row.user_id);
      return found ? [toSummary(found)] : [];
    }),
    total: Number(counted[0]?.total ?? 0),
    page,
    pageSize,
  });
}

/** One customer with their reservations, for the panel's customer page. */
export async function getCustomerForStaff(db: Db, customerId: string): Promise<Result<CustomerDetailDto>> {
  if (!UUID_PATTERN.test(customerId)) return fail('NOT_FOUND');
  const row = await db.customerProfile.findUnique({
    where: { userId: customerId },
    include: {
      user: true,
      reservations: {
        orderBy: { createdAt: 'desc' },
        include: { trip: { select: { slug: true, departureDate: true, translations: { select: { locale: true, name: true } } } } },
      },
    },
  });
  if (!row || row.user.type !== 'CUSTOMER') return fail('NOT_FOUND');

  return ok({
    ...toSummary(row),
    birthDate: row.birthDate,
    locale: row.user.locale,
    emailVerifiedAt: row.user.emailVerifiedAt,
    acceptedTermsAt: row.acceptedTermsAt,
    reservations: row.reservations.map((reservation) => {
      const translation =
        reservation.trip.translations.find((candidate) => candidate.locale === 'es') ?? reservation.trip.translations[0];
      return {
        id: reservation.id,
        code: reservation.code,
        status: reservation.status,
        tripName: translation?.name ?? reservation.trip.slug,
        departureDate: reservation.trip.departureDate,
        totalPriceCents: reservation.totalPriceCents,
        paidCents: reservation.paidCents,
        createdAt: reservation.createdAt,
      };
    }),
  });
}

/**
 * Registers a customer at the counter (`customer.manage`): a `CUSTOMER`
 * whose email is **already verified** -- staff checked it in person --, with
 * **no password**, `origin = BRANCH`, terms not accepted yet. Audited.
 *
 * An email that already belongs to a customer is not duplicated:
 * `CUSTOMER_ALREADY_EXISTS` carries the existing id so the panel can open
 * them. An email that belongs to staff is `EMAIL_ALREADY_REGISTERED`.
 *
 * Unless `sendInvitation` is false, the invitation goes out **after** the
 * commit (no network inside a transaction). A provider failure does not undo
 * the registration: the answer says `invitationSent: false` and staff can
 * resend.
 */
export async function createBranchCustomer(
  db: Db,
  mail: CustomerMailContext,
  input: CreateBranchCustomerInput,
  options: { sendInvitation: boolean; actorId: string }
): Promise<Result<CustomerDetailDto & { invitationSent: boolean }>> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, type: true },
  });
  if (existing) {
    return existing.type === 'CUSTOMER'
      ? fail('CUSTOMER_ALREADY_EXISTS', { customerId: existing.id })
      : fail('EMAIL_ALREADY_REGISTERED');
  }

  let created: { userId: string; invitation?: { token: string; expiresAt: Date } };
  try {
    created = await db.$transaction(async (tx: DbTransactionClient) => {
      const user = await tx.user.create({
        data: {
          email,
          type: 'CUSTOMER',
          emailVerifiedAt: new Date(),
          locale: input.locale ?? 'es',
          customerProfile: {
            create: {
              fullName: input.fullName.trim(),
              phone: input.phone.trim(),
              birthDate: new Date(`${input.birthDate}T00:00:00Z`),
              origin: 'BRANCH',
              invitedAt: options.sendInvitation ? new Date() : null,
            },
          },
        },
      });
      await recordAudit(tx, {
        actorUserId: options.actorId,
        action: 'customer.created',
        entityType: 'User',
        entityId: user.id,
        after: { email, origin: 'BRANCH', fullName: input.fullName.trim(), invited: options.sendInvitation },
      });
      const invitation = options.sendInvitation ? await issueInvitationToken(tx, user.id) : undefined;
      return { userId: user.id, invitation };
    });
  } catch (error) {
    // Two registrations of the same email at once: the second lands on the
    // unique index after the pre-check above passed for both.
    if (uniqueViolationIndex(error) === 'users_email_key') {
      const winner = await db.user.findFirst({ where: { email }, select: { id: true } });
      return fail('CUSTOMER_ALREADY_EXISTS', { customerId: winner?.id });
    }
    throw error;
  }

  const invitationSent = created.invitation
    ? await mailInvitation(db, mail, created.userId, created.invitation)
    : false;
  const detail = await getCustomerForStaff(db, created.userId);
  if (!detail.ok) return detail;
  return ok({ ...detail.value, invitationSent });
}

async function mailInvitation(
  db: Db,
  mail: CustomerMailContext,
  userId: string,
  invitation: { token: string; expiresAt: Date }
): Promise<boolean> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { customerProfile: true } });
  const organization = await organizationProfile(db);
  const sent = await mail.email.send(
    invitationEmailMessage({
      to: user.email,
      fullName: user.customerProfile?.fullName ?? user.email,
      locale: user.locale,
      token: invitation.token,
      clientAppUrl: mail.clientAppUrl,
      organizationName: organization.name,
      expiresAt: invitation.expiresAt,
    })
  );
  return sent.ok;
}

/**
 * Sends (or re-sends) the invitation to a customer who has no password yet.
 * Each new invitation invalidates the previous one. A customer who already
 * has a password is `CONFLICT`: there is nothing to activate -- they can use
 * «forgot password». The provider failing is `EMAIL_PROVIDER_ERROR`; the new
 * token is already stored, so trying again is safe.
 */
export async function sendCustomerInvitation(
  db: Db,
  mail: CustomerMailContext,
  input: { customerId: string; actorId: string }
): Promise<Result<CustomerDetailDto>> {
  if (!UUID_PATTERN.test(input.customerId)) return fail('NOT_FOUND');
  const user = await db.user.findUnique({ where: { id: input.customerId }, include: { customerProfile: true } });
  if (!user || user.type !== 'CUSTOMER' || !user.customerProfile) return fail('NOT_FOUND');
  if (user.passwordHash !== null) return fail('CONFLICT', { reason: 'ALREADY_ACTIVE' });

  const invitation = await db.$transaction(async (tx: DbTransactionClient) => {
    const issued = await issueInvitationToken(tx, user.id);
    await tx.customerProfile.update({ where: { userId: user.id }, data: { invitedAt: new Date() } });
    await recordAudit(tx, {
      actorUserId: input.actorId,
      action: 'customer.invited',
      entityType: 'User',
      entityId: user.id,
    });
    return issued;
  });

  if (!(await mailInvitation(db, mail, user.id, invitation))) return fail('EMAIL_PROVIDER_ERROR');
  return getCustomerForStaff(db, user.id);
}
