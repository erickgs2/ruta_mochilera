import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { NativeRefreshTokenStore } from './native-refresh-token-store';

// Real Keychain/Keystore access needs a device or simulator; everything
// this spec can check without one is the store's own logic: what it reads
// into its in-memory cache, what it writes through, and what headers it
// derives from that cache. The real plugin is verified separately, on the
// iOS Simulator (see task-15b-report.md) -- this is not a substitute for
// that, only for what Jest can exercise.
jest.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockedSecureStorage = jest.mocked(SecureStorage);

/** What the store would put on a `/auth/refresh` or `/auth/logout` call -- the only observable view of its cached token. */
const refreshCallHeaders = (store: NativeRefreshTokenStore) => store.requestHeaders({ includeRefreshToken: true });

describe('NativeRefreshTokenStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSecureStorage.getItem.mockResolvedValue(null);
    mockedSecureStorage.setItem.mockResolvedValue(undefined);
    mockedSecureStorage.removeItem.mockResolvedValue(undefined);
  });

  it('offers no refresh token before restore() has ever run', () => {
    expect(refreshCallHeaders(new NativeRefreshTokenStore())).toEqual({ 'X-Client-Platform': 'native' });
  });

  it('restore() loads whatever Keychain/Keystore holds into the in-memory cache', async () => {
    mockedSecureStorage.getItem.mockResolvedValue('stored-token');
    const store = new NativeRefreshTokenStore();

    await store.restore();

    expect(refreshCallHeaders(store)['X-Refresh-Token']).toBe('stored-token');
    expect(mockedSecureStorage.getItem).toHaveBeenCalledWith('rm_refresh_token');
  });

  it('restore() leaves the cache null, rather than throwing, when the plugin rejects', async () => {
    mockedSecureStorage.getItem.mockRejectedValue(new Error('keychain unavailable'));
    const store = new NativeRefreshTokenStore();

    await expect(store.restore()).resolves.toBeUndefined();
    expect(refreshCallHeaders(store)).not.toHaveProperty('X-Refresh-Token');
  });

  it('requestHeaders() always marks the caller native, and adds X-Refresh-Token only when asked and once there is a cached value', async () => {
    const store = new NativeRefreshTokenStore();
    expect(refreshCallHeaders(store)).toEqual({ 'X-Client-Platform': 'native' });

    await store.persist({ refreshToken: 'fresh-token' });

    expect(refreshCallHeaders(store)).toEqual({ 'X-Client-Platform': 'native', 'X-Refresh-Token': 'fresh-token' });
    // An ordinary API call never carries the long-lived token.
    expect(store.requestHeaders({ includeRefreshToken: false })).toEqual({ 'X-Client-Platform': 'native' });
  });

  it('persist() updates the in-memory cache immediately and writes through to secure storage', async () => {
    const store = new NativeRefreshTokenStore();

    await store.persist({ refreshToken: 'fresh-token' });

    expect(refreshCallHeaders(store)['X-Refresh-Token']).toBe('fresh-token');
    expect(mockedSecureStorage.setItem).toHaveBeenCalledWith('rm_refresh_token', 'fresh-token');
  });

  it('persist() does nothing when the response carried no refreshToken (should not happen, but must not wipe a good cached token)', async () => {
    const store = new NativeRefreshTokenStore();
    await store.persist({ refreshToken: 'fresh-token' });
    jest.clearAllMocks();

    await store.persist({});

    expect(refreshCallHeaders(store)['X-Refresh-Token']).toBe('fresh-token');
    expect(mockedSecureStorage.setItem).not.toHaveBeenCalled();
  });

  it('clear() wipes the in-memory cache and secure storage', async () => {
    const store = new NativeRefreshTokenStore();
    await store.persist({ refreshToken: 'fresh-token' });

    await store.clear();

    expect(refreshCallHeaders(store)).not.toHaveProperty('X-Refresh-Token');
    expect(mockedSecureStorage.removeItem).toHaveBeenCalledWith('rm_refresh_token');
  });

  it('clear() still wipes the in-memory cache even when the plugin rejects', async () => {
    mockedSecureStorage.removeItem.mockRejectedValue(new Error('keychain unavailable'));
    const store = new NativeRefreshTokenStore();
    await store.persist({ refreshToken: 'fresh-token' });

    await expect(store.clear()).resolves.toBeUndefined();
    expect(refreshCallHeaders(store)).not.toHaveProperty('X-Refresh-Token');
  });
});
