import { z } from 'zod';
import { tripTranslationSchema } from './trips';

/**
 * A gallery photo as served by the public catalogue -- same fields as the
 * staff-facing `TripImage` component, minus `tripId` (a public response is
 * already scoped to one trip). `url` is computed at the HTTP boundary from
 * `storageKey` (see `withImageUrls` in
 * `apps/api/src/lib/http/trip-response.ts`) the same way it is for every
 * other trip-image response -- the domain's own `PublicTripImageDto` does
 * not carry it, but this schema models the actual wire shape the route
 * sends, which does.
 */
export const publicTripImageSchema = z.object({
  id: z.string().uuid(),
  storageKey: z.string(),
  position: z.number().int().nonnegative(),
  isCover: z.boolean(),
  altText: z.string().nullable(),
  url: z.string(),
});

/**
 * The public trip catalogue's own response shapes. Deliberately missing
 * every field the agency's own costing or authorship depends on
 * (`budgetTotalCents`, `marginMode`, `marginValue`, `preSoldSeats`,
 * `createdById`) -- see `docs/business-rules/trips.md`, "El catálogo
 * público", and `@rm/domain-trips`' `PublicTripSummaryDto` /
 * `PublicTripDetailDto`, which these mirror field for field.
 */
export const publicTripSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  departureDate: z.iso.datetime(),
  returnDate: z.iso.datetime(),
  pricePerSeatCents: z.number().int(),
  availableSeats: z.number().int(),
  images: z.array(publicTripImageSchema),
});

export const publicTripDetailSchema = z.object({
  slug: z.string(),
  departureDate: z.iso.datetime(),
  returnDate: z.iso.datetime(),
  pricePerSeatCents: z.number().int(),
  availableSeats: z.number().int(),
  translations: z.array(tripTranslationSchema),
  images: z.array(publicTripImageSchema),
});

export type PublicTripSummaryContract = z.infer<typeof publicTripSummarySchema>;
export type PublicTripDetailContract = z.infer<typeof publicTripDetailSchema>;
