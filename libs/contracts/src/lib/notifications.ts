import { z } from 'zod';
import { uuidSchema } from './common';

export const notificationStatusSchema = z.enum(['PENDING', 'SENT', 'FAILED', 'READ']);

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
});

export type InboxItemContract = z.infer<typeof inboxItemSchema>;
export type InboxPageContract = z.infer<typeof inboxPageSchema>;
