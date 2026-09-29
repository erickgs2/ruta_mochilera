import { pricingPolicyRequestSchema, type PricingPolicyRequest } from '@rm/contracts';
import { listBudgetItems, setPricingPolicy } from '@rm/domain-costing';
import { db } from '../../../../../../lib/db';
import { route } from '../../../../../../lib/http/route';

export const GET = route({
  permission: 'trip.budget.view',
  handler: async ({ params }) => listBudgetItems(db(), params['tripId']),
});

export const PUT = route<PricingPolicyRequest, unknown>({
  permission: 'trip.budget.manage',
  body: pricingPolicyRequestSchema,
  handler: async ({ actor, body, params }) => setPricingPolicy(db(), actor, params['tripId'], body),
});
