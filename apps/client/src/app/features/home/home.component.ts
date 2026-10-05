import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthApi } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';

/**
 * The one screen behind `authGuard` this task needs: it exists purely to
 * make the session's survival observable by a human. `user()` comes from
 * `AuthService`'s signal, which `localStorage` repopulates synchronously on
 * construction -- so if this renders the visitor's name right after a page
 * reload, the access token survived the reload. `me()` goes one step
 * further and round-trips to the API with that access token, which is the
 * real proof: a token that merely *looks* present in storage is not the
 * same as one the backend still accepts.
 */
@Component({
  selector: 'rm-home',
  imports: [TranslatePipe],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApi);
  private readonly router = inject(Router);

  readonly user = this.auth.user;
  readonly meStatus = signal<'checking' | 'ok' | 'error'>('checking');

  constructor() {
    void this.checkMe();
  }

  private async checkMe(): Promise<void> {
    try {
      await firstValueFrom(this.api.me());
      this.meStatus.set('ok');
    } catch {
      this.meStatus.set('error');
    }
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
