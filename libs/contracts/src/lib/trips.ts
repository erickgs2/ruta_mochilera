import { z } from 'zod';
import { localeSchema } from './common';

export const tripTranslationSchema = z.object({
  locale: localeSchema,
  name: z.string().min(3).max(120),
  description: z.string().max(4000),
  itinerary: z.string().max(8000),
  includes: z.string().max(4000),
  excludes: z.string().max(4000),
});

const tripBodyShape = {
  departureDate: z.coerce.date(),
  returnDate: z.coerce.date(),
  paymentDeadline: z.coerce.date(),
  totalCapacity: z.number().int().positive().max(1000),
  preSoldSeats: z.number().int().nonnegative().max(1000).default(0),
  holdTtlHours: z.number().int().positive().max(720).default(72),
  minimumDepositCents: z.number().int().nonnegative(),
  marginMode: z.enum(['PERCENTAGE', 'FIXED_TOTAL', 'FIXED_PER_SEAT']),
  marginValue: z.number().int().nonnegative(),
  translations: z.array(tripTranslationSchema).min(1).max(2),
};

export const createTripRequestSchema = z.object({
  ...tripBodyShape,
  isBackfilled: z.boolean().default(false),
  initialStatus: z.enum(['DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
});

export const updateTripRequestSchema = z.object(tripBodyShape);

export const changeStatusRequestSchema = z.object({
  status: z.enum(['DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
});

export type CreateTripRequest = z.infer<typeof createTripRequestSchema>;
export type UpdateTripRequest = z.infer<typeof updateTripRequestSchema>;
export type ChangeStatusRequest = z.infer<typeof changeStatusRequestSchema>;
