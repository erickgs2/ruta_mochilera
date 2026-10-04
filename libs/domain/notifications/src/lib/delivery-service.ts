import type { Db, DbTransactionClient, Locale, NotificationDelivery } from '@rm/db';
import type { EmailProvider } from '@rm/email';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { PermissionKey } from '@rm/domain-rbac';
import { renderTemplate, type DeliveryEventType } from './templates';

export interface NotifyCustomerInput {
  customerId: string;
  eventType: DeliveryEventType;
  params: Record<string, string>;
}

export interface NotifyAdminsInput {
  eventType: DeliveryEventType;
  params: Record<string, string>;
}

export interface InboxItemDto {
  id: string;
  eventType: string;
  title: string;
  body: string;
  status: NotificationDelivery['status'];
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface InboxPageDto {
  items: InboxItemDto[];
  nextCursor: string | null;
}

export interface ListInboxOptions {
  limit?: number;
  cursor?: string;
}

/**
 * Every Phase 2A alert routed to staff instead of a customer goes to whoever
 * holds this one permission: the cancellation request (business rule 5.6),
 * the orphan OXXO payment (5.3) and the nightly `paid_cents` drift alert.
 * Not a parameter of `notifyAdmins` because nothing in this phase needs a
 * different audience -- all three are "something a person who can act on a
 * reservation needs to see".
 */
const ADMIN_ALERT_PERMISSION: PermissionKey = 'reservation.cancel';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function toInboxItemDto(row: NotificationDelivery): InboxItemDto {
  return {
    id: row.id,
    eventType: row.eventType,
    title: row.renderedTitle,
    body: row.renderedBody,
    status: row.status,
    sentAt: row.sentAt,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(row: Pick<NotificationDelivery, 'id' | 'createdAt'>): string {
  const payload: Cursor = { createdAt: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Result<Cursor> {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      return fail('VALIDATION_FAILED', { field: 'cursor' });
    }
    return ok(parsed as Cursor);
  } catch {
    return fail('VALIDATION_FAILED', { field: 'cursor' });
  }
}

/**
 * Writes the EMAIL/INBOX pair for one recipient and attempts the send,
 * entirely through `tx`. Shared by `notifyCustomer` (one recipient) and
 * `notifyAdmins` (one call per eligible staff user).
 *
 * The INBOX row is `SENT` the moment it is written: showing it in the app
 * *is* delivering it, with nothing external that can fail. The EMAIL row
 * starts `PENDING` and is updated to `SENT` or `FAILED` right after the
 * `EmailProvider.send` call resolves -- a provider failure never throws
 * out of this function (business rule: the in-app copy must survive a
 * provider outage) and never removes either row.
 */
async function deliverToUser(
  tx: DbTransactionClient,
  email: EmailProvider,
  recipient: { userId: string; emailAddress: string; locale: Locale },
  eventType: DeliveryEventType,
  params: Record<string, string>
): Promise<void> {
  const rendered = renderTemplate(eventType, recipient.locale, params);

  await tx.notificationDelivery.create({
    data: {
      userId: recipient.userId,
      eventType,
      channel: 'INBOX',
      renderedTitle: rendered.subject,
      renderedBody: rendered.body,
      status: 'SENT',
      sentAt: new Date(),
    },
  });

  const emailRow = await tx.notificationDelivery.create({
    data: {
      userId: recipient.userId,
      eventType,
      channel: 'EMAIL',
      renderedTitle: rendered.subject,
      renderedBody: rendered.body,
      status: 'PENDING',
    },
  });

  const sendResult = await email.send({
    to: recipient.emailAddress,
    subject: rendered.subject,
    html: `<p>${rendered.body}</p>`,
    text: rendered.body,
  });

  if (sendResult.ok) {
    await tx.notificationDelivery.update({
      where: { id: emailRow.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
  } else {
    await tx.notificationDelivery.update({
      where: { id: emailRow.id },
      data: { status: 'FAILED', error: JSON.stringify(sendResult.error) },
    });
  }
}

/**
 * Writes a notice for one customer: one `EMAIL` row and one `INBOX` row,
 * same rendered text, rendered now in the customer's current locale and
 * frozen into the row -- changing their locale afterwards never rewrites
 * this history.
 *
 * Takes the caller's `tx` because the delivery about a business fact (a
 * payment, a cancellation) must not outlive that fact if the transaction
 * that established it rolls back. See `docs/business-rules/notifications.md`
 * for the full "rows are transactional, the send is not" rule and what it
 * asks of callers.
 */
export async function notifyCustomer(
  tx: DbTransactionClient,
  email: EmailProvider,
  input: NotifyCustomerInput
): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: input.customerId },
    select: { id: true, email: true, locale: true },
  });

  await deliverToUser(
    tx,
    email,
    { userId: user.id, emailAddress: user.email, locale: user.locale },
    input.eventType,
    input.params
  );
}

/**
 * Writes the same notice to every live staff user holding
 * `reservation.cancel` -- the three Phase 2A alerts that have no customer to
 * go to (see `ADMIN_ALERT_PERMISSION`). Writes nothing, and never throws,
 * when no staff user currently holds that permission.
 */
export async function notifyAdmins(
  tx: DbTransactionClient,
  email: EmailProvider,
  input: NotifyAdminsInput
): Promise<void> {
  const recipients = await tx.user.findMany({
    where: {
      type: 'STAFF',
      status: 'ACTIVE',
      roles: { some: { role: { permissions: { some: { permission: { key: ADMIN_ALERT_PERMISSION } } } } } },
    },
    select: { id: true, email: true, locale: true },
  });

  for (const recipient of recipients) {
    await deliverToUser(
      tx,
      email,
      { userId: recipient.id, emailAddress: recipient.email, locale: recipient.locale },
      input.eventType,
      input.params
    );
  }
}

/**
 * The customer's in-app inbox: `INBOX`-channel deliveries only (the `EMAIL`
 * row of each pair is never shown here -- it is the record of what left by
 * mail, not something to display twice). Most recent first, paged by an
 * opaque cursor over `(created_at, id)` so a tie on the timestamp cannot
 * duplicate or drop a row across pages.
 */
export async function listInbox(
  db: Db,
  customerId: string,
  options: ListInboxOptions = {}
): Promise<Result<InboxPageDto>> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  let cursor: Cursor | undefined;
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (!decoded.ok) return decoded;
    cursor = decoded.value;
  }

  const rows = await db.notificationDelivery.findMany({
    where: {
      userId: customerId,
      channel: 'INBOX',
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = page[page.length - 1];

  return ok({
    items: page.map(toInboxItemDto),
    nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
  });
}

/**
 * Marks one of the customer's own INBOX deliveries as read. An id that does
 * not exist and an id that belongs to someone else return the exact same
 * `DELIVERY_NOT_OWNED` -- same reasoning as `RESERVATION_NOT_OWNED`: a
 * different code for "not found" would let a customer walking ids tell the
 * two cases apart.
 */
export async function markRead(db: Db, deliveryId: string, customerId: string): Promise<Result<null>> {
  const delivery = await db.notificationDelivery.findUnique({ where: { id: deliveryId } });

  if (!delivery || delivery.userId !== customerId || delivery.channel !== 'INBOX') {
    return fail('DELIVERY_NOT_OWNED');
  }

  await db.notificationDelivery.update({
    where: { id: deliveryId },
    data: { status: 'READ', readAt: new Date() },
  });

  return ok(null);
}
