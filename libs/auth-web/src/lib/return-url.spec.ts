import { describe, expect, it } from 'vitest';
import { parseReturnUrl } from './return-url';

describe('parseReturnUrl', () => {
  it.each(['/', '/trips/ruta-oaxaca/reserve', '/reservations/r1?processing=1', '/a?b=c&d=e#f'])(
    'accepts the same-app path %s',
    (path) => {
      expect(parseReturnUrl(path)).toBe(path);
    }
  );

  it.each([
    ['an absolute URL', 'https://evil.example/phish'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash variant of one', '/\\evil.example'],
    ['a tab-split protocol-relative URL', '/\t/evil.example'],
    ['a newline-split protocol-relative URL', '/\n/evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a relative path without the leading slash', 'trips/x'],
    ['an empty string', ''],
    ['an absurdly long path', `/${'a'.repeat(2048)}`],
  ])('rejects %s', (_label, value) => {
    expect(parseReturnUrl(value)).toBeNull();
  });

  it.each([null, undefined, 42, {}])('rejects a non-string (%s)', (value) => {
    expect(parseReturnUrl(value)).toBeNull();
  });
});
