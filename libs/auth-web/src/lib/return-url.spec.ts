import { describe, expect, it } from 'vitest';
import { parseReturnUrl } from './return-url';

describe('parseReturnUrl', () => {
  it.each([
    '/',
    '/trips/ruta-oaxaca/reserve',
    '/reservations/r1?processing=1',
    '/a?b=c&d=e#f',
    '/trips/ana@example.com',
    '/search?q=..',
    '/files/v1..2/readme',
  ])(
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
    ['an @ in the first segment', '/@evil.com'],
    ['an @ in the first segment, with a path after it', '/@evil.com/trips'],
    ['an encoded @ in the first segment', '/%40evil.com'],
    ['a parent-directory segment', '/trips/../../evil.com'],
    ['a leading parent-directory segment', '/../evil.com'],
    ['a parent-directory segment, percent-encoded', '/trips/%2e%2e/evil.com'],
    ['a parent-directory segment, half percent-encoded', '/trips/.%2E/evil.com'],
    ['a trailing parent-directory segment before a query', '/trips/..?x=1'],
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
