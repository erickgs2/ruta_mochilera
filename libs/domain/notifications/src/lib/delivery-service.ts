import type { Db, DbTransactionClient, NotificationDelivery } from '@rm/db';
import type { EmailProvider } from '@rm/email';
import { SEND_NOTIFICATION_EMAIL_JOB, type SendNotificationEmailPayload } from '@rm/jobs';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { PermissionKey } from '@rm/domain-rbac';
import { fromPrisma, type PgBoss } from 'pg-boss';
import { renderTemplate, type DeliveryEventType } from './templates';

/**
 * The one pg-boss capability `notifyCustomer`/`notifyAdmins` need: enqueuing
 * the send job on the caller's own transaction (Ruling 11, see this file's
 * doc comment above `deliverToUser`). Narrowed to `send` on purpose, so a
 * test can pass a real `PgBoss` instance without this module reaching for
 * anything else on it.
 */
export type NotificationQueue = Pick<PgBoss, 'send'>;

export interface NotifyCustomerInput {
  customerId: string;
  eventType: DeliveryEventType;
  params: Record<string, string>;
  /**
   * The reservation this notice is about, when there is exactly one.
   * Stamped onto both delivery rows so a later idempotency check (e.g.
   * `warnExpiringHolds`: "did I already warn about *this* reservation?")
   * is unambiguous even when the customer holds more than one reservation.
   * Omit for event types with no single reservation to point at.
   */
  reservationId?: string;
}

export interface NotifyAdminsInput {
  eventType: AdminAlertEventType;
  params: Record<string, string>;
  reservationId?: string;
}

export interface InboxItemDto {
  id: string;
  eventType: string;
  /** The reservation the notice is about, so the panel can link to it; `null` for events with no single reservation. */
  reservationId: string | null;
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
  /** The customer's unread INBOX deliveries in total (`read_at` null), independent of the page. */
  unreadCount: number;
}

export interface ListInboxOptions {
  limit?: number;
  cursor?: string;
}

/**
 * Who each staff alert reaches: every active staff user whose roles grant **at
 * least one** of the event's permissions. The audience follows what the person
 * can act on, not a blanket "admins" list:
 * - a cancellation request goes to whoever can cancel (business rule 5.6);
 * - the money alerts (an orphan payment, a `paid_cents` drift) go to whoever
 *   can see payments or apply credit.
 *
 * Alerts about collection risk (overdue and at-risk reservations) are meant for
 * holders of `reservation.risk.view`; they join this table when the event that
 * raises them exists. Declaring an event here is what makes it sendable:
 * `notifyAdmins` only accepts the keys of this table.
 */
const ADMIN_ALERT_AUDIENCE = {
  CANCELLATION_REQUESTED: ['reservation.cancel'],
  ORPHAN_PAYMENT: ['payment.view', 'payment.credit.apply'],
  PAID_CENTS_MISMATCH: ['payment.view', 'payment.credit.apply'],
} as const satisfies Partial<Record<DeliveryEventType, readonly PermissionKey[]>>;

export type AdminAlertEventType = keyof typeof ADMIN_ALERT_AUDIENCE;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function toInboxItemDto(row: NotificationDelivery): InboxItemDto {
  return {
    id: row.id,
    eventType: row.eventType,
    reservationId: row.reservationId,
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
 * Writes the EMAIL/INBOX pair for one recipient and enqueues the actual
 * send, entirely through `tx`. Shared by `notifyCustomer` (one recipient)
 * and `notifyAdmins` (one call per eligible staff user).
 *
 * The INBOX row is `SENT` the moment it is written: showing it in the app
 * *is* delivering it, with nothing external that can fail. The EMAIL row
 * starts and stays `PENDING` here -- `deliverQueuedEmail` is the only thing
 * that ever moves it to `SENT` or `FAILED`, and it runs later, outside this
 * transaction, as `apps/worker`'s handler for `SEND_NOTIFICATION_EMAIL_JOB`.
 *
 * See this file's module doc comment (and `docs/business-rules/
 * notifications.md`, "La frontera transaccional") for why: `queue.send`
 * writes pg-boss's own job row through `fromPrisma(tx)`, the same
 * transaction and the same connection as the two rows above. If `tx` rolls
 * back, the INSERT into pg-boss's job table rolls back with it -- the send
 * can never survive a business fact that did not.
 */
async function deliverToUser(
  tx: DbTransactionClient,
  queue: NotificationQueue,
  recipient: { userId: string },
  eventType: DeliveryEventType,
  params: Record<string, string>,
  reservationId: string | undefined,
  rendered: { subject: string; body: string }
): Promise<void> {
  await tx.notificationDelivery.create({
    data: {
      userId: recipient.userId,
      reservationId: reservationId ?? null,
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
      reservationId: reservationId ?? null,
      eventType,
      channel: 'EMAIL',
      renderedTitle: rendered.subject,
      renderedBody: rendered.body,
      status: 'PENDING',
    },
  });

  const payload: SendNotificationEmailPayload = { deliveryId: emailRow.id };
  await queue.send(SEND_NOTIFICATION_EMAIL_JOB, payload, { db: fromPrisma(tx) });
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
 * for the full "rows are transactional, the send is not" rule, now backed by
 * a real outbox (Ruling 11) instead of caller discipline alone.
 */
export async function notifyCustomer(
  tx: DbTransactionClient,
  queue: NotificationQueue,
  input: NotifyCustomerInput
): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: input.customerId },
    select: { id: true, locale: true },
  });

  const rendered = renderTemplate(input.eventType, user.locale, input.params);
  await deliverToUser(tx, queue, { userId: user.id }, input.eventType, input.params, input.reservationId, rendered);
}

/**
 * Writes the same notice to every live staff user whose roles grant any of the
 * permissions in `ADMIN_ALERT_AUDIENCE` for this event -- the alerts that have
 * no customer to go to. Recipients are resolved here, at send time, from the
 * roles as they are now; a user matching through several permissions or roles
 * still gets one notice, and a disabled user none. Writes nothing, and never
 * throws, when nobody currently holds a matching permission.
 */
export async function notifyAdmins(
  tx: DbTransactionClient,
  queue: NotificationQueue,
  input: NotifyAdminsInput
): Promise<void> {
  const permissionKeys = [...ADMIN_ALERT_AUDIENCE[input.eventType]];
  const recipients = await tx.user.findMany({
    where: {
      type: 'STAFF',
      status: 'ACTIVE',
      roles: { some: { role: { permissions: { some: { permission: { key: { in: permissionKeys } } } } } } },
    },
    select: { id: true, locale: true },
  });

  for (const recipient of recipients) {
    const rendered = renderTemplate(input.eventType, recipient.locale, input.params);
    await deliverToUser(
      tx,
      queue,
      { userId: recipient.id },
      input.eventType,
      input.params,
      input.reservationId,
      rendered
    );
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * The worker-side half of the outbox: reads the `EMAIL` row `deliveryId`
 * names, sends it through `email` using its already-frozen
 * `renderedTitle`/`renderedBody`, and marks the row `SENT` or `FAILED`.
 * Never the recipient's address from the row itself -- that is read fresh
 * from `User.email` here, at send time, because only the *text* is meant to
 * be frozen history; the address a reminder reaches is whatever the account
 * currently has on file.
 *
 * Runs outside any business transaction, deliberately: by the time this is
 * called (`apps/worker`'s handler for `SEND_NOTIFICATION_EMAIL_JOB`), the
 * transaction that wrote the row has already committed, which is the entire
 * point of Ruling 11 -- the send cannot run before the fact it reports on is
 * durable.
 *
 * **Idempotent.** pg-boss's `work`/`fetch` deliver at least once, never
 * exactly once, so a delivery already `SENT` or `FAILED` is left alone
 * rather than sent twice: the second delivery of the same job is a no-op,
 * not a second email.
 *
 * **Never throws.** A malformed address or a provider outage marks the row
 * `FAILED` with the error and leaves the `INBOX` copy exactly as it was --
 * the same guarantee Task 7 gave when this function's work still lived
 * inside `notifyCustomer` itself.
 */
export async function deliverQueuedEmail(db: Db, email: EmailProvider, deliveryId: string): Promise<void> {
  const delivery = await db.notificationDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery || delivery.channel !== 'EMAIL' || delivery.status !== 'PENDING') return;

  const user = await db.user.findUniqueOrThrow({ where: { id: delivery.userId }, select: { email: true } });

  const sendResult = await email.send({
    to: user.email,
    subject: delivery.renderedTitle,
    // Escaped: the rendered text interpolates values people typed -- a
    // customer's cancellation reason, their name -- and this HTML lands in
    // staff inboxes. The plain-text part needs no escaping.
    html: `<p>${escapeHtml(delivery.renderedBody)}</p>`,
    text: delivery.renderedBody,
  });

  if (sendResult.ok) {
    await db.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: 'SENT', sentAt: new Date() },
    });
  } else {
    await db.notificationDelivery.update({
      where: { id: deliveryId },
      data: { status: 'FAILED', error: JSON.stringify(sendResult.error) },
    });
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

  // Over every page, not this one: the app's unread badge must not depend on
  // how far the customer has scrolled.
  const unreadCount = await db.notificationDelivery.count({
    where: { userId: customerId, channel: 'INBOX', readAt: null },
  });

  return ok({
    items: page.map(toInboxItemDto),
    nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
    unreadCount,
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

/**
 * Marks every unread INBOX delivery of one user as read, for the panel's
 * "mark all read". Scoped to the caller's own INBOX rows -- never their EMAIL
 * rows, which track sending, nor anyone else's -- and rows already read keep
 * their original `read_at`. Having nothing unread is not an error.
 */
export async function markAllRead(db: Db, userId: string): Promise<Result<null>> {
  await db.notificationDelivery.updateMany({
    where: { userId, channel: 'INBOX', readAt: null },
    data: { status: 'READ', readAt: new Date() },
  });
  return ok(null);
}
