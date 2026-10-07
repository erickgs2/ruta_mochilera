import { z } from 'zod';
import { uuidSchema } from './common';

export const notificationStatusSchema = z.enum(['PENDING', 'SENT', 'FAILED', 'READ']);

/**
 * The query string of `GET /api/v1/notifications`. `limit` is coerced from
 * its wire form (a string) to a number and must be a positive integer --
 * `z.coerce.number()` turns a non-numeric value such as `abc` into `NaN`
 * internally, but then fails validation on it rather than letting it
 * through, which is exactly the gap this schema exists to close: an
 * unvalidated `Number(limitParam)` lets `NaN` reach `listInbox`'s own
 * `Math.min(Math.max(limit ?? DEFAULT, 1), MAX)` clamp, which cannot clean
 * up a `NaN` either (`??` does not catch it), and it was propagating all
 * the way into Prisma's `take` as a bare 500. This is the one schema the
 * route handler actually runs at request time -- `registry.ts` imports the
 * exact same object for the OpenAPI document, so the two cannot drift
 * apart the way they had (see the route's own doc comment).
 */
export const listInboxQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export type ListInboxQuery = z.infer<typeof listInboxQuerySchema>;

/** Response shape for one inbox entry, matching `@rm/domain-notifications`' `InboxItemDto`. */
export const inboxItemSchema = z.object({
  id: uuidSchema,
  eventType: z.string(),
  title: z.string(),
  body: z.string(),
  status: notificationStatusSchema,
  sentAt: z.iso.datetime().nullable(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

/** Response shape for one page of the inbox, matching `InboxPageDto`. */
export const inboxPageSchema = z.object({
  items: z.array(inboxItemSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});

export type InboxItemContract = z.infer<typeof inboxItemSchema>;
export type InboxPageContract = z.infer<typeof inboxPageSchema>;
