import { budgetItemRequestSchema, type BudgetItemRequest } from '@rm/contracts';
import { deleteBudgetItem, updateBudgetItem } from '@rm/domain-costing';
import { db } from '../../../../../../../../lib/db';
import { route } from '../../../../../../../../lib/http/route';

export const PUT = route<BudgetItemRequest, unknown>({
  permission: 'trip.budget.manage',
  body: budgetItemRequestSchema,
  handler: async ({ actor, body, params }) => updateBudgetItem(db(), actor, params['itemId'], body),
});

export const DELETE = route({
  permission: 'trip.budget.manage',
  handler: async ({ actor, params }) => deleteBudgetItem(db(), actor, params['itemId']),
});
