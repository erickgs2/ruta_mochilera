import { z } from 'zod';
import { localeSchema, uuidSchema } from './common';

export const createStaffRequestSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(3).max(120),
  employeeCode: z.string().max(40).optional(),
  locale: localeSchema,
  password: z.string().min(10).max(128),
  roleIds: z.array(uuidSchema).max(20),
});

export const updateStaffRequestSchema = z.object({
  fullName: z.string().min(3).max(120),
  employeeCode: z.string().max(40).optional(),
  locale: localeSchema,
  status: z.enum(['ACTIVE', 'DISABLED']),
  roleIds: z.array(uuidSchema).max(20),
});

export const staffSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  fullName: z.string(),
  employeeCode: z.string().nullable(),
  status: z.enum(['ACTIVE', 'DISABLED']),
  locale: localeSchema,
  roleIds: z.array(uuidSchema),
});

export type CreateStaffRequest = z.infer<typeof createStaffRequestSchema>;
export type UpdateStaffRequest = z.infer<typeof updateStaffRequestSchema>;
export type StaffDtoContract = z.infer<typeof staffSchema>;
