import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { receiptJobsFor, reissueInvitationToken, runReceiptJob, sellAtCounter, signInStaff } from './support/counter';
import { E2E_STORAGE_ROOT } from './support/e2e-env';
import { closeDb, createTrip, db } from './support/fixtures';

test.afterAll(closeDb);

/**
 * Phase 2B, Task 15: the counter. Staff act through the API (see
 * `support/counter.ts` for why); the customer acts in the app.
 *
 * Each journey makes its own sale, so neither depends on the other having
 * run -- the rule every spec in this suite follows.
 */

const PRICE_CENTS = 500_000;
const DEPOSIT_CENTS = 100_000;

test('staff register a customer and take the deposit in cash: ACTIVE, with a numbered receipt queued', async () => {
  const trip = await createTrip({ priceCents: PRICE_CENTS, depositCents: DEPOSIT_CENTS });
  const staff = await signInStaff();

  const { customer, reservation } = await sellAtCounter(staff, trip, DEPOSIT_CENTS);

  // The customer: verified at the counter, no password yet, invited.
  expect(customer.origin).toBe('BRANCH');
  expect(customer.hasPassword).toBe(false);
  expect(customer.invitationSent).toBe(true);

  // The reservation: the deposit in cash activates it on the spot, with no hold.
  expect(reservation.status).toBe('ACTIVE');
  expect(reservation.holdExpiresAt).toBeNull();
  expect(reservation.paidCents).toBe(DEPOSIT_CENTS);
  expect(reservation.balanceCents).toBe(PRICE_CENTS - DEPOSIT_CENTS);

  const stored = await db().reservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { payments: true } });
  expect(stored.status).toBe('ACTIVE');
  expect(stored.holdExpiresAt).toBeNull();
  expect(stored.paidCents).toBe(DEPOSIT_CENTS);
  expect(stored.source).toBe('BRANCH');
  expect(stored.createdById).toBe(staff.userId);

  // One CASH payment, confirmed on the spot, with its receipt number.
  expect(stored.payments).toHaveLength(1);
  const [payment] = stored.payments;
  expect(payment).toMatchObject({
    method: 'CASH',
    provider: 'MANUAL',
    status: 'SUCCEEDED',
    amountCents: DEPOSIT_CENTS,
    recordedById: staff.userId,
    receiptTotalCents: PRICE_CENTS,
    receiptPaidCents: DEPOSIT_CENTS,
  });
  expect(payment.paidAt).not.toBeNull();
  expect(payment.receiptNumber).toMatch(/^RM-\d{4}-\d{6}$/);

  // The receipt is queued, not sent: the worker sends it.
  expect(payment.receiptKey).toBeNull();
  expect(payment.receiptSentAt).toBeNull();
  const jobs = await receiptJobsFor(payment.id);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].state).toBe('created');
  expect(jobs[0].data).toEqual({ paymentId: payment.id });
});

test('the counter customer accepts the invitation, signs in, sees the reservation and downloads the receipt', async ({
  page,
}) => {
  const trip = await createTrip({ priceCents: PRICE_CENTS, depositCents: DEPOSIT_CENTS });
  const { customer, reservation } = await sellAtCounter(await signInStaff(), trip, DEPOSIT_CENTS);
  const password = 'Clave-Del-Mostrador-1';

  // The worker sends the receipt: the PDF is rendered once and stored.
  const payment = await db().payment.findFirstOrThrow({ where: { reservationId: reservation.id } });
  expect(await runReceiptJob(payment.id)).toBe('SENT');
  const sent = await db().payment.findUniqueOrThrow({ where: { id: payment.id } });
  expect(sent.receiptSentAt).not.toBeNull();
  expect(sent.receiptKey).not.toBeNull();
  const receiptKey = sent.receiptKey as string;
  const receiptNumber = sent.receiptNumber as string;

  // The registration issued an invitation; a re-issued one replaces it.
  const issued = await db().passwordReset.findFirstOrThrow({
    where: { userId: customer.id, purpose: 'INVITATION', consumedAt: null },
  });
  const token = await reissueInvitationToken(customer.id);
  const replaced = await db().passwordReset.findUniqueOrThrow({ where: { id: issued.id } });
  expect(replaced.consumedAt).not.toBeNull();

  // Activate: password, confirmation, terms.
  await page.goto(`/invitation?token=${token}`);
  await page.locator('input[formControlName=password]').fill(password);
  await page.locator('input[formControlName=confirmPassword]').fill(password);
  await page.locator('input[formControlName=acceptTerms]').check();
  await page.locator('button[type=submit]').click();
  await expect(page.locator('.invitation-success')).toContainText(customer.email);

  const profile = await db().customerProfile.findUniqueOrThrow({ where: { userId: customer.id } });
  expect(profile.activatedAt).not.toBeNull();
  expect(profile.acceptedTermsAt).not.toBeNull();

  // Sign in from the link the success message offers: the email comes prefilled.
  await page.getByRole('link', { name: 'Iniciar sesión' }).click();
  await expect(page).toHaveURL(/\/login\?email=/);
  await expect(page.locator('input[type=email]')).toHaveValue(customer.email);
  await page.locator('input[type=password]').fill(password);
  await page.locator('button[type=submit]').click();
  await expect(page).toHaveURL(/\/$/);

  // The reservation taken at the counter is in the app.
  await page.goto('/reservations');
  const row = page.locator('.reservation-row', { hasText: trip.name });
  await expect(row.locator('.reservation-row-status')).toHaveText('Activa');
  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/reservations/${reservation.id}$`));
  await expect(page.locator('.reservation-state')).toHaveText('Activa');
  const amounts = page.locator('.reservation-amounts');
  await expect(amounts).toContainText('$1,000.00'); // paid: the deposit, in cash
  await expect(amounts).toContainText('$4,000.00'); // balance: 5,000 - 1,000

  // Its cash payment, and the receipt the worker produced.
  await page.getByRole('link', { name: 'Ver historial de pagos' }).click();
  const paymentRow = page.locator('.payment-row');
  await expect(paymentRow).toHaveCount(1);
  await expect(paymentRow.locator('.payment-method')).toHaveText('Efectivo');
  await expect(paymentRow.locator('.payment-status')).toHaveText('Acreditado');

  const downloading = page.waitForEvent('download');
  await paymentRow.locator('.payment-receipt').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`${receiptNumber}.pdf`);
  const downloaded = await readFile(await download.path());
  expect(downloaded.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // Byte for byte the PDF the worker stored: a receipt is never regenerated.
  expect(downloaded.equals(await readFile(join(E2E_STORAGE_ROOT, receiptKey)))).toBe(true);
  const after = await db().payment.findUniqueOrThrow({ where: { id: payment.id } });
  expect(after.receiptKey).toBe(receiptKey);
});
