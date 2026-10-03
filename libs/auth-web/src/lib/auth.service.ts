import { computed, Inject, Injectable, Optional, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '@rm/api-client';

export interface SessionUser {
  id: string;
  email: string;
  type: 'STAFF' | 'CUSTOMER';
  locale: 'es' | 'en';
  fullName: string;
  permissions: string[];
}

/**
 * The refresh token is deliberately absent from this shape and from what
 * gets persisted below. It now lives only in the httpOnly, Secure,
 * SameSite=Strict cookie the API sets on `/auth/login` and `/auth/refresh`
 * (see `apps/api/src/lib/http/refresh-cookie.ts`) -- no script on this page,
 * including this one, can read it. `localStorage` is still fine for the
 * access token: it is short-lived, and holding it is what lets a page reload
 * keep the user signed in without a round trip before the first paint.
 */
interface PersistedSession {
  accessToken: string;
  user: SessionUser | null;
}

const STORAGE_KEY = 'rm.session';

/**
 * Holds the current session (access token + user) as signals, and persists it
 * to `localStorage` so a page reload does not sign the user out.
 *
 * `api` is a constructor parameter rather than an `inject()` field
 * initializer on purpose: `inject()` unconditionally requires an active
 * Angular injection context, even with `{ optional: true }` -- calling it
 * from a bare `new AuthService()` (as the "restores a persisted session"
 * spec does, to check construction-time behaviour without going through
 * DI) throws NG0203. A constructor parameter is only resolved when Angular
 * itself constructs the instance (via `TestBed.inject` or the app
 * injector); a plain `new AuthService()` just leaves it at its default of
 * `null`.
 *
 * The token is spelled out with an explicit `@Inject(AuthApi)` rather than
 * relying on the parameter's type alone: Angular's Ivy JIT compiler cannot
 * resolve a DI token from a parameter typed `AuthApi | null` on its own
 * (it throws NG0202), so the token is given directly.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(@Optional() @Inject(AuthApi) private readonly api: AuthApi | null = null) {}

  private readonly session = signal<PersistedSession | null>(readStoredSession());

  readonly user = computed(() => this.session()?.user ?? null);
  readonly permissions = computed(() => this.session()?.user?.permissions ?? []);
  readonly isAuthenticated = computed(() => this.session() !== null && this.user() !== null);

  accessToken(): string | null {
    return this.session()?.accessToken ?? null;
  }

  hasPermission(permission: string): boolean {
    return this.permissions().includes(permission);
  }

  async login(email: string, password: string): Promise<void> {
    const response = await firstValueFrom(this.api!.login({ email, password }));
    this.persist({ accessToken: response.tokens.accessToken, user: response.user });
  }

  async logout(): Promise<void> {
    // Even if the server call fails, the local session must still disappear:
    // a user on a flaky connection who clicks "sign out" must not stay signed
    // in. The server call itself clears the refresh-token cookie; there is no
    // client-held token left for this method to forget.
    await firstValueFrom(this.api!.logout()).catch(() => undefined);
    this.clear();
  }

  applyRefreshedSession(accessToken: string, user?: SessionUser): void {
    this.persist({ accessToken, user: user ?? this.user() });
  }

  clear(): void {
    this.session.set(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  /** Test seam: lets specs install a session without going through the network. */
  setSessionForTesting(accessToken: string, user?: SessionUser): void {
    this.persist({ accessToken, user: user ?? this.user() });
  }

  private persist(session: PersistedSession): void {
    this.session.set(session);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }
}

function readStoredSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedSession) : null;
  } catch {
    return null;
  }
}
