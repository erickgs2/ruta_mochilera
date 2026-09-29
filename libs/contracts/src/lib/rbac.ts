import { z } from 'zod';
import { uuidSchema } from './common';

export const roleInputSchema = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(240),
  permissionKeys: z.array(z.string()).max(200),
});

export const roleSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string(),
  isSystem: z.boolean(),
  permissionKeys: z.array(z.string()),
  userCount: z.number().int().nonnegative(),
});

export const permissionSchema = z.object({
  key: z.string(),
  category: z.string(),
  description: z.string(),
});

export type RoleInputDto = z.infer<typeof roleInputSchema>;
export type RoleDtoContract = z.infer<typeof roleSchema>;
export type PermissionDto = z.infer<typeof permissionSchema>;
