import { authWeb } from './auth-web';

describe('authWeb', () => {
  it('should work', () => {
    expect(authWeb()).toEqual('auth-web');
  });
});
