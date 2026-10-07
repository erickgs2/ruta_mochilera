import {
  createBranchCustomerRequestSchema,
  searchCustomersQuerySchema,
  type CreateBranchCustomerRequest,
} from '@rm/contracts';
import { createBranchCustomer, searchCustomers } from '@rm/domain-customers';
import { fail } from '@rm/shared-utils';
import { config } from '../../../../../lib/config';
import { db } from '../../../../../lib/db';
import { email } from '../../../../../lib/email';
import { route } from '../../../../../lib/http/route';

/**
 * The counter's customer search (Phase 2B, §5.1): by name, email or phone,
 * accent- and case-insensitive, paginated. The query string is validated by
 * hand against `searchCustomersQuerySchema`, like the other list endpoints.
 */
export const GET = route({
  permission: 'customer.view',
  handler: async ({ request }) => {
    const params = new URL(request.url).searchParams;
    const parsed = searchCustomersQuerySchema.safeParse({
      search: params.get('search') ?? undefined,
      page: params.get('page') ?? undefined,
      pageSize: params.get('pageSize') ?? undefined,
    });
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      });
    }
    return searchCustomers(db(), { query: parsed.data.search, page: parsed.data.page, pageSize: parsed.data.pageSize });
  },
});

/** Registers a customer at the counter, verified and without a password, and invites them unless told not to. */
export const POST = route<CreateBranchCustomerRequest, unknown>({
  permission: 'customer.manage',
  body: createBranchCustomerRequestSchema,
  successStatus: 201,
  handler: async ({ actor, body }) =>
    createBranchCustomer(
      db(),
      { email: email(), clientAppUrl: config().clientAppUrl },
      { fullName: body.fullName, email: body.email, phone: body.phone, birthDate: body.birthDate, locale: body.locale },
      { sendInvitation: body.sendInvitation, actorId: actor.userId }
    ),
});
