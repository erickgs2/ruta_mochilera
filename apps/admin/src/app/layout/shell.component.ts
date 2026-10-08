import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, effect, inject, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
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
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);

  protected readonly auth = inject(AuthService);
  protected readonly language = inject(LanguageService);

  protected readonly isSideMode = toSignal(
    this.breakpointObserver.observe(SIDE_MODE_BREAKPOINT).pipe(map((state) => state.matches)),
    { initialValue: false }
  );

  /** The signed-in user's stored locale. A `computed`, so it only changes when the *value* does. */
  private readonly userLocale = computed(() => this.auth.user()?.locale);

  constructor() {
    // Follow the signed-in user's stored language preference (set on login)
    // rather than only the browser default or whatever was last picked on this
    // device. It reacts to the stored locale *value*, not to the user object:
    // a token refresh hands back a fresh user object with the same locale, and
    // that must not undo a language the person picked from the menu. Nor may
    // the current language be tracked here, or picking one re-runs this and
    // forces the stored locale straight back. A pick is saved through
    // `switchLanguage`, which also updates the stored locale.
    effect(() => {
      const locale = this.userLocale();
      if (locale && locale !== untracked(() => this.language.current())) {
        this.language.use(locale);
      }
    });
  }

  /**
   * Optimistic: the interface switches at once and the choice is saved in the
   * background. If saving fails the previous language comes back and a toast
   * says so, in the language the person was already reading.
   */
  protected async switchLanguage(locale: 'es' | 'en'): Promise<void> {
    const previous = this.language.current();
    if (locale === previous) return;
    this.language.use(locale);
    try {
      await this.auth.saveLocale(locale);
    } catch {
      this.language.use(previous);
      this.snackBar.open(this.translate.instant('shell.languageSaveFailed'), undefined, { duration: 6000 });
    }
  }

  protected async signOut(): Promise<void> {
    // logout() clears the local session even if the server call fails, so
    // this navigation always runs.
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
