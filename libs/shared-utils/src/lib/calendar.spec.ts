import { describe, expect, it } from 'vitest';
import { endOfCalendarDay, isCalendarDateNotAfter, isPastDate, monthStartsBetween, noonOrNow, resolveBackfillMoments } from './calendar';

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

describe('isPastDate', () => {
  it('treats a date on a calendar day strictly before today as past', () => {
    expect(isPastDate(at('2026-09-28T00:00:00Z'), at('2026-09-29T12:00:00Z'), TZ)).toBe(true);
  });

  it('does not treat today as past', () => {
    expect(isPastDate(at('2026-09-29T00:00:00Z'), at('2026-09-29T12:00:00Z'), TZ)).toBe(false);
  });

  it('does not treat a future date as past', () => {
    expect(isPastDate(at('2026-12-01T00:00:00Z'), at('2026-09-29T12:00:00Z'), TZ)).toBe(false);
  });

  it('pins the UTC-rollover boundary: a trip departing today in Mexico City is not past just because UTC already rolled over', () => {
    // 2026-09-29T02:00:00Z is still 2026-09-28T20:00 in America/Mexico_City
    // (UTC-6), so "today" there is still the 28th. A trip departing on the
    // 28th must not be classified as past just because UTC has already
    // ticked over into the 29th. Naively comparing `departureDate < now` as
    // raw instants gets this wrong for six hours every day.
    expect(isPastDate(at('2026-09-28T00:00:00Z'), at('2026-09-29T02:00:00Z'), TZ)).toBe(false);
  });
});

describe('endOfCalendarDay', () => {
  it('re-anchors a @db.Date UTC-midnight value to the end of that same calendar day in the given timezone', () => {
    // payment_deadline stored as 2026-03-01 round-trips from Prisma as UTC
    // midnight. Read naively as an instant in America/Mexico_City (UTC-6),
    // that instant is 2026-02-28T18:00 -- the wrong calendar day entirely.
    // endOfCalendarDay re-anchors it to the end of 2026-03-01 in that zone.
    const deadline = at('2026-03-01T00:00:00Z');
    expect(endOfCalendarDay(deadline, TZ).toISOString()).toBe('2026-03-02T05:59:59.999Z');
  });

  it('keys off the UTC calendar day, ignoring any time-of-day component', () => {
    const deadline = at('2026-03-01T12:00:00Z');
    expect(endOfCalendarDay(deadline, TZ).toISOString()).toBe('2026-03-02T05:59:59.999Z');
  });
});

describe('isCalendarDateNotAfter', () => {
  it('accepts today and earlier real dates', () => {
    expect(isCalendarDateNotAfter('2026-10-07', '2026-10-07')).toBe(true);
    expect(isCalendarDateNotAfter('1990-05-17', '2026-10-07')).toBe(true);
  });

  it('rejects a date after today', () => {
    expect(isCalendarDateNotAfter('2026-10-08', '2026-10-07')).toBe(false);
  });

  it('rejects text that is not a real YYYY-MM-DD calendar date', () => {
    expect(isCalendarDateNotAfter('2020-02-31', '2026-10-07')).toBe(false);
    expect(isCalendarDateNotAfter('17/05/1990', '2026-10-07')).toBe(false);
    expect(isCalendarDateNotAfter('', '2026-10-07')).toBe(false);
  });
});

describe('noonOrNow', () => {
  const mexico = 'America/Mexico_City';

  it('is noon of the date in the zone when that moment has passed', () => {
    expect(noonOrNow('2026-10-07', mexico, new Date('2026-10-07T21:00:00Z')).toISOString()).toBe('2026-10-07T18:00:00.000Z');
    expect(noonOrNow('2025-11-03', mexico, new Date('2026-10-07T21:00:00Z')).toISOString()).toBe('2025-11-03T18:00:00.000Z');
  });

  it('is now when noon of the date is still ahead, so a date of today is never in the future', () => {
    const now = new Date('2026-10-07T15:00:00Z'); // 09:00 in Mexico City
    expect(noonOrNow('2026-10-07', mexico, now).getTime()).toBe(now.getTime());
  });

  it('keeps the calendar day in the zone, whatever the machine zone is', () => {
    // 23:30 on 31 Dec in Mexico City is already 1 Jan in UTC.
    expect(noonOrNow('2026-12-31', mexico, new Date('2027-01-05T00:00:00Z')).toISOString()).toBe('2026-12-31T18:00:00.000Z');
    expect(noonOrNow('2026-12-31', 'Pacific/Auckland', new Date('2027-01-05T00:00:00Z')).toISOString()).toBe('2026-12-30T23:00:00.000Z');
  });
});

describe('resolveBackfillMoments', () => {
  const mexico = 'America/Mexico_City';
  const now = new Date('2026-10-07T15:00:00Z'); // 09:00 on 7 October in Mexico City

  it('stamps each date at noon in the organization zone, capped at now', () => {
    const result = resolveBackfillMoments(
      [
        { field: 'createdAt', date: '2025-11-03' },
        { field: 'payments.0.paidAt', date: '2026-10-07' },
      ],
      mexico,
      now
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.value.map((moment) => moment.toISOString())).toEqual([
      '2025-11-03T18:00:00.000Z',
      now.toISOString(),
    ]);
  });

  it('refuses a date after today in the organization zone, naming the first offending field', () => {
    // Already 8 October in Auckland, still 7 October in Mexico City.
    expect(resolveBackfillMoments([{ field: 'payments.1.paidAt', date: '2026-10-08' }], mexico, now)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'payments.1.paidAt' } },
    });
    expect(resolveBackfillMoments([{ field: 'paidAt', date: '2026-10-08' }], 'Pacific/Auckland', now)).toMatchObject({ ok: true });
    expect(
      resolveBackfillMoments(
        [
          { field: 'createdAt', date: '2025-11-03' },
          { field: 'payments.0.paidAt', date: '2030-01-01' },
          { field: 'payments.1.paidAt', date: '2031-01-01' },
        ],
        mexico,
        now
      )
    ).toMatchObject({ ok: false, error: { details: { field: 'payments.0.paidAt' } } });
  });

  it('refuses text that is not a real calendar date', () => {
    for (const date of ['2026-02-31', '07/10/2026', '', '2026-10-7']) {
      expect(resolveBackfillMoments([{ field: 'createdAt', date }], mexico, now)).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', details: { field: 'createdAt' } },
      });
    }
  });
});
