import { expect, test } from '@playwright/test';
import { closeDb, createTrip, createVerifiedCustomer, db, expireHoldNow } from './support/fixtures';
import { reserveTrip, signIn } from './support/pages';

test.afterAll(closeDb);

/**
 * Task 21, journey 2: reserve without paying, force the hold to expire by
 * running `expireHolds` itself, and check both halves of the outcome -- the
 * customer sees the reservation expired, and the seat is back in the
 * catalogue for everyone else.
 */
test('an unpaid hold expires and its seat returns to the catalogue', async ({ page }) => {
  const trip = await createTrip({ capacity: 3 });
  const customer = await createVerifiedCustomer();

  await signIn(page, customer.email);
  await page.goto(`/trips/${trip.slug}`);
  await expect(page.locator('.trip-seats')).toHaveText('Quedan 3 lugares');

  const code = await reserveTrip(page, trip.slug);
  await page.goto(`/trips/${trip.slug}`);
  await expect(page.locator('.trip-seats')).toHaveText('Quedan 2 lugares');

  const reservation = await db().reservation.findUniqueOrThrow({ where: { code } });
  await expireHoldNow(reservation.id);

  await page.goto(`/reservations/${reservation.id}`);
  await expect(page.locator('.reservation-state')).toHaveText('Vencida');

  await page.goto(`/trips/${trip.slug}`);
  await expect(page.locator('.trip-seats')).toHaveText('Quedan 3 lugares');

  const stored = await db().reservation.findUniqueOrThrow({ where: { id: reservation.id } });
  expect(stored.status).toBe('EXPIRED');
});
