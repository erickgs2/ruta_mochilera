import { z } from 'zod';

export const localeSchema = z.enum(['es', 'en']);
export const uuidSchema = z.string().uuid();

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type Problem = z.infer<typeof problemSchema>;
