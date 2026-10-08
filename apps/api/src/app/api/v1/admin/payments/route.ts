import { listStaffPaymentsQuerySchema } from '@rm/contracts';
import { listPendingVouchers } from '@rm/domain-payments';
import { fail } from '@rm/shared-utils';
import { db } from '../../../../../lib/db';
import { route } from '../../../../../lib/http/route';

/**
 * The counter's queue of OXXO and SPEI vouchers still waiting to be paid,
 * soonest-expiring first, paginated by an opaque keyset cursor. Gated on
 * `payment.view`, like the per-reservation history. The query string is
 * validated by hand against `listStaffPaymentsQuerySchema` -- the same schema
 * object `registry.ts` documents -- like the other list endpoints.
 */
export const GET = route({
  permission: 'payment.view',
  handler: async ({ request }) => {
    const params = new URL(request.url).searchParams;
    const parsed = listStaffPaymentsQuerySchema.safeParse({
      status: params.get('status') ?? undefined,
      method: params.get('method') ?? undefined,
      cursor: params.get('cursor') ?? undefined,
      limit: params.get('limit') ?? undefined,
    });
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      });
    }
    return listPendingVouchers(db(), { method: parsed.data.method, cursor: parsed.data.cursor, limit: parsed.data.limit });
  },
});
