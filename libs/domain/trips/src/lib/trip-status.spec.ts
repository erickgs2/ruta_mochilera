import { describe, expect, it } from 'vitest';
import { canTransition } from './trip-status';

describe('canTransition', () => {
  it('walks the happy path forwards', () => {
    expect(canTransition('DRAFT', 'PUBLISHED')).toBe(true);
    expect(canTransition('PUBLISHED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
  });

  it('allows cancelling from any live state', () => {
    expect(canTransition('DRAFT', 'CANCELLED')).toBe(true);
    expect(canTransition('PUBLISHED', 'CANCELLED')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'CANCELLED')).toBe(true);
  });

  it('never moves backwards', () => {
    expect(canTransition('PUBLISHED', 'DRAFT')).toBe(false);
    expect(canTransition('COMPLETED', 'IN_PROGRESS')).toBe(false);
  });

  it('treats terminal states as terminal', () => {
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('CANCELLED', 'PUBLISHED')).toBe(false);
  });

  it('rejects a no-op transition', () => {
    expect(canTransition('DRAFT', 'DRAFT')).toBe(false);
  });
});
