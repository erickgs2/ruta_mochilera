import { describe, expect, it } from 'vitest';
import { monthStartsBetween } from './calendar';

const TZ = 'America/Mexico_City';
const at = (iso: string) => new Date(iso);

describe('monthStartsBetween', () => {
  it('counts every first-of-month strictly after `from` and on or before `to`', () => {
    // Jan 15 2026 -> Jun 10 2026: Feb 1, Mar 1, Apr 1, May 1, Jun 1
    expect(monthStartsBetween(at('2026-01-15T12:00:00Z'), at('2026-06-10T12:00:00Z'), TZ)).toBe(5);
  });

  it('excludes today even when today is the first of the month', () => {
    // Mar 1 2026 -> May 15 2026: Apr 1, May 1
    expect(monthStartsBetween(at('2026-03-01T12:00:00Z'), at('2026-05-15T12:00:00Z'), TZ)).toBe(2);
  });

  it('includes the deadline when the deadline is itself a first of month', () => {
    // Mar 10 2026 -> May 1 2026: Apr 1, May 1
    expect(monthStartsBetween(at('2026-03-10T12:00:00Z'), at('2026-05-01T12:00:00Z'), TZ)).toBe(2);
  });

  it('returns zero when the deadline is not after today', () => {
    expect(monthStartsBetween(at('2026-03-10T12:00:00Z'), at('2026-03-10T12:00:00Z'), TZ)).toBe(0);
    expect(monthStartsBetween(at('2026-03-10T12:00:00Z'), at('2026-03-01T12:00:00Z'), TZ)).toBe(0);
  });

  it('returns zero when no first-of-month falls inside the window', () => {
    expect(monthStartsBetween(at('2026-03-05T12:00:00Z'), at('2026-03-20T12:00:00Z'), TZ)).toBe(0);
  });

  it('uses the given timezone, not UTC', () => {
    // 2026-04-01T02:00Z is still Mar 31 20:00 in Mexico City,
    // so April 1st still counts as pending.
    expect(monthStartsBetween(at('2026-04-01T02:00:00Z'), at('2026-04-05T12:00:00Z'), TZ)).toBe(1);
  });
});
