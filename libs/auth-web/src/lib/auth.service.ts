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

interface PersistedSession {
  accessToken: string;
  refreshToken: string;
  user: SessionUser | null;
}

const STORAGE_KEY = 'rm.session';

/**
 * Holds the current session (tokens + user) as signals, and persists it to
 * `localStorage` so a page reload does not sign the user out.
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

  refreshToken(): string | null {
    return this.session()?.refreshToken ?? null;
  }

  hasPermission(permission: string): boolean {
    return this.permissions().includes(permission);
  }

  async login(email: string, password: string): Promise<void> {
    const response = await firstValueFrom(this.api!.login({ email, password }));
    this.persist({
      accessToken: response.tokens.accessToken,
      refreshToken: response.tokens.refreshToken,
      user: response.user,
    });
  }

  async logout(): Promise<void> {
    const token = this.refreshToken();
    if (token) {
      // Even if the server call fails, the local session must still disappear:
      // a user on a flaky connection who clicks "sign out" must not stay signed in.
      await firstValueFrom(this.api!.logout(token)).catch(() => undefined);
    }
    this.clear();
  }

  applyRefreshedSession(accessToken: string, refreshToken: string, user?: SessionUser): void {
    this.persist({ accessToken, refreshToken, user: user ?? this.user() });
  }

  clear(): void {
    this.session.set(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  /** Test seam: lets specs install a session without going through the network. */
  setSessionForTesting(accessToken: string, refreshToken: string, user?: SessionUser): void {
    this.persist({ accessToken, refreshToken, user: user ?? this.user() });
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
