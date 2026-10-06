import { authGuard } from '@rm/auth-web';
import { appRoutes } from './app.routes';

function route(path: string) {
  const found = appRoutes.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`no route for "${path}"`);
  return found;
}

describe('appRoutes', () => {
  it.each(['', 'trips/:slug', 'login', 'register', 'verify-email', 'forgot-password', 'reset-password'])(
    'leaves "%s" public -- no session guard',
    (path) => {
      expect(route(path).canActivate ?? []).toEqual([]);
    }
  );

  it.each(['account', 'trips/:slug/reserve', 'reservations/:id', 'reservations/:id/payments', 'inbox'])('keeps "%s" behind the session guard', (path) => {
    expect(route(path).canActivate).toEqual([authGuard]);
  });
});
