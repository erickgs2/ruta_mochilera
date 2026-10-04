import { describe, expect, it } from 'vitest';
import {
  EXPIRE_HOLDS_JOB,
  JOB_NAMES,
  RECONCILE_PAID_CENTS_JOB,
  SEND_NOTIFICATION_EMAIL_JOB,
  WARN_EXPIRING_HOLDS_JOB,
} from './job-names';

describe('job names', () => {
  it('uses the exact cadence job names from the Task 8 brief', () => {
    expect(EXPIRE_HOLDS_JOB).toBe('expire-holds');
    expect(WARN_EXPIRING_HOLDS_JOB).toBe('warn-expiring-holds');
    expect(RECONCILE_PAID_CENTS_JOB).toBe('reconcile-paid-cents');
  });

  it('names the outbox job the notification delivery service enqueues', () => {
    expect(SEND_NOTIFICATION_EMAIL_JOB).toBe('send-notification-email');
  });

  it('collects every job name into one array with no duplicates', () => {
    expect(JOB_NAMES).toHaveLength(new Set(JOB_NAMES).size);
    expect(JOB_NAMES).toEqual(
      expect.arrayContaining([
        EXPIRE_HOLDS_JOB,
        WARN_EXPIRING_HOLDS_JOB,
        RECONCILE_PAID_CENTS_JOB,
        SEND_NOTIFICATION_EMAIL_JOB,
      ])
    );
  });
});
