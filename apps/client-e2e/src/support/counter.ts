import { issueInvitationToken } from '@rm/domain-identity';
import { ConsoleEmailProvider } from '@rm/email';
import { SEND_RECEIPT_JOB, type SendReceiptPayload } from '@rm/jobs';
import { PdfLibReceiptRenderer } from '@rm/receipts';
import { LocalFileStorage } from '@rm/storage';
import { PgBoss, type JobWithMetadata } from 'pg-boss';
// The worker's own job function, for the same reason `fixtures.ts` reaches
// for `expireHolds`: the receipt is produced by the code that produces it in
// production, not by a copy of it.
import { sendReceipt, type SendReceiptOutcome } from '../../../worker/src/jobs/send-receipt';
import { API_URL, E2E_DATABASE_URL, E2E_STORAGE_ROOT } from './e2e-env';
import { db, type TripFixture, unique } from './fixtures';

/**
 * The counter side of Phase 2B, driven through the real API.
 *
 * Staff work from the admin panel, which this suite does not serve: its
 * `webServer` list is the API and the customer app. Each panel action is one
 * HTTP call, and those calls are what these helpers make, as the seeded
 * administrator -- authentication, permission, Zod and domain run exactly as
 * they do behind the panel. The panel's own screens are covered by their
 * component specs.
 */

/** The administrator `pnpm db:seed` creates, with the same defaults the seed uses. */
const STAFF_EMAIL = (process.env['SEED_ADMIN_EMAIL'] ?? 'admin@rutamochilera.test').trim().toLowerCase();
const STAFF_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'ChangeMe123!';

export interface StaffSession {
  userId: string;
  post<T>(path: string, body: unknown): Promise<T>;
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new Error(`${what} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Signs the seeded administrator in through `POST /auth/login`. */
export async function signInStaff(): Promise<StaffSession> {
  const login = await readJson<{ user: { id: string }; tokens: { accessToken: string } }>(
    await fetch(`${API_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD }),
    }),
    'Staff login'
  );
  const authorization = `Bearer ${login.tokens.accessToken}`;
  return {
    userId: login.user.id,
    post: async <T>(path: string, body: unknown) =>
      readJson<T>(
        await fetch(`${API_URL}/api/v1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization },
          body: JSON.stringify(body),
        }),
        `POST ${path}`
      ),
  };
}

/** The fields of `POST /admin/customers` the specs read. */
export interface CounterCustomer {
  id: string;
  email: string;
  fullName: string;
  origin: string;
  hasPassword: boolean;
  invitationSent: boolean;
}

/** The fields of `POST /admin/reservations` the specs read. */
export interface CounterReservation {
  id: string;
  code: string;
  status: string;
  holdExpiresAt: string | null;
  paidCents: number;
  balanceCents: number;
}

/**
 * A sale at the counter, as the panel makes it: register the customer (with
 * the invitation, the panel's default), then reserve with a first cash
 * payment.
 */
export async function sellAtCounter(
  staff: StaffSession,
  trip: TripFixture,
  cashCents: number
): Promise<{ customer: CounterCustomer; reservation: CounterReservation }> {
  const customer = await staff.post<CounterCustomer>('/admin/customers', {
    fullName: 'Rosa Mostrador',
    email: `${unique('mostrador')}@example.com`,
    phone: '352 100 80 79',
    birthDate: '1990-08-21',
    sendInvitation: true,
  });
  const reservation = await staff.post<CounterReservation>('/admin/reservations', {
    tripId: trip.id,
    customerId: customer.id,
    initialPaymentCents: cashCents,
  });
  return { customer, reservation };
}

/**
 * A short-lived pg-boss handle on the E2E database, as a producer only
 * (no maintenance, no schedules) -- the same way the API runs its own.
 */
async function withQueue<T>(use: (boss: PgBoss) => Promise<T>): Promise<T> {
  const boss = new PgBoss({ connectionString: E2E_DATABASE_URL, supervise: false, schedule: false });
  await boss.start();
  try {
    return await use(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

/** Every `SEND_RECEIPT` job enqueued for one payment. */
export async function receiptJobsFor(paymentId: string): Promise<JobWithMetadata<SendReceiptPayload>[]> {
  return withQueue((boss) => boss.findJobs<SendReceiptPayload>(SEND_RECEIPT_JOB, { data: { paymentId } }));
}

/**
 * Does what `apps/worker` does with the payment's queued `SEND_RECEIPT`
 * job: runs the worker's `sendReceipt` on that job's own payload, with the
 * storage the API under test reads from and the real PDF renderer, then
 * settles the job.
 *
 * In-process rather than by starting `apps/worker`: the worker also runs
 * `expireHolds` and the other schedules against the same database, which
 * would make every spec's timing depend on it. Running the one job, once, is
 * the same controlled clock `expireHoldNow` uses.
 */
export async function runReceiptJob(paymentId: string): Promise<SendReceiptOutcome> {
  return withQueue(async (boss) => {
    const jobs = await boss.findJobs<SendReceiptPayload>(SEND_RECEIPT_JOB, { data: { paymentId }, queued: true });
    if (jobs.length !== 1) throw new Error(`Expected one queued receipt job for ${paymentId}, found ${jobs.length}`);
    const [job] = jobs;
    const result = await sendReceipt(
      db(),
      new LocalFileStorage(E2E_STORAGE_ROOT, `${API_URL}/api/v1/files`),
      new PdfLibReceiptRenderer(),
      new ConsoleEmailProvider(),
      job.data
    );
    if (!result.ok) throw new Error(`sendReceipt failed: ${result.error.code}`);
    await boss.complete(SEND_RECEIPT_JOB, job.id, null, { includeQueued: true });
    return result.value;
  });
}

/**
 * A working invitation link's token for a counter customer.
 *
 * The one the API emailed cannot be recovered: only its SHA-256 is stored,
 * and unlike a six-digit code (`verificationCodeFor`) 32 random bytes cannot
 * be searched for. It never goes through the outbox either -- by design, see
 * `invitation.ts` -- so there is nothing to intercept. Instead the test does
 * what «Reenviar invitación» does: `issueInvitationToken`, the domain
 * function that endpoint calls, which stores a new hash and invalidates the
 * earlier link. The test gets the plaintext the email would have carried.
 */
export async function reissueInvitationToken(userId: string): Promise<string> {
  const issued = await db().$transaction((tx) => issueInvitationToken(tx, userId));
  return issued.token;
}
