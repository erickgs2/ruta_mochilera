import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService, HasPermissionDirective } from '@rm/auth-web';
import { LanguageService } from '@rm/i18n';
import { map } from 'rxjs';

/** Viewport width, in pixels, above which the sidenav docks beside the content instead of overlaying it. */
const SIDE_MODE_BREAKPOINT = '(min-width: 960px)';

/**
 * The authenticated shell: a top toolbar (language switch, user name, sign
 * out) plus a nav sidenav, with `<router-outlet>` for the section screens.
 * Responsive per the spec: `side` mode from ~960px, `over` (overlay, closed
 * by default) below it, so the panel works on phone, tablet and desktop.
 *
 * Each nav entry is wrapped in `*rmHasPermission` for its section -- purely
 * a convenience so a user without a permission does not see a link to a
 * screen that would fail; the API enforces the permission independently.
 */
@Component({
  selector: 'rm-shell',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatSidenavModule,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatMenuModule,
    TranslatePipe,
    HasPermissionDirective,
  ],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  private readonly breakpointObserver = inject(BreakpointObserver);
  private readonly router = inject(Router);

  protected readonly auth = inject(AuthService);
  protected readonly language = inject(LanguageService);

  protected readonly isSideMode = toSignal(
    this.breakpointObserver.observe(SIDE_MODE_BREAKPOINT).pipe(map((state) => state.matches)),
    { initialValue: false }
  );

  constructor() {
    // Follow the signed-in user's stored language preference (set on login
    // and on every token refresh) rather than only the browser default or
    // whatever was last picked on this device. A manual pick via the
    // language menu still updates `LanguageService` immediately; this just
    // keeps the two in sync whenever the session's user record changes.
    effect(() => {
      const user = this.auth.user();
      if (user && user.locale !== this.language.current()) {
        this.language.use(user.locale);
      }
    });
  }

  protected switchLanguage(locale: 'es' | 'en'): void {
    this.language.use(locale);
  }

  protected async signOut(): Promise<void> {
    // logout() clears the local session even if the server call fails, so
    // this navigation always runs.
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
