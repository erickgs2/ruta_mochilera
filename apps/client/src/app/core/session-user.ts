import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '@rm/api-client';
import { AuthService, type SessionUser } from '@rm/auth-web';

/**
 * Re-reads the signed-in user from `/me` and replaces the cached copy,
 * keeping the current access token. The cached user is whatever login or the
 * last refresh returned; `emailVerified` in particular goes stale the moment
 * the customer verifies on another screen.
 */
@Injectable({ providedIn: 'root' })
export class SessionUserRefresher {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthService);

  /** Resolves with the fresh user, or `null` when nobody is signed in on this device. */
  async refresh(): Promise<SessionUser | null> {
    const token = this.auth.accessToken();
    if (!token || !this.auth.isAuthenticated()) return null;
    const user = (await firstValueFrom(this.api.me())) as SessionUser;
    this.auth.applyRefreshedSession(token, user);
    return user;
  }
}
