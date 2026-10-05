import { registerRequestSchema, type RegisterRequest } from '@rm/contracts';
import { registerCustomer } from '@rm/domain-identity';
import { db } from '../../../../../lib/db';
import { email } from '../../../../../lib/email';
import { clientIp } from '../../../../../lib/http/client-ip';
import { route } from '../../../../../lib/http/route';

/**
 * Always responds the same way whether or not `body.email` is already
 * registered -- see `registerCustomer`'s doc comment in
 * `@rm/domain-identity` for the enumeration argument. Never
 * `EMAIL_ALREADY_REGISTERED` here, unlike `/staff` (an administrator-created
 * account, where revealing a duplicate email to another administrator is
 * not an enumeration risk).
 */
export const POST = route<RegisterRequest, null>({
  auth: 'public',
  body: registerRequestSchema,
  handler: async ({ body, request }) =>
    registerCustomer(
      db(),
      email(),
      {
        email: body.email,
        password: body.password,
        fullName: body.fullName,
        phone: body.phone,
        birthDate: new Date(body.birthDate),
        acceptTerms: body.acceptTerms,
      },
      clientIp(request)
    ),
});
