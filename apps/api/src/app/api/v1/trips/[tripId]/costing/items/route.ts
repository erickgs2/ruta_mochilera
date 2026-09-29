import { budgetItemRequestSchema, type BudgetItemRequest } from '@rm/contracts';
import { addBudgetItem } from '@rm/domain-costing';
import { db } from '../../../../../../../lib/db';
import { route } from '../../../../../../../lib/http/route';

export const POST = route<BudgetItemRequest, unknown>({
  permission: 'trip.budget.manage',
  body: budgetItemRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body, params }) => addBudgetItem(db(), actor, params['tripId'], body),
});
