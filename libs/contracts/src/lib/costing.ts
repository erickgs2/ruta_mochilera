import { z } from 'zod';

export const budgetItemRequestSchema = z.object({
  concept: z.string().min(2).max(120),
  supplier: z.string().max(120).optional(),
  quantity: z.number().int().positive().max(10_000),
  unitAmountCents: z.number().int().positive(),
  notes: z.string().max(500).optional(),
});

export const pricingPolicyRequestSchema = z.object({
  marginMode: z.enum(['PERCENTAGE', 'FIXED_TOTAL', 'FIXED_PER_SEAT']),
  marginValue: z.number().int().nonnegative(),
  priceMode: z.enum(['AUTO', 'MANUAL']),
  manualPricePerSeatCents: z.number().int().positive().optional(),
});

export type BudgetItemRequest = z.infer<typeof budgetItemRequestSchema>;
export type PricingPolicyRequest = z.infer<typeof pricingPolicyRequestSchema>;
