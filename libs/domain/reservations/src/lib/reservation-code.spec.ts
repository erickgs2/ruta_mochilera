import { describe, expect, it } from 'vitest';
import { RESERVATION_CODE_ALPHABET, generateReservationCode } from './reservation-code';

/** Characters a person reliably confuses when reading a code aloud over the phone. */
const AMBIGUOUS = ['0', 'O', '1', 'I', 'L'];

describe('generateReservationCode', () => {
  it('reads as two groups of four after a fixed prefix', () => {
    expect(generateReservationCode()).toMatch(/^RM-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('never emits a character that is ambiguous when dictated', () => {
    const codes = Array.from({ length: 500 }, () => generateReservationCode());

    for (const code of codes) {
      for (const character of AMBIGUOUS) {
        expect(code.slice(3).includes(character)).toBe(false);
      }
    }
  });

  it('draws from the whole alphabet rather than a subset of it', () => {
    // A modulo or slicing mistake typically leaves part of the alphabet
    // unreachable, which shrinks the space the uniqueness argument rests on
    // without ever failing a format check. 2000 codes are 16000 draws over
    // 30 characters, so a character that can appear will appear.
    const drawn = new Set(
      Array.from({ length: 2000 }, () => generateReservationCode())
        .map((code) => code.slice('RM-'.length).replace('-', ''))
        .join('')
        .split('')
    );

    expect([...RESERVATION_CODE_ALPHABET].every((character) => drawn.has(character))).toBe(true);
  });

  it('does not repeat itself across a large batch', () => {
    const codes = new Set(Array.from({ length: 5000 }, () => generateReservationCode()));

    // Not the uniqueness guarantee -- that is the `reservations_code_key`
    // index plus the retry in `createReservation`. This only pins down that
    // the generator is random enough for the collision path to stay the
    // exception rather than the rule.
    expect(codes.size).toBe(5000);
  });
});
