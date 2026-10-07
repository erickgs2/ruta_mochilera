import { createHash, createHmac } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { createPrismaClient, type Db } from '@rm/db';
import { PgBoss } from 'pg-boss';
// The plan asks for the expiry to be forced "by running expireHolds directly":
// the job function itself, not a copy of its query. It lives in apps/worker
// because it is the worker's job; the E2E suite is the one place outside
// that app allowed to reach for it.
import { expireHolds } from '../../../worker/src/jobs/expire-holds';
import { API_URL, E2E_DATABASE_URL, FAKE_WEBHOOK_SECRET } from './e2e-env';

const DAY_MS = 24 * 60 * 60 * 1000;

export const CUSTOMER_PASSWORD = 'Correct-Horse-1';

let client: Db | undefined;

export function db(): Db {
  client ??= createPrismaClient(E2E_DATABASE_URL);
  return client;
}

export async function closeDb(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

let sequence = 0;

/** Unique per run *and* per call, so specs never collide even when retried. */
export function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

export interface TripFixture {
  id: string;
  slug: string;
  name: string;
}

/**
 * A PUBLISHED trip with both translations (publishing requires them), dates
 * comfortably in the future and a payment deadline that has not passed.
 */
export async function createTrip(
  options: { capacity?: number; priceCents?: number; depositCents?: number; name?: string } = {}
): Promise<TripFixture> {
  const admin = await db().user.findFirstOrThrow({ where: { type: 'STAFF' }, orderBy: { createdAt: 'asc' } });
  const slug = unique('ruta-e2e');
  const name = options.name ?? `Ruta E2E ${slug.slice(-6)}`;
  const departure = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 2, 10));
  const trip = await db().trip.create({
    data: {
      slug,
      status: 'PUBLISHED',
      publishedAt: new Date(),
      departureDate: departure,
      returnDate: new Date(departure.getTime() + 3 * DAY_MS),
      paymentDeadline: new Date(departure.getTime() - 14 * DAY_MS),
      totalCapacity: options.capacity ?? 20,
      holdTtlHours: 72,
      minimumDepositCents: options.depositCents ?? 100_000,
      pricePerSeatCents: options.priceCents ?? 500_000,
      priceMode: 'MANUAL',
      createdById: admin.id,
      translations: {
        create: [
          { locale: 'es', name, description: 'Ruta de prueba.', itinerary: 'Día 1.', includes: 'Todo.', excludes: 'Nada.' },
          { locale: 'en', name, description: 'Test route.', itinerary: 'Day 1.', includes: 'All.', excludes: 'None.' },
        ],
      },
    },
  });
  return { id: trip.id, slug, name };
}

/** A customer whose email is already verified, for the specs that are not about registration. */
export async function createVerifiedCustomer(): Promise<{ email: string; userId: string }> {
  const email = `${unique('viajera')}@example.com`;
  const user = await db().user.create({
    data: {
      email,
      type: 'CUSTOMER',
      passwordHash: await hash(CUSTOMER_PASSWORD),
      emailVerifiedAt: new Date(),
      customerProfile: {
        create: {
          fullName: 'Viajera de Prueba',
          phone: '3521234567',
          birthDate: new Date('1995-05-05'),
          origin: 'SELF_SIGNUP',
          acceptedTermsAt: new Date(),
        },
      },
    },
  });
  return { email, userId: user.id };
}

/**
 * The verification code the API emailed, read from the database (Task 21:
 * "leído de la base, no del correo").
 *
 * Only its SHA-256 is stored -- by design, a database dump never reveals a
 * live code (`otp.ts`). There are only 10^6 six-digit codes, so the test
 * recovers it by hashing every candidate, which takes about a second. That
 * reads the real stored value without adding any test-only backdoor to the
 * product.
 */
export async function verificationCodeFor(email: string): Promise<string> {
  const user = await db().user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
  const row = await db().emailVerification.findFirstOrThrow({
    where: { userId: user.id, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = candidate.toString().padStart(6, '0');
    if (createHash('sha256').update(code).digest('hex') === row.codeHash) return code;
  }
  throw new Error(`No six-digit code matches the stored hash for ${email}`);
}

/**
 * Confirms the reservation's pending payment the way Stripe would: a signed
 * `payment_intent.succeeded` sent to the real webhook endpoint. Signed with
 * the fake provider's secret, which is what the API under test verifies
 * against (see `e2e-env.ts`). The webhook, not the app, is what makes money
 * real -- see CLAUDE.md.
 */
export async function confirmPendingPayment(reservationId: string): Promise<void> {
  const payment = await db().payment.findFirstOrThrow({
    where: { reservationId, status: 'PENDING', providerIntentId: { not: null } },
    orderBy: { recordedAt: 'desc' },
  });
  const body = JSON.stringify({
    id: unique('evt_e2e'),
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: payment.providerIntentId,
        amount: payment.amountCents,
        payment_method_types: [payment.method === 'OXXO' ? 'oxxo' : 'card'],
        metadata: { reservationId },
      },
    },
  });
  const response = await fetch(`${API_URL}/api/v1/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': createHmac('sha256', FAKE_WEBHOOK_SECRET).update(body, 'utf8').digest('hex'),
    },
    body,
  });
  if (!response.ok) throw new Error(`Webhook answered ${response.status}: ${await response.text()}`);
}

/**
 * Forces one reservation's hold past its expiry and runs the real
 * `expireHolds` job once. Moving `hold_expires_at` is the controlled clock:
 * the job compares against now, so a hold that "expired a minute ago" is
 * exactly the state the job exists to handle, without waiting 72 hours or
 * faking the process clock of a server we do not own.
 */
export async function expireHoldNow(reservationId: string): Promise<void> {
  await db().reservation.update({
    where: { id: reservationId },
    data: { holdExpiresAt: new Date(Date.now() - 60_000) },
  });
  const boss = new PgBoss({ connectionString: E2E_DATABASE_URL });
  await boss.start();
  try {
    await expireHolds(db(), boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

export async function reservationOf(userId: string, tripId: string) {
  return db().reservation.findFirstOrThrow({ where: { customerId: userId, tripId }, orderBy: { createdAt: 'desc' } });
}
