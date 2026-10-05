import { describe, expect, it } from 'vitest';
import { WebRefreshTokenStore, type RefreshTokenStore } from './refresh-token-store';

// Exercised through the interface, the way `AuthService` and
// `authInterceptor` actually see it: the concrete class can omit the
// parameters it ignores, but its callers always pass them.
const store = (): RefreshTokenStore => new WebRefreshTokenStore();

describe('WebRefreshTokenStore', () => {
  it("requestHeaders() contributes nothing, on any request -- today's cookie-only request shape, unchanged", () => {
    expect(store().requestHeaders({ includeRefreshToken: false })).toEqual({});
    expect(store().requestHeaders({ includeRefreshToken: true })).toEqual({});
  });

  it('persist() is a no-op that resolves -- the Set-Cookie header already delivered the token', async () => {
    await expect(store().persist({ refreshToken: 'ignored' })).resolves.toBeUndefined();
  });

  it('clear() is a no-op that resolves -- logout already cleared the cookie server-side', async () => {
    await expect(store().clear()).resolves.toBeUndefined();
  });
});
