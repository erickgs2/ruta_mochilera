import { expect, test } from '@playwright/test';
import { CLIENT_URL } from './support/e2e-env';
import { closeDb, createTrip, createVerifiedCustomer, db } from './support/fixtures';
import { signIn } from './support/pages';

test.afterAll(closeDb);

/**
 * Task 21, journey 3: the end-to-end check of Task 3's row lock. A trip with
 * one seat, two customers on the reserve screen at once, both pressing
 * "Apartar mi lugar" together: exactly one gets the seat, the other is told
 * the trip is sold out.
 */
test('two customers race for the last seat: one wins, the other sees TRIP_SOLD_OUT', async ({ browser }) => {
  const trip = await createTrip({ capacity: 1 });
  const [first, second] = await Promise.all([createVerifiedCustomer(), createVerifiedCustomer()]);

  const contexts = await Promise.all([
    browser.newContext({ baseURL: CLIENT_URL, locale: 'es-MX' }),
    browser.newContext({ baseURL: CLIENT_URL, locale: 'es-MX' }),
  ]);
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    await signIn(pages[0]!, first.email);
    await signIn(pages[1]!, second.email);

    for (const page of pages) {
      await page.goto(`/trips/${trip.slug}/reserve`);
      await expect(page.locator('.reserve-submit')).toBeEnabled();
    }

    await Promise.all(pages.map((page) => page.locator('.reserve-submit').click()));

    const outcomes = await Promise.all(
      pages.map(async (page) => {
        const won = page.locator('.reservation-notice');
        const lost = page.getByText('El viaje ya no tiene lugares disponibles.');
        await expect(won.or(lost)).toBeVisible();
        return (await won.isVisible()) ? 'won' : 'sold-out';
      })
    );

    expect(outcomes.sort()).toEqual(['sold-out', 'won']);
    const live = await db().reservation.count({ where: { tripId: trip.id, status: { in: ['HELD', 'ACTIVE'] } } });
    expect(live).toBe(1);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
