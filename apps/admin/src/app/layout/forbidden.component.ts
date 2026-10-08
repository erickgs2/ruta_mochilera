import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '@rm/auth-web';
import { firstAllowedSection } from './landing';

/** Landing page for `permissionGuard` when the user lacks the section's permission. */
@Component({
  selector: 'rm-forbidden',
  standalone: true,
  imports: [MatButtonModule, RouterLink, TranslatePipe],
  template: `
    <section class="forbidden">
      <h1>{{ 'forbidden.title' | translate }}</h1>
      <p>{{ 'forbidden.message' | translate }}</p>
      @if (backTarget) {
        <a mat-flat-button [routerLink]="backTarget">{{ 'forbidden.back' | translate }}</a>
      }
    </section>
  `,
  styles: `
    .forbidden {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
      padding: 3rem 1rem;
      text-align: center;
    }
  `,
})
export class ForbiddenComponent {
  /** A section this user can open, so "back" never bounces into another forbidden screen; `null` when there is none. */
  protected readonly backTarget = firstAllowedSection(inject(AuthService));
}
