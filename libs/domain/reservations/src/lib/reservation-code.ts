import { randomInt } from 'node:crypto';

/**
 * The characters a reservation code may contain.
 *
 * A customer reads this code out loud to a clerk at the counter, so every
 * pair that sounds or looks alike is removed rather than disambiguated by a
 * convention nobody on the phone knows: `0`/`O`, `1`/`I`/`L`. `U` goes too,
 * so a random draw cannot spell something the agency would rather not print
 * on a receipt. What is left is 30 characters: `2`-`9` and the alphabet
 * without I, L, O and U.
 */
export const RESERVATION_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

const PREFIX = 'RM';
const GROUP_LENGTH = 4;
const GROUPS = 2;

/**
 * Generates a readable reservation code such as `RM-7K3D-9XQF`.
 *
 * Two groups of four over a 30-character alphabet is 30^8 -- about 6.5e11
 * codes -- so a collision is rare enough that the retry it triggers stays an
 * exception. Rare is not never, though: uniqueness is guaranteed by the
 * `reservations_code_key` unique index plus the retry in `createReservation`,
 * never by this function.
 *
 * `randomInt` rather than `Math.random`: the code is handed to whoever quotes
 * it at the counter, so it should not be guessable from another one, and
 * `randomInt` is also free of the modulo bias a naive `% alphabet.length`
 * would introduce.
 */
export function generateReservationCode(): string {
  const groups = Array.from({ length: GROUPS }, () =>
    Array.from(
      { length: GROUP_LENGTH },
      () => RESERVATION_CODE_ALPHABET[randomInt(RESERVATION_CODE_ALPHABET.length)]
    ).join('')
  );
  return [PREFIX, ...groups].join('-');
}
