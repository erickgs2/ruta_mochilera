import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  authenticatedUserSchema as authenticatedUserSchemaImport,
  customerProfileSchema as customerProfileSchemaImport,
  updateCustomerProfileRequestSchema,
  budgetItemRequestSchema as budgetItemRequestSchemaImport,
  cancelReservationRequestSchema as cancelReservationRequestSchemaImport,
  declineCancellationRequestSchema as declineCancellationRequestSchemaImport,
  adjustCreditRequestSchema as adjustCreditRequestSchemaImport,
  applyPriceChangeRequestSchema as applyPriceChangeRequestSchemaImport,
  priceChangePreviewSchema as priceChangePreviewSchemaImport,
  createBranchReservationRequestSchema as createBranchReservationRequestSchemaImport,
  registerCashPaymentRequestSchema as registerCashPaymentRequestSchemaImport,
  acceptInvitationRequestSchema as acceptInvitationRequestSchemaImport,
  acceptedInvitationSchema as acceptedInvitationSchemaImport,
  createBranchCustomerRequestSchema as createBranchCustomerRequestSchemaImport,
  createdCustomerSchema as createdCustomerSchemaImport,
  customerDetailSchema as customerDetailSchemaImport,
  customerPageSchema as customerPageSchemaImport,
  searchCustomersQuerySchema,
  applyCreditRequestSchema as applyCreditRequestSchemaImport,
  creditEntrySchema as creditEntrySchemaImport,
  customerCreditSchema as customerCreditSchemaImport,
  refundCreditRequestSchema as refundCreditRequestSchemaImport,
  changeStatusRequestSchema as changeStatusRequestSchemaImport,
  createPaymentIntentRequestSchema as createPaymentIntentRequestSchemaImport,
  createReservationRequestSchema as createReservationRequestSchemaImport,
  createStaffRequestSchema as createStaffRequestSchemaImport,
  createTripRequestSchema as createTripRequestSchemaImport,
  createdPaymentIntentSchema as createdPaymentIntentSchemaImport,
  forgotPasswordRequestSchema as forgotPasswordRequestSchemaImport,
  inboxItemSchema as inboxItemSchemaImport,
  listInboxQuerySchema,
  listStaffReservationsQuerySchema,
  inboxPageSchema as inboxPageSchemaImport,
  loginRequestSchema as loginRequestSchemaImport,
  paymentSchema as paymentSchemaImport,
  permissionSchema as permissionSchemaImport,
  pricingPolicyRequestSchema as pricingPolicyRequestSchemaImport,
  problemSchema as problemSchemaImport,
  publicTripDetailSchema as publicTripDetailSchemaImport,
  publicTripSummarySchema as publicTripSummarySchemaImport,
  registerRequestSchema as registerRequestSchemaImport,
  requestCancellationRequestSchema as requestCancellationRequestSchemaImport,
  reservationDetailSchema as reservationDetailSchemaImport,
  reservationSchema as reservationSchemaImport,
  reservationSummarySchema as reservationSummarySchemaImport,
  resendCodeRequestSchema as resendCodeRequestSchemaImport,
  resetPasswordRequestSchema as resetPasswordRequestSchemaImport,
  roleInputSchema as roleInputSchemaImport,
  roleSchema as roleSchemaImport,
  sessionResponseSchema as sessionResponseSchemaImport,
  socialLoginRequestSchema as socialLoginRequestSchemaImport,
  staffReservationDetailSchema as staffReservationDetailSchemaImport,
  staffReservationSummarySchema as staffReservationSummarySchemaImport,
  staffSchema as staffSchemaImport,
  tripTranslationSchema,
  updateStaffRequestSchema as updateStaffRequestSchemaImport,
  updateTripRequestSchema as updateTripRequestSchemaImport,
  verifyEmailRequestSchema as verifyEmailRequestSchemaImport,
} from '@rm/contracts';
import type { TripCostingDto, BudgetItemDto } from '@rm/domain-costing';
import type { InboxItemDto, InboxPageDto } from '@rm/domain-notifications';
import type { CreatedPaymentIntentDto, PaymentDto } from '@rm/domain-payments';
import type {
  ReservationDto,
  ReservationSummaryDto,
  StaffReservationDetailDto,
  StaffReservationSummaryDto,
} from '@rm/domain-reservations';
import type { PublicTripDetailDto, PublicTripSummaryDto, TripDto, TripImageDto, TripSummaryDto } from '@rm/domain-trips';
import type { CustomerProfileDto } from '@rm/domain-identity';
import type { ReservationDetail } from '../http/reservation-response';

/**
 * `@rm/contracts` schemas are tagged with `.meta({ id })` here, rather than
 * registered by name through `OpenAPIRegistry.register(...)`. The registry's
 * `register` relies on the `zodSchema.openapi(...)` method that
 * `extendZodWithOpenApi` monkey-patches onto `ZodType.prototype` at runtime
 * -- but `@rm/contracts`'s schemas are already fully constructed by the time
 * this module's own top-level code would run that patch (ES module imports
 * evaluate before the importing module's body), so the patched method never
 * reaches them and `.openapi()` is `undefined` on every imported schema.
 * `.meta({ id })` is Zod 4's own, built-in mechanism (no prototype patch, no
 * import-order dependency) and the generator honours it identically: a
 * schema tagged this way still lands in `components.schemas` under `id` and
 * is referenced with `$ref` everywhere else it is used.
 */
const problemSchema = problemSchemaImport.meta({ id: 'Problem' });
const loginRequestSchema = loginRequestSchemaImport.meta({ id: 'LoginRequest' });
const registerRequestSchema = registerRequestSchemaImport.meta({ id: 'RegisterRequest' });
const verifyEmailRequestSchema = verifyEmailRequestSchemaImport.meta({ id: 'VerifyEmailRequest' });
const resendCodeRequestSchema = resendCodeRequestSchemaImport.meta({ id: 'ResendCodeRequest' });
const forgotPasswordRequestSchema = forgotPasswordRequestSchemaImport.meta({ id: 'ForgotPasswordRequest' });
const resetPasswordRequestSchema = resetPasswordRequestSchemaImport.meta({ id: 'ResetPasswordRequest' });
const socialLoginRequestSchema = socialLoginRequestSchemaImport.meta({ id: 'SocialLoginRequest' });
const authenticatedUserSchema = authenticatedUserSchemaImport.meta({ id: 'AuthenticatedUser' });
const customerProfileSchema = customerProfileSchemaImport.meta({ id: 'CustomerProfile' });
const sessionResponseSchema = sessionResponseSchemaImport.meta({ id: 'Session' });
const permissionSchema = permissionSchemaImport.meta({ id: 'Permission' });
const roleInputSchema = roleInputSchemaImport.meta({ id: 'RoleInput' });
const roleSchema = roleSchemaImport.meta({ id: 'Role' });
const createStaffRequestSchema = createStaffRequestSchemaImport.meta({ id: 'CreateStaffRequest' });
const updateStaffRequestSchema = updateStaffRequestSchemaImport.meta({ id: 'UpdateStaffRequest' });
const staffSchema = staffSchemaImport.meta({ id: 'Staff' });
const createTripRequestSchema = createTripRequestSchemaImport.meta({ id: 'CreateTripRequest' });
const updateTripRequestSchema = updateTripRequestSchemaImport.meta({ id: 'UpdateTripRequest' });
const changeStatusRequestSchema = changeStatusRequestSchemaImport.meta({ id: 'ChangeStatusRequest' });
const budgetItemRequestSchema = budgetItemRequestSchemaImport.meta({ id: 'BudgetItemRequest' });
const pricingPolicyRequestSchema = pricingPolicyRequestSchemaImport.meta({ id: 'PricingPolicyRequest' });
const createReservationRequestSchema = createReservationRequestSchemaImport.meta({ id: 'CreateReservationRequest' });
const requestCancellationRequestSchema = requestCancellationRequestSchemaImport.meta({
  id: 'RequestCancellationRequest',
});
const reservationSchema = reservationSchemaImport.meta({ id: 'Reservation' });
const priceChangePreviewSchema = priceChangePreviewSchemaImport.meta({ id: 'PriceChangePreview' });
const applyPriceChangeRequestSchema = applyPriceChangeRequestSchemaImport.meta({ id: 'ApplyPriceChangeRequest' });
const createBranchReservationRequestSchema = createBranchReservationRequestSchemaImport.meta({
  id: 'CreateBranchReservationRequest',
});
const registerCashPaymentRequestSchema = registerCashPaymentRequestSchemaImport.meta({
  id: 'RegisterCashPaymentRequest',
});
const reservationDetailSchema = reservationDetailSchemaImport.meta({ id: 'ReservationDetail' });
const reservationSummarySchema = reservationSummarySchemaImport.meta({ id: 'ReservationSummary' });
const cancelReservationRequestSchema = cancelReservationRequestSchemaImport.meta({ id: 'CancelReservationRequest' });
const declineCancellationRequestSchema = declineCancellationRequestSchemaImport.meta({
  id: 'DeclineCancellationRequest',
});
const staffReservationSummarySchema = staffReservationSummarySchemaImport.meta({ id: 'StaffReservationSummary' });
const staffReservationDetailSchema = staffReservationDetailSchemaImport.meta({ id: 'StaffReservationDetail' });
const createPaymentIntentRequestSchema = createPaymentIntentRequestSchemaImport.meta({
  id: 'CreatePaymentIntentRequest',
});
const paymentSchema = paymentSchemaImport.meta({ id: 'Payment' });
const creditEntrySchema = creditEntrySchemaImport.meta({ id: 'CreditEntry' });
const customerPageSchema = customerPageSchemaImport.meta({ id: 'CustomerPage' });
const customerDetailSchema = customerDetailSchemaImport.meta({ id: 'CustomerDetail' });
const createdCustomerSchema = createdCustomerSchemaImport.meta({ id: 'CreatedCustomer' });
const createBranchCustomerRequestSchema = createBranchCustomerRequestSchemaImport.meta({
  id: 'CreateBranchCustomerRequest',
});
const acceptInvitationRequestSchema = acceptInvitationRequestSchemaImport.meta({ id: 'AcceptInvitationRequest' });
const acceptedInvitationSchema = acceptedInvitationSchemaImport.meta({ id: 'AcceptedInvitation' });
const customerCreditSchema = customerCreditSchemaImport.meta({ id: 'CustomerCredit' });
const refundCreditRequestSchema = refundCreditRequestSchemaImport.meta({ id: 'RefundCreditRequest' });
const adjustCreditRequestSchema = adjustCreditRequestSchemaImport.meta({ id: 'AdjustCreditRequest' });
const applyCreditRequestSchema = applyCreditRequestSchemaImport.meta({ id: 'ApplyCreditRequest' });
const createdPaymentIntentSchema = createdPaymentIntentSchemaImport.meta({ id: 'CreatedPaymentIntent' });
const inboxPageSchema = inboxPageSchemaImport.meta({ id: 'InboxPage' });
const publicTripSummarySchema = publicTripSummarySchemaImport.meta({ id: 'PublicTripSummary' });
const publicTripDetailSchema = publicTripDetailSchemaImport.meta({ id: 'PublicTripDetail' });

const json = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });

/**
 * A required JSON request body. Marked `required: true` explicitly (the
 * OpenAPI default is `false`) so the generated `paths[P][M]['requestBody']`
 * type is non-optional -- `route()` always parses the body for these
 * routes, there is no "body omitted" case for the client to type around.
 */
const requestBody = (schema: z.ZodTypeAny) => ({ ...json(schema), required: true });

/** A `problem+json` error response, per RFC 7807. The body always carries the stable `code` @rm/contracts' `problemSchema` describes. */
const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: problemSchema } },
});

const uuidParam = (name: string) => z.object({ [name]: z.string().uuid() });

/**
 * DTOs for trips, images and costing are not yet part of `@rm/contracts`
 * (only their *request* shapes are, since those are what Zod validates at
 * the HTTP boundary). They are modelled here, matching the domain services'
 * response types field-for-field (`TripDto`, `TripSummaryDto`, `TripImageDto`,
 * `BudgetItemDto`, `TripCostingDto` in `@rm/domain-trips` and
 * `@rm/domain-costing`), so the generated Angular types stay accurate for
 * every endpoint rather than only the ones with a matching Zod contract.
 * Dates are `string` here (not `Date`): Prisma `Date` values are serialised
 * to ISO strings by `Response.json`, and it is that wire shape the client
 * receives.
 */
const tripStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
const marginModeSchema = z.enum(['PERCENTAGE', 'FIXED_TOTAL', 'FIXED_PER_SEAT']);
const priceModeSchema = z.enum(['AUTO', 'MANUAL']);

const tripImageEmbeddedSchema = z.object({
  id: z.string().uuid(),
  storageKey: z.string(),
  position: z.number().int().nonnegative(),
  isCover: z.boolean(),
  altText: z.string().nullable(),
  // Computed at the HTTP boundary (`withImageUrls` in
  // `apps/api/src/lib/http/trip-response.ts`), never by the domain's read
  // path -- see that file's doc comment and `_tripSchemaMatchesDto` below,
  // which accounts for this being the one field `TripDto.images[]` itself
  // does not carry.
  url: z.string(),
});

const tripSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    status: tripStatusSchema,
    departureDate: z.iso.datetime(),
    returnDate: z.iso.datetime(),
    paymentDeadline: z.iso.datetime(),
    totalCapacity: z.number().int(),
    preSoldSeats: z.number().int(),
    availableSeats: z.number().int(),
    holdTtlHours: z.number().int(),
    minimumDepositCents: z.number().int(),
    budgetTotalCents: z.number().int(),
    marginMode: marginModeSchema,
    marginValue: z.number().int(),
    pricePerSeatCents: z.number().int(),
    priceMode: priceModeSchema,
    publishedAt: z.iso.datetime().nullable(),
    isBackfilled: z.boolean(),
    translations: z.array(tripTranslationSchema),
    images: z.array(tripImageEmbeddedSchema),
  })
  .meta({ id: 'Trip' });

const tripSummarySchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    status: tripStatusSchema,
    name: z.string(),
    departureDate: z.iso.datetime(),
    totalCapacity: z.number().int(),
    availableSeats: z.number().int(),
    pricePerSeatCents: z.number().int(),
  })
  .meta({ id: 'TripSummary' });

const tripImageSchema = tripImageEmbeddedSchema
  .extend({
    tripId: z.string().uuid(),
  })
  .meta({ id: 'TripImage' });

const budgetItemSchema = z
  .object({
    id: z.string().uuid(),
    concept: z.string(),
    supplier: z.string().nullable(),
    quantity: z.number().int(),
    unitAmountCents: z.number().int(),
    totalCents: z.number().int(),
    notes: z.string().nullable(),
  })
  .meta({ id: 'BudgetItem' });

const tripCostingSchema = z
  .object({
    tripId: z.string().uuid(),
    items: z.array(budgetItemSchema),
    budgetTotalCents: z.number().int(),
    marginMode: marginModeSchema,
    marginValue: z.number().int(),
    priceMode: priceModeSchema,
    suggestedPricePerSeatCents: z.number().int(),
    pricePerSeatCents: z.number().int(),
    totalCapacity: z.number().int(),
  })
  .meta({ id: 'TripCosting' });

const uploadProfilePhotoSchema = z.object({
  file: z.string().meta({ type: 'string', format: 'binary', description: 'Image bytes (jpeg, png or webp; max 8MB).' }),
});

const uploadTripImageSchema = z.object({
  file: z.string().meta({ type: 'string', format: 'binary', description: 'Image bytes (jpeg, png or webp; max 8MB).' }),
  altText: z.string().max(240).optional(),
});

/**
 * Compile-time proof that the hand-modelled schemas above still match the
 * domain DTOs they claim to mirror.
 *
 * Nothing at runtime ever pushes a domain `Result.value` through these Zod
 * schemas -- `toResponse()` in `apps/api/src/lib/http/route.ts` serialises it
 * directly -- so without a check like this, the correspondence between (say)
 * `tripSchema` and `TripDto` lives only in a prose comment. A field rename on
 * either side would leave the API serving the new shape correctly while this
 * file's copy silently goes stale: `schema.d.ts` would regenerate from the
 * stale description, and the Angular client would compile clean against a
 * type that no longer matches the wire. This block turns that drift into a
 * `typecheck`/`build` failure instead of a bug someone notices at runtime.
 *
 * `Equals` is the standard "distributive conditional over a bare type
 * parameter" trick: two types are compared as the generic constraints of two
 * `<T>() => T extends X ? 1 : 2` function types, so it only reports `true`
 * when `X` and `Y` are assignable to each other in both directions and no
 * property is optional on one side and required on the other -- unlike a
 * plain `X extends Y`, it does not accept a structural subtype as a match.
 *
 * `DateToString` is the one legitimate difference this comparison has to
 * look past: every domain DTO carries `Date` where the wire (and these Zod
 * schemas) carry an ISO string, because `Response.json` serialises `Date`
 * values that way. It recurses through arrays and nested objects so the
 * conversion reaches `TripDto.images[].` and `TripCostingDto.items[].`
 * fields too, not just the top level.
 */
type DateToString<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? DateToString<U>[]
    : T extends object
      ? { [K in keyof T]: DateToString<T[K]> }
      : T;

/**
 * The other legitimate difference between `TripDto` and its wire schema:
 * every image in `.images[]` gains a computed `url` at the HTTP boundary
 * (`withImageUrls`, see `apps/api/src/lib/http/trip-response.ts`), which the
 * domain's read path deliberately never computes -- a URL is a transport
 * concern, and `local` vs. `s3` build one completely differently. Only
 * `TripDto` itself carries a bare `images[]` array needing this; nested
 * objects elsewhere in the DTO tree do not, so this does not need to recurse
 * the way `DateToString` does.
 *
 * `WithImageUrl<Img>` (the per-image half) is written as its own
 * homomorphic mapped type -- not `Img & { url: string }` -- because the
 * `Equals` check below treats an intersection type and its structurally
 * identical flattened object type as *not* equal (`{ a: 1 } & { b: 2 }`
 * fails `Equals<..., { a: 1; b: 2 }>` even though each is assignable to the
 * other): `Equals`'s point is to catch every divergence, including ones a
 * normal assignability check would consider harmless, so the fix is to
 * avoid the intersection entirely rather than to loosen the check.
 */
type WithImageUrl<Img> = { [K in keyof Img | 'url']: K extends 'url' ? string : Img[K & keyof Img] };

type WithImageUrls<T extends { images: readonly { storageKey: string }[] }> = {
  [K in keyof T]: K extends 'images' ? WithImageUrl<T['images'][number]>[] : T[K];
};

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** Fails to compile (`Type 'false' does not satisfy the constraint 'true'`) when `Actual` and `Expected` diverge. */
type Expect<Actual extends true> = Actual;

type _tripSchemaMatchesDto = Expect<Equals<z.infer<typeof tripSchema>, WithImageUrls<DateToString<TripDto>>>>;
type _tripSummarySchemaMatchesDto = Expect<Equals<z.infer<typeof tripSummarySchema>, DateToString<TripSummaryDto>>>;
type _tripImageSchemaMatchesDto = Expect<Equals<z.infer<typeof tripImageSchema>, DateToString<TripImageDto>>>;
type _budgetItemSchemaMatchesDto = Expect<Equals<z.infer<typeof budgetItemSchema>, DateToString<BudgetItemDto>>>;
type _tripCostingSchemaMatchesDto = Expect<Equals<z.infer<typeof tripCostingSchema>, DateToString<TripCostingDto>>>;

/**
 * Task 14's own set of these assertions, same reasoning as the five above:
 * each of these response shapes is hand-maintained (in `@rm/contracts`
 * rather than inline here, but that changes nothing about the risk --
 * `reservationSchema` etc. are still typed independently of the domain DTO
 * they claim to mirror) and nothing short of a compile-time check catches
 * the two drifting apart.
 */
type _reservationSchemaMatchesDto = Expect<Equals<z.infer<typeof reservationSchema>, DateToString<ReservationDto>>>;
type _reservationDetailSchemaMatchesDto = Expect<
  Equals<z.infer<typeof reservationDetailSchema>, DateToString<ReservationDetail>>
>;
type _reservationSummarySchemaMatchesDto = Expect<
  Equals<z.infer<typeof reservationSummarySchema>, DateToString<ReservationSummaryDto>>
>;
type _staffReservationSummarySchemaMatchesDto = Expect<
  Equals<z.infer<typeof staffReservationSummarySchema>, DateToString<StaffReservationSummaryDto>>
>;
type _staffReservationDetailSchemaMatchesDto = Expect<
  Equals<z.infer<typeof staffReservationDetailSchema>, DateToString<StaffReservationDetailDto>>
>;
type _paymentSchemaMatchesDto = Expect<Equals<z.infer<typeof paymentSchema>, DateToString<PaymentDto>>>;
type _createdPaymentIntentSchemaMatchesDto = Expect<
  Equals<z.infer<typeof createdPaymentIntentSchema>, DateToString<CreatedPaymentIntentDto>>
>;
// `inboxItemSchemaImport` is checked rather than a locally re-tagged
// version: it is only ever used nested inside `inboxPageSchemaImport`'s own
// `items` array (built that way already, inside `@rm/contracts`), the same
// way `tripTranslationSchema` is used nested and untagged inside `tripSchema`
// below -- there is no separate "InboxItem" path response for a `.meta()`
// tag here to attach to.
type _inboxItemSchemaMatchesDto = Expect<Equals<z.infer<typeof inboxItemSchemaImport>, DateToString<InboxItemDto>>>;
type _inboxPageSchemaMatchesDto = Expect<Equals<z.infer<typeof inboxPageSchema>, DateToString<InboxPageDto>>>;
type _publicTripSummarySchemaMatchesDto = Expect<
  Equals<z.infer<typeof publicTripSummarySchema>, WithImageUrls<DateToString<PublicTripSummaryDto>>>
>;
type _customerProfileSchemaMatchesDto = Expect<Equals<z.infer<typeof customerProfileSchema>, CustomerProfileDto>>;
type _publicTripDetailSchemaMatchesDto = Expect<
  Equals<z.infer<typeof publicTripDetailSchema>, WithImageUrls<DateToString<PublicTripDetailDto>>>
>;

/**
 * `noUnusedLocals` would otherwise flag the five type aliases above as
 * unused -- they only exist to be evaluated by the compiler, never
 * referenced at a value position. Re-exporting them as a single type (never
 * imported by anything) is enough to count as a use without adding any
 * runtime code or public API surface.
 */
export type _OpenApiDtoAssertions = [
  _tripSchemaMatchesDto,
  _tripSummarySchemaMatchesDto,
  _tripImageSchemaMatchesDto,
  _budgetItemSchemaMatchesDto,
  _tripCostingSchemaMatchesDto,
  _reservationSchemaMatchesDto,
  _reservationDetailSchemaMatchesDto,
  _reservationSummarySchemaMatchesDto,
  _staffReservationSummarySchemaMatchesDto,
  _staffReservationDetailSchemaMatchesDto,
  _paymentSchemaMatchesDto,
  _createdPaymentIntentSchemaMatchesDto,
  _inboxItemSchemaMatchesDto,
  _inboxPageSchemaMatchesDto,
  _publicTripSummarySchemaMatchesDto,
  _publicTripDetailSchemaMatchesDto,
  _customerProfileSchemaMatchesDto,
];

/**
 * The Zod schemas in `@rm/contracts` (plus the response DTOs defined above,
 * for the endpoints contracts does not yet cover) are the single source of
 * truth: this file derives the OpenAPI document from them, and the Angular
 * types are generated from that document. A contract change therefore
 * breaks the build, not production.
 *
 * Every schema referenced by more than one path -- and every one imported
 * from `@rm/contracts` -- is tagged with `.meta({ id: 'Name' })` above, so it
 * lands in `components.schemas` under that name instead of being inlined at
 * every use site.
 */
export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  // --- auth --------------------------------------------------------------
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags: ['auth'],
    description:
      'The refresh token rides an httpOnly, Secure, SameSite=Strict Set-Cookie, never the JSON body -- ' +
      'unless the caller sends X-Client-Platform: native (the packaged Capacitor app; see Task 15b), ' +
      'in which case no cookie is set and tokens.refreshToken is populated instead, for that one caller ' +
      'to persist in native secure storage (Keychain/Keystore).',
    request: { body: requestBody(loginRequestSchema) },
    responses: {
      200: { description: 'Session issued', ...json(sessionResponseSchema) },
      401: problem('Invalid email or password'),
      422: problem('Validation failed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/register',
    tags: ['auth'],
    description:
      'Always responds 200 with a null body, whether or not the email is already registered -- see ' +
      "`registerCustomer`'s doc comment in @rm/domain-identity for the enumeration argument. A new " +
      'account receives a six-digit email verification code; an existing one receives a different, ' +
      'code-free notice instead.',
    request: { body: requestBody(registerRequestSchema) },
    responses: {
      200: { description: 'Registration accepted (same response either way)', ...json(z.null()) },
      422: problem('Validation failed'),
      429: problem('Rate limited'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/verify-email',
    tags: ['auth'],
    request: { body: requestBody(verifyEmailRequestSchema) },
    responses: {
      200: { description: 'Email verified', ...json(z.null()) },
      422: problem('OTP_EXPIRED, OTP_INVALID, OTP_MAX_ATTEMPTS, or validation failed'),
      429: problem('Rate limited'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/resend-code',
    tags: ['auth'],
    description:
      'Does not reveal whether the email has an account, or whether it is already verified -- either ' +
      'case returns the same response with nothing sent.',
    request: { body: requestBody(resendCodeRequestSchema) },
    responses: {
      200: { description: 'A fresh code was sent, or nothing to resend to (same response either way)', ...json(z.null()) },
      422: problem('OTP_RESEND_TOO_SOON, or validation failed'),
      429: problem('Rate limited (the shared in-memory limiter, or otp.max_resends_per_hour)'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/forgot-password',
    tags: ['auth'],
    description:
      'Always responds 200 with a null body and comparable timing, whether or not the email has an ' +
      "account -- see `requestPasswordReset`'s doc comment in @rm/domain-identity.",
    request: { body: requestBody(forgotPasswordRequestSchema) },
    responses: {
      200: { description: 'Reset email sent, or nothing to send to (same response either way)', ...json(z.null()) },
      422: problem('Validation failed'),
      429: problem('Rate limited'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/reset-password',
    tags: ['auth'],
    description: 'Revokes every live session for the account on success. Not rate-limited: the token is a 256-bit random value from a one-time link, not a guessable secret.',
    request: { body: requestBody(resetPasswordRequestSchema) },
    responses: {
      200: { description: 'Password changed and every session revoked', ...json(z.null()) },
      401: problem('Unknown, expired or already-used token (TOKEN_INVALID)'),
      422: problem('Validation failed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/invitation/accept',
    tags: ['auth'],
    description:
      'A customer registered at the counter activates their account from the invitation link (Phase 2B, ' +
      'spec §5.1): sets a password and accepts the terms. The token is single-use; a reset token is not ' +
      'accepted here.',
    request: { body: requestBody(acceptInvitationRequestSchema) },
    responses: {
      200: { description: 'Account activated', ...json(acceptedInvitationSchema) },
      401: problem('Unknown, expired, already-used or non-invitation token (TOKEN_INVALID)'),
      422: problem('Validation failed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/oauth/google',
    tags: ['auth'],
    description:
      'Signs in (or signs up) with a Google id token, verified against signature, issuer, audience ' +
      '(our own client id) and expiry. Responds 503 PROVIDER_DISABLED, never a 500, when ' +
      'GOOGLE_OAUTH_CLIENT_ID is unconfigured.',
    request: { body: requestBody(socialLoginRequestSchema) },
    responses: {
      200: { description: 'Session issued', ...json(sessionResponseSchema) },
      401: problem('TOKEN_INVALID -- the id token failed signature, issuer, audience or expiry verification'),
      403: problem('ACCOUNT_DISABLED, or EMAIL_NOT_VERIFIED if the provider itself marks the email unverified'),
      422: problem('Validation failed'),
      503: problem('PROVIDER_DISABLED -- Google sign-in is not configured'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/oauth/apple',
    tags: ['auth'],
    description:
      'Signs in (or signs up) with an Apple id token, verified against signature, issuer, audience ' +
      '(our own client id) and expiry. Responds 503 PROVIDER_DISABLED, never a 500, when ' +
      'APPLE_OAUTH_CLIENT_ID is unconfigured.',
    request: { body: requestBody(socialLoginRequestSchema) },
    responses: {
      200: { description: 'Session issued', ...json(sessionResponseSchema) },
      401: problem('TOKEN_INVALID -- the id token failed signature, issuer, audience or expiry verification'),
      403: problem('ACCOUNT_DISABLED, or EMAIL_NOT_VERIFIED if the provider itself marks the email unverified'),
      422: problem('Validation failed'),
      503: problem('PROVIDER_DISABLED -- Apple sign-in is not configured'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/refresh',
    tags: ['auth'],
    description:
      'No request body: the refresh token is read from the httpOnly rm_refresh_token cookie set by ' +
      '/auth/login when present. A caller with no such cookie (the packaged Capacitor app -- see Task ' +
      '15b) sends the token via the X-Refresh-Token header instead, and must also repeat ' +
      'X-Client-Platform: native to receive the rotated refresh token back in tokens.refreshToken ' +
      'rather than a new Set-Cookie. A refresh authenticated by the cookie always answers with a new ' +
      'cookie and never puts the token in the body, whatever X-Client-Platform says.',
    responses: {
      200: { description: 'Session rotated', ...json(sessionResponseSchema) },
      401: problem('Missing, unknown, expired or replayed refresh token'),
      403: problem('Account disabled'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/logout',
    tags: ['auth'],
    description:
      'No request body: the refresh token is read from the rm_refresh_token cookie, or from the ' +
      'X-Refresh-Token header for a caller with no such cookie (the packaged Capacitor app -- see Task ' +
      '15b). Always succeeds (idempotent) and always clears the cookie via Set-Cookie, even when there ' +
      'was no live session or the caller never had one to begin with.',
    responses: {
      204: { description: 'Session revoked' },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/me',
    tags: ['auth'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The authenticated caller', ...json(authenticatedUserSchema) },
      401: problem('Missing or invalid access token'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/me/profile',
    tags: ['profile'],
    security: [{ bearerAuth: [] }],
    description:
      "The authenticated customer's own profile. No id in the path: it always acts on the caller. " +
      'The email is read-only in this phase.',
    responses: {
      200: { description: 'Name, phone, email and photo URL', ...json(customerProfileSchema) },
      401: problem('Missing or invalid access token'),
      404: problem('NOT_FOUND -- the caller has no customer profile (a staff user)'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/me/profile',
    tags: ['profile'],
    security: [{ bearerAuth: [] }],
    description:
      'Changes the name and/or the phone, with the same limits as registration. The body is strict: ' +
      'an email (or any other field) is refused with 422 VALIDATION_FAILED, never silently ignored.',
    request: { body: requestBody(updateCustomerProfileRequestSchema) },
    responses: {
      200: { description: 'The updated profile', ...json(customerProfileSchema) },
      401: problem('Missing or invalid access token'),
      404: problem('NOT_FOUND -- the caller has no customer profile (a staff user)'),
      422: problem('Validation failed, including any field other than fullName and phone'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/me/profile/photo',
    tags: ['profile'],
    security: [{ bearerAuth: [] }],
    description:
      "Replaces the caller's profile photo. Same validation as the trip gallery: the type is sniffed " +
      'from the bytes (jpeg, png or webp) and the size limit is 8MB.',
    request: {
      body: { content: { 'multipart/form-data': { schema: uploadProfilePhotoSchema } }, required: true },
    },
    responses: {
      200: { description: 'The profile with its new photo URL', ...json(customerProfileSchema) },
      401: problem('Missing or invalid access token'),
      404: problem('NOT_FOUND -- the caller has no customer profile (a staff user)'),
      422: problem('Missing file, oversized file, or a file that is not a jpeg/png/webp image'),
    },
  });

  // --- rbac ----------------------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/rbac/permissions',
    tags: ['rbac'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Full permission catalog', ...json(permissionSchema.array()) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing role.view'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/rbac/roles',
    tags: ['rbac'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Roles', ...json(roleSchema.array()) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing role.view'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/rbac/roles',
    tags: ['rbac'],
    security: [{ bearerAuth: [] }],
    request: { body: requestBody(roleInputSchema) },
    responses: {
      201: { description: 'Role created', ...json(roleSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing role.manage'),
      409: problem('Duplicate role name'),
      422: problem('Validation failed, or an unknown permission key was supplied'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/rbac/roles/{roleId}',
    tags: ['rbac'],
    security: [{ bearerAuth: [] }],
    request: { params: uuidParam('roleId'), body: requestBody(roleInputSchema) },
    responses: {
      200: { description: 'Role updated', ...json(roleSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing role.manage, or the role is a system role and cannot be modified'),
      404: problem('Role not found'),
      409: problem('Duplicate role name'),
      422: problem('Validation failed, or an unknown permission key was supplied'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/rbac/roles/{roleId}',
    tags: ['rbac'],
    security: [{ bearerAuth: [] }],
    request: { params: uuidParam('roleId') },
    responses: {
      204: { description: 'Role deleted' },
      401: problem('Missing or invalid access token'),
      403: problem('Missing role.manage, or the role is a system role and cannot be deleted'),
      404: problem('Role not found'),
      409: problem('Role still has assigned users'),
    },
  });

  // --- staff -----------------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/staff',
    tags: ['staff'],
    security: [{ bearerAuth: [] }],
    request: { query: z.object({ search: z.string().optional() }) },
    responses: {
      200: { description: 'Administrator accounts', ...json(staffSchema.array()) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing staff.view'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/staff',
    tags: ['staff'],
    security: [{ bearerAuth: [] }],
    request: { body: requestBody(createStaffRequestSchema) },
    responses: {
      201: { description: 'Administrator created', ...json(staffSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing staff.manage'),
      409: problem('Email already registered'),
      422: problem('Validation failed, or an unknown role id was supplied'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/staff/{userId}',
    tags: ['staff'],
    security: [{ bearerAuth: [] }],
    request: { params: uuidParam('userId'), body: requestBody(updateStaffRequestSchema) },
    responses: {
      200: { description: 'Administrator updated', ...json(staffSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing staff.manage'),
      404: problem('Administrator not found'),
      422: problem('Validation failed, or an unknown role id was supplied'),
    },
  });

  // --- trips -----------------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/trips',
    tags: ['trips'],
    security: [{ bearerAuth: [] }],
    request: { query: z.object({ status: tripStatusSchema.optional(), search: z.string().optional() }) },
    responses: {
      200: { description: 'Trip summaries', ...json(tripSummarySchema.array()) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.view'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/trips',
    tags: ['trips'],
    security: [{ bearerAuth: [] }],
    request: { body: requestBody(createTripRequestSchema) },
    responses: {
      201: { description: 'Trip created', ...json(tripSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.create, or missing data.backfill for a backfilled trip'),
      409: problem('Slug collision that could not be resolved automatically'),
      422: problem('Validation failed, invalid capacity, or missing the required Spanish translation'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/trips/{tripId}',
    tags: ['trips'],
    security: [{ bearerAuth: [] }],
    request: { params: uuidParam('tripId') },
    responses: {
      200: { description: 'Trip detail', ...json(tripSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.view'),
      404: problem('Trip not found'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/trips/{tripId}',
    tags: ['trips'],
    security: [{ bearerAuth: [] }],
    request: { params: uuidParam('tripId'), body: requestBody(updateTripRequestSchema) },
    responses: {
      200: { description: 'Trip updated', ...json(tripSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.update'),
      404: problem('Trip not found'),
      409: problem('New capacity is below what is already committed'),
      422: problem('Validation failed, invalid capacity, or missing the required Spanish translation'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/trips/{tripId}/status',
    tags: ['trips'],
    security: [{ bearerAuth: [] }],
    request: { params: uuidParam('tripId'), body: requestBody(changeStatusRequestSchema) },
    responses: {
      200: { description: 'Status changed', ...json(tripSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.publish'),
      404: problem('Trip not found'),
      409: problem('Illegal status transition, or the trip is not publishable yet'),
      422: problem('Validation failed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/trips/{tripId}/images',
    tags: ['trips'],
    security: [{ bearerAuth: [] }],
    request: {
      params: uuidParam('tripId'),
      body: { content: { 'multipart/form-data': { schema: uploadTripImageSchema } }, required: true },
    },
    responses: {
      201: { description: 'Image uploaded and attached to the trip gallery', ...json(tripImageSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.update'),
      404: problem('Trip not found'),
      422: problem('Missing file, oversized file, or a file that is not a jpeg/png/webp image'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/trips/{tripId}/images/{imageId}',
    tags: ['trips'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ tripId: z.string().uuid(), imageId: z.string().uuid() }) },
    responses: {
      200: { description: 'Image removed; the next image is promoted to cover if the deleted one was it', ...json(z.null()) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.update'),
      404: problem('Image not found'),
    },
  });

  // --- costing -----------------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/trips/{tripId}/costing',
    tags: ['costing'],
    security: [{ bearerAuth: [] }],
    request: { params: uuidParam('tripId') },
    responses: {
      200: { description: 'Budget items and the current pricing policy', ...json(tripCostingSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.budget.view'),
      404: problem('Trip not found'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/trips/{tripId}/costing',
    tags: ['costing'],
    security: [{ bearerAuth: [] }],
    request: { params: uuidParam('tripId'), body: requestBody(pricingPolicyRequestSchema) },
    responses: {
      200: { description: 'Pricing policy updated and the trip repriced', ...json(tripCostingSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.budget.manage'),
      404: problem('Trip not found'),
      422: problem('Validation failed, e.g. a manual price mode with no manual price set'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/trips/{tripId}/costing/items',
    tags: ['costing'],
    security: [{ bearerAuth: [] }],
    request: { params: uuidParam('tripId'), body: requestBody(budgetItemRequestSchema) },
    responses: {
      201: { description: 'Budget item added and the trip repriced', ...json(tripCostingSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.budget.manage'),
      404: problem('Trip not found'),
      422: problem('Validation failed'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/trips/{tripId}/costing/items/{itemId}',
    tags: ['costing'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ tripId: z.string().uuid(), itemId: z.string().uuid() }), body: requestBody(budgetItemRequestSchema) },
    responses: {
      200: { description: 'Budget item updated and the trip repriced', ...json(tripCostingSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.budget.manage'),
      404: problem('Budget item not found'),
      422: problem('Validation failed'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/trips/{tripId}/costing/items/{itemId}',
    tags: ['costing'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ tripId: z.string().uuid(), itemId: z.string().uuid() }) },
    responses: {
      200: { description: 'Budget item deleted and the trip repriced', ...json(tripCostingSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('Missing trip.budget.manage'),
      404: problem('Budget item not found'),
    },
  });

  // --- webhooks ------------------------------------------------------------
  registry.registerPath({
    method: 'post',
    path: '/api/v1/webhooks/stripe',
    tags: ['webhooks'],
    description:
      "Stripe's webhook endpoint, and the only public route that writes. Not authenticated and not " +
      'permission-checked: the Stripe-Signature header, an HMAC over the exact request bytes computed ' +
      'with STRIPE_WEBHOOK_SECRET, is the only thing that authorises it. The body is therefore modelled ' +
      'here as an opaque string rather than a schema -- it is signed bytes to verify, not a client shape ' +
      'to validate, and it is read raw so the signature still covers it. Idempotent by the Stripe event ' +
      'id. Answers 200 both to a redelivery it has already applied and to an event type it does not ' +
      'handle, because Stripe retries anything that is not 2xx.',
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: { type: 'string', description: "Stripe's raw event body." } } },
      },
    },
    responses: {
      200: { description: 'Event applied, already applied, or of a type this system ignores' },
      422: problem('Missing or invalid Stripe-Signature header, or a malformed event body'),
      502: problem('The payment provider failed while verifying the signature'),
    },
  });

  // --- public trip catalogue (no authentication) --------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/public/trips',
    tags: ['public-trips'],
    description:
      'The public trip catalogue, no authentication. Lists only PUBLISHED trips, and deliberately ' +
      'carries no budget, margin, pre-sold-seats or authorship field -- see ' +
      '`docs/business-rules/trips.md`, "El catálogo público".',
    responses: {
      200: { description: 'Published trips', ...json(publicTripSummarySchema.array()) },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/public/trips/{slug}',
    tags: ['public-trips'],
    description:
      'A published trip, by slug. A trip that is not PUBLISHED answers 404 -- the same code as a ' +
      'slug that does not exist at all -- never an empty detail.',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: { description: 'Trip detail: photos, itinerary, price and available seats', ...json(publicTripDetailSchema) },
      404: problem('Trip not found, or not published'),
    },
  });

  // --- reservations (customer, authenticated) -------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/reservations',
    tags: ['reservations'],
    security: [{ bearerAuth: [] }],
    description: 'The authenticated customer\'s own reservations, newest first. No permission check: the scope is ownership, not the RBAC catalogue.',
    responses: {
      200: { description: 'Reservation summaries', ...json(reservationSummarySchema.array()) },
      401: problem('Missing or invalid access token'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/reservations',
    tags: ['reservations'],
    security: [{ bearerAuth: [] }],
    description:
      'Creates a HELD reservation for the authenticated customer on one PUBLISHED trip (spec §5.2). ' +
      'A STAFF actor is refused with NOT_FOUND: createReservation requires the caller to own a ' +
      'CustomerProfile, which no staff user has.',
    request: { body: requestBody(createReservationRequestSchema) },
    responses: {
      201: {
        description: 'Reservation created in HELD, with the suggested monthly payment',
        ...json(reservationDetailSchema),
      },
      401: problem('Missing or invalid access token'),
      403: problem('EMAIL_NOT_VERIFIED'),
      404: problem('Trip not found (includes a STAFF actor, who owns no CustomerProfile)'),
      409: problem('DUPLICATE_RESERVATION, TRIP_SOLD_OUT, or PAYMENT_DEADLINE_PASSED'),
      422: problem('TRIP_NOT_PUBLISHED, or validation failed'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/reservations/{reservationId}',
    tags: ['reservations'],
    security: [{ bearerAuth: [] }],
    description:
      'One of the authenticated customer\'s own reservations. A reservation that does not exist and ' +
      'one that belongs to someone else answer the identical RESERVATION_NOT_OWNED (404, never 403).',
    request: { params: uuidParam('reservationId') },
    responses: {
      200: { description: 'Reservation detail, with the suggested monthly payment', ...json(reservationDetailSchema) },
      401: problem('Missing or invalid access token'),
      404: problem('RESERVATION_NOT_OWNED -- no such reservation, or it is not the caller\'s'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/reservations/{reservationId}/cancellation-requests',
    tags: ['reservations'],
    security: [{ bearerAuth: [] }],
    description:
      'Seals cancellation_requested_at and notifies staff -- it never changes the reservation\'s ' +
      'status (spec §5.6). Asking twice is a no-op, not an error.',
    request: { params: uuidParam('reservationId'), body: requestBody(requestCancellationRequestSchema) },
    responses: {
      200: { description: 'Cancellation request recorded; status unchanged', ...json(reservationSchema) },
      401: problem('Missing or invalid access token'),
      404: problem('RESERVATION_NOT_OWNED'),
      409: problem('INVALID_STATUS_TRANSITION -- the reservation is already CANCELLED or EXPIRED'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/reservations/{reservationId}/payment-intents',
    tags: ['reservations', 'payments'],
    security: [{ bearerAuth: [] }],
    description:
      'The entry point of the payment flow (spec §9). The request carries only `intent` (FULL or ' +
      'DEPOSIT) and `method` -- never a number of cents: the amount is always computed from the ' +
      'reservation\'s own balance (`createPaymentIntentForReservation`, @rm/domain-payments). An OXXO ' +
      'intent\'s voucher never outlives the reservation\'s hold; when less than a day remains, the ' +
      'request is refused with VALIDATION_FAILED rather than rounded up past the hold.',
    request: { params: uuidParam('reservationId'), body: requestBody(createPaymentIntentRequestSchema) },
    responses: {
      201: { description: 'Payment Intent created and a matching PENDING payment recorded', ...json(createdPaymentIntentSchema) },
      401: problem('Missing or invalid access token'),
      404: problem('RESERVATION_NOT_OWNED'),
      409: problem('INVALID_STATUS_TRANSITION -- the reservation is CANCELLED or EXPIRED'),
      422: problem('Nothing left to charge, or an OXXO window shorter than a day'),
      502: problem('PAYMENT_PROVIDER_ERROR'),
    },
  });

  // --- reservations (staff, panel -- Task 19) -------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/reservations',
    tags: ['reservations', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'Every customer\'s reservations for the panel, filtered by trip, status and pending cancellation ' +
      'request. Unresolved cancellation requests come first, oldest request first; the rest follow ' +
      'newest first. Requires reservation.view; a CUSTOMER actor is refused whatever roles they hold.',
    // The exact schema object the route validates against, as for /notifications.
    request: { query: listStaffReservationsQuerySchema },
    responses: {
      200: { description: 'Reservations', ...json(staffReservationSummarySchema.array()) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires reservation.view'),
      422: problem('VALIDATION_FAILED -- a malformed filter'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/reservations',
    tags: ['reservations', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'A reservation taken at the counter (Phase 2B, spec §5.2), with the same rules as the app: trip locked, ' +
      'published, deadline not passed, one live reservation per customer and trip, a free seat. source = BRANCH. ' +
      'With initialPaymentCents the first cash payment is recorded in the same transaction (numbered, receipt ' +
      'queued): covering the deposit makes it ACTIVE, less leaves it HELD. Requires reservation.create, plus ' +
      'payment.register when there is a payment.',
    request: { body: requestBody(createBranchReservationRequestSchema) },
    responses: {
      201: { description: 'Reservation created', ...json(reservationSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires reservation.create (and payment.register with a payment)'),
      404: problem('NOT_FOUND -- unknown trip or customer'),
      409: problem('TRIP_SOLD_OUT, TRIP_NOT_PUBLISHED, PAYMENT_DEADLINE_PASSED or DUPLICATE_RESERVATION'),
      422: problem('VALIDATION_FAILED, or PAYMENT_EXCEEDS_BALANCE -- a payment above the price'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/reservations/{reservationId}',
    tags: ['reservations', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'One reservation, any customer\'s, with the customer\'s contact details and the cancellation ' +
      'request reason. Requires reservation.view. The payment history is a separate endpoint.',
    request: { params: uuidParam('reservationId') },
    responses: {
      200: { description: 'Reservation detail', ...json(staffReservationDetailSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires reservation.view'),
      404: problem('NOT_FOUND'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/reservations/{reservationId}/payments',
    tags: ['reservations', 'payments', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'One reservation\'s payments, newest first, pending, failed and expired ones included. ' +
      'Requires payment.view.',
    request: { params: uuidParam('reservationId') },
    responses: {
      200: { description: 'Payments', ...json(paymentSchema.array()) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires payment.view'),
      404: problem('NOT_FOUND'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/reservations/{reservationId}/payments',
    tags: ['reservations', 'payments', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'Cash at the counter (Phase 2B, spec §5.3): a CASH payment, SUCCEEDED on the spot, numbered, with its ' +
      'receipt queued. Only on a live reservation; a HELD one that reaches its deposit becomes ACTIVE. ' +
      'Requires payment.register.',
    request: { params: uuidParam('reservationId'), body: requestBody(registerCashPaymentRequestSchema) },
    responses: {
      201: { description: 'The payment', ...json(paymentSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires payment.register'),
      404: problem('NOT_FOUND'),
      409: problem('INVALID_STATUS_TRANSITION -- not live, or HOLD_EXPIRED'),
      422: problem('VALIDATION_FAILED, or PAYMENT_EXCEEDS_BALANCE'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/reservations/{reservationId}/cancel',
    tags: ['reservations', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'Cancels a HELD or ACTIVE reservation (spec §5.6): releases its seat, keeps paid_cents and every ' +
      'payment, cancels pending payment intents, notifies the customer with RESERVATION_CANCELLED and ' +
      'audits the actor and the reason. Idempotent: an already CANCELLED reservation is answered as it ' +
      'is. Requires reservation.cancel.',
    request: { params: uuidParam('reservationId'), body: requestBody(cancelReservationRequestSchema) },
    responses: {
      200: { description: 'Reservation cancelled (or already cancelled)', ...json(staffReservationDetailSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires reservation.cancel'),
      404: problem('NOT_FOUND'),
      409: problem('INVALID_STATUS_TRANSITION -- the reservation already EXPIRED'),
      422: problem('VALIDATION_FAILED -- the reason is missing or longer than 500 characters'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/reservations/{reservationId}/decline-cancellation',
    tags: ['reservations', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'Declines the customer\'s pending cancellation request (spec §5.6): the reservation stays exactly as ' +
      'it is, the request leaves the pending queue, the customer is notified with CANCELLATION_DECLINED and ' +
      'can ask again. Idempotent. Requires reservation.cancel.',
    request: { params: uuidParam('reservationId'), body: requestBody(declineCancellationRequestSchema) },
    responses: {
      200: { description: 'Request declined (or already declined)', ...json(staffReservationDetailSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires reservation.cancel'),
      404: problem('NOT_FOUND'),
      409: problem('NO_CANCELLATION_REQUEST, or INVALID_STATUS_TRANSITION -- already CANCELLED or EXPIRED'),
      422: problem('VALIDATION_FAILED -- the reason is missing or longer than 500 characters'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/reservations/{reservationId}/apply-credit',
    tags: ['payments', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      "Pays part of a live reservation with its customer's credit (Phase 2B, spec §5.5): a numbered CREDIT " +
      'payment that moves paid_cents (and activates a HELD reservation covering its deposit) plus the matching ' +
      'APPLIED movement, in one transaction. Requires payment.credit.apply.',
    request: { params: uuidParam('reservationId'), body: requestBody(applyCreditRequestSchema) },
    responses: {
      201: { description: 'The CREDIT payment', ...json(paymentSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires payment.credit.apply'),
      404: problem('NOT_FOUND'),
      409: problem(
        'CREDIT_INSUFFICIENT, HOLD_EXPIRED, or INVALID_STATUS_TRANSITION -- the reservation is not live'
      ),
      422: problem('VALIDATION_FAILED, or PAYMENT_EXCEEDS_BALANCE -- more than the reservation still owes'),
    },
  });

  // --- price change to existing reservations (Phase 2B) ---------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/trips/{tripId}/price-change',
    tags: ['trips', 'reservations'],
    security: [{ bearerAuth: [] }],
    description:
      "Previews bringing the trip's current price to its HELD and ACTIVE reservations whose frozen total differs " +
      '(spec §5.6): previous and new total, paid, new balance and credit created, per reservation. ' +
      'Requires trip.change_price.',
    request: { params: uuidParam('tripId') },
    responses: {
      200: { description: 'Preview', ...json(priceChangePreviewSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires trip.change_price'),
      404: problem('NOT_FOUND'),
      409: problem('NO_PRICE_CHANGE -- every live reservation already has the current price'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/trips/{tripId}/price-change',
    tags: ['trips', 'reservations'],
    security: [{ bearerAuth: [] }],
    description:
      "Applies the trip's current price to the affected reservations in one transaction under the trip lock: " +
      'records each change, moves what was paid above a lower total to the customer credit (PRICE_DECREASE), ' +
      'never changes the status, and sends PRICE_CHANGED with the notice. noticeEs is mandatory. ' +
      'Requires trip.change_price.',
    request: { params: uuidParam('tripId'), body: requestBody(applyPriceChangeRequestSchema) },
    responses: {
      200: { description: 'Applied', ...json(priceChangePreviewSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires trip.change_price'),
      404: problem('NOT_FOUND'),
      409: problem('NO_PRICE_CHANGE'),
      422: problem('VALIDATION_FAILED -- the Spanish notice is missing'),
    },
  });

  // --- customers at the counter (Phase 2B) ----------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/customers',
    tags: ['customers', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'Searches customers by name, email or phone, accent- and case-insensitive, paginated (spec §5.1). ' +
      'Without a search, every customer, newest first. Never returns staff. Requires customer.view.',
    request: { query: searchCustomersQuerySchema },
    responses: {
      200: { description: 'A page of customers', ...json(customerPageSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires customer.view'),
      422: problem('VALIDATION_FAILED'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/customers',
    tags: ['customers', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'Registers a customer at the counter: email already verified, no password, origin BRANCH. Sends the ' +
      'activation invitation unless sendInvitation is false; invitationSent says whether the email went out. ' +
      'Requires customer.manage.',
    request: { body: requestBody(createBranchCustomerRequestSchema) },
    responses: {
      201: { description: 'Customer registered', ...json(createdCustomerSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires customer.manage'),
      409: problem(
        'CUSTOMER_ALREADY_EXISTS (details.customerId is the existing customer), or EMAIL_ALREADY_REGISTERED ' +
          '-- the email belongs to staff'
      ),
      422: problem('VALIDATION_FAILED'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/customers/{customerId}',
    tags: ['customers', 'admin'],
    security: [{ bearerAuth: [] }],
    description: 'One customer with their reservations, newest first. Requires customer.view.',
    request: { params: uuidParam('customerId') },
    responses: {
      200: { description: 'Customer', ...json(customerDetailSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires customer.view'),
      404: problem('NOT_FOUND'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/customers/{customerId}/invitation',
    tags: ['customers', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'Sends (or re-sends) the activation invitation. Each new invitation invalidates the previous one. ' +
      'Requires customer.manage.',
    request: { params: uuidParam('customerId') },
    responses: {
      200: { description: 'Invitation sent', ...json(customerDetailSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires customer.manage'),
      404: problem('NOT_FOUND'),
      409: problem('CONFLICT -- the customer already has a password'),
      502: problem('EMAIL_PROVIDER_ERROR -- the invitation was stored but the email did not go out'),
    },
  });

  // --- customer credit (Phase 2B) --------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/customers/{customerId}/credit',
    tags: ['payments', 'admin'],
    security: [{ bearerAuth: [] }],
    description: "A customer's credit balance and every movement behind it, newest first. Requires payment.view.",
    request: { params: uuidParam('customerId') },
    responses: {
      200: { description: 'Credit', ...json(customerCreditSchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires payment.view'),
      404: problem('NOT_FOUND'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/customers/{customerId}/credit/refund',
    tags: ['payments', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'Records credit given back to the customer outside the system (cash, a transfer). The reason is ' +
      'mandatory and the balance never goes below zero. Requires payment.credit.apply.',
    request: { params: uuidParam('customerId'), body: requestBody(refundCreditRequestSchema) },
    responses: {
      201: { description: 'The REFUND movement', ...json(creditEntrySchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires payment.credit.apply'),
      404: problem('NOT_FOUND'),
      409: problem('CREDIT_INSUFFICIENT'),
      422: problem('VALIDATION_FAILED'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/customers/{customerId}/credit/adjust',
    tags: ['payments', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      "A correction or courtesy to a customer's credit, positive or negative, with a mandatory reason. The " +
      'balance never goes below zero. Requires payment.credit.apply.',
    request: { params: uuidParam('customerId'), body: requestBody(adjustCreditRequestSchema) },
    responses: {
      201: { description: 'The ADJUSTMENT movement', ...json(creditEntrySchema) },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires payment.credit.apply'),
      404: problem('NOT_FOUND'),
      409: problem('CREDIT_INSUFFICIENT'),
      422: problem('VALIDATION_FAILED'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/me/credit',
    tags: ['payments'],
    security: [{ bearerAuth: [] }],
    description: "The authenticated customer's own credit balance and movements. Read-only.",
    responses: {
      200: { description: 'Credit', ...json(customerCreditSchema) },
      401: problem('Missing or invalid access token'),
      404: problem('NOT_FOUND -- the caller is not a customer'),
    },
  });

  // --- receipts (Phase 2B) ---------------------------------------------------
  const pdf = (description: string) => ({
    description,
    content: { 'application/pdf': { schema: z.string().meta({ format: 'binary' }) } },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/payments/{paymentId}/receipt',
    tags: ['payments', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      "A payment's receipt PDF (spec §5.4). Generated and stored on first request if the job has not done " +
      'it yet; never regenerated afterwards. Requires payment.view.',
    request: { params: uuidParam('paymentId') },
    responses: {
      200: pdf('The receipt PDF'),
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires payment.view'),
      404: problem('NOT_FOUND -- unknown payment, or one with no receipt (not SUCCEEDED)'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/payments/{paymentId}/receipt/resend',
    tags: ['payments', 'admin'],
    security: [{ bearerAuth: [] }],
    description:
      'Queues the receipt to be emailed again to the customer -- or for the first time, for a payment captured ' +
      'without sending. Requires payment.view.',
    request: { params: uuidParam('paymentId') },
    responses: {
      202: { description: 'Queued' },
      401: problem('Missing or invalid access token'),
      403: problem('PERMISSION_DENIED -- requires payment.view'),
      404: problem('NOT_FOUND -- unknown payment, or one with no receipt'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payments/{paymentId}/receipt',
    tags: ['payments'],
    security: [{ bearerAuth: [] }],
    description: "The receipt PDF of one of the authenticated customer's own payments.",
    request: { params: uuidParam('paymentId') },
    responses: {
      200: pdf('The receipt PDF'),
      401: problem('Missing or invalid access token'),
      404: problem('RESERVATION_NOT_OWNED -- not the caller\'s payment, or NOT_FOUND -- no receipt yet'),
    },
  });

  // --- payments (customer, authenticated) -----------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/payments',
    tags: ['payments'],
    security: [{ bearerAuth: [] }],
    description: 'Every payment of the authenticated customer, across all their reservations, newest first.',
    responses: {
      200: { description: 'Payments', ...json(paymentSchema.array()) },
      401: problem('Missing or invalid access token'),
    },
  });

  // --- notifications (customer inbox, authenticated) ------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/notifications',
    tags: ['notifications'],
    security: [{ bearerAuth: [] }],
    description: 'The authenticated customer\'s own in-app inbox, newest first, paginated by an opaque cursor.',
    // The exact schema object the route handler validates against at
    // request time (`apps/api/.../notifications/route.ts`) -- not a second,
    // separately-typed-out copy of the same shape, which is what let the
    // documented contract and the real validation drift apart in the first
    // place.
    request: { query: listInboxQuerySchema },
    responses: {
      200: { description: 'One page of the inbox', ...json(inboxPageSchema) },
      401: problem('Missing or invalid access token'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/notifications/{deliveryId}/read',
    tags: ['notifications'],
    security: [{ bearerAuth: [] }],
    description: 'Marks one of the authenticated customer\'s own INBOX deliveries as read.',
    request: { params: uuidParam('deliveryId') },
    responses: {
      204: { description: 'Marked read' },
      401: problem('Missing or invalid access token'),
      404: problem('DELIVERY_NOT_OWNED -- no such delivery, or it is not the caller\'s'),
    },
  });

  // --- files ---------------------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/api/v1/files/{key}',
    tags: ['files'],
    description:
      'Serves a locally stored file (the local storage driver only -- in qa and production, ' +
      'files are served straight from the S3 bucket and this route always 404s). Not wrapped by ' +
      "`route()`: a miss reports a bare 404, never `problem+json`, so a client can never tell a " +
      'missing key apart from this route being reachable in an environment where it should not be.',
    request: { params: z.object({ key: z.string().describe('Storage key; may contain multiple "/"-separated segments.') }) },
    responses: {
      200: { description: 'File contents', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      404: { description: 'File not found, or the active storage driver is not "local"' },
    },
  });

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Ruta Mochilera API', version: '1.0.0' },
    servers: [{ url: '/' }],
  });
}
