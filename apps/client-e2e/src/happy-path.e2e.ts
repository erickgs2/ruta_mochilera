import { expect, test } from '@playwright/test';
import { closeDb, confirmPendingPayment, createTrip, db, unique, verificationCodeFor } from './support/fixtures';
import { reserveTrip, signIn } from './support/pages';

test.afterAll(closeDb);

/**
 * Task 21, journey 1: register -> verify with the code (read from the
 * database) -> open a trip -> reserve paying the deposit -> pay -> see the
 * reservation ACTIVE with the right balance.
 *
 * Paid with OXXO and confirmed by the signed webhook, not with a test card:
 * the run uses the fake payment provider (deterministic, no Stripe account
 * needed), and without a Stripe publishable key the app does not mount
 * Stripe Elements at all. What makes a payment real is the same in both
 * cases -- the webhook -- and that is the part this journey exercises.
 */
test('a new customer registers, verifies, reserves with the deposit and ends up ACTIVE', async ({ page }) => {
  const trip = await createTrip({ priceCents: 500_000, depositCents: 100_000 });
  const email = `${unique('ana')}@example.com`;
  const password = 'Una-Clave-Larga-1';

  // Register.
  await page.goto('/register');
  await page.locator('input[formControlName=fullName]').fill('Ana Mochilera');
  await page.locator('input[formControlName=email]').fill(email);
  await page.locator('input[formControlName=phone]').fill('3521234567');
  await page.locator('input[formControlName=birthDate]').fill('1996-04-12');
  await page.locator('input[formControlName=password]').fill(password);
  await page.locator('input[formControlName=acceptTerms]').check();
  await page.locator('button[type=submit]').click();
  await expect(page).toHaveURL(/\/verify-email/);

  // Verify with the code the API stored.
  await page.locator('input[formControlName=code]').fill(await verificationCodeFor(email));
  await page.locator('button[type=submit]').click();
  await expect(page.getByText('Correo verificado. Ya puedes iniciar sesión.')).toBeVisible();

  // Sign in, find the trip in the public catalogue, reserve.
  await signIn(page, email, password);
  await page.goto('/');
  await page.getByRole('link', { name: trip.name }).click();
  await expect(page.getByRole('heading', { level: 1, name: trip.name })).toBeVisible();
  const code = await reserveTrip(page, trip.slug);

  // Pay the minimum deposit at OXXO: the app shows the voucher and the
  // balance does not move yet.
  await page.getByLabel('El anticipo mínimo').check();
  await page.getByLabel('Efectivo en OXXO').check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByText('Tu ficha de pago en OXXO')).toBeVisible();

  const reservation = await db().reservation.findUniqueOrThrow({ where: { code } });
  expect(reservation.status).toBe('HELD');
  expect(reservation.paidCents).toBe(0);

  // The money arrives the only way it ever does: Stripe's webhook.
  await confirmPendingPayment(reservation.id);

  await page.goto(`/reservations/${reservation.id}`);
  await expect(page.locator('.reservation-state')).toHaveText('Activa');
  const amounts = page.locator('.reservation-amounts');
  await expect(amounts).toContainText('$1,000.00'); // paid: the deposit
  await expect(amounts).toContainText('$4,000.00'); // balance: 5,000 - 1,000

  const stored = await db().reservation.findUniqueOrThrow({ where: { id: reservation.id } });
  expect(stored.status).toBe('ACTIVE');
  expect(stored.paidCents).toBe(100_000);
  expect(stored.holdExpiresAt).toBeNull();
});
