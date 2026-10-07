import { expect, type Page } from '@playwright/test';
import { CUSTOMER_PASSWORD } from './fixtures';

/** Signs in through the real login screen, the way a customer does. */
export async function signIn(page: Page, email: string, password = CUSTOMER_PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.locator('button[type=submit]').click();
  await expect(page).toHaveURL(/\/$/);
}

/** From the trip page to a created hold: "Reservar", then "Apartar mi lugar". */
export async function reserveTrip(page: Page, slug: string): Promise<string> {
  await page.goto(`/trips/${slug}`);
  await page.locator('.trip-reserve').click();
  await page.locator('.reserve-submit').click();
  const notice = page.locator('.reservation-notice');
  await expect(notice).toBeVisible();
  const code = (await notice.textContent())?.match(/RM-[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0];
  if (!code) throw new Error(`No reservation code in "${await notice.textContent()}"`);
  return code;
}
