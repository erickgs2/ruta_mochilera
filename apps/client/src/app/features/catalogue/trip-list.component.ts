import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { PublicCatalogueApi, type components } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';
import { CalendarDatePipe } from '@rm/i18n';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { MoneyPipe } from '../../shared/money.pipe';
import { coverImage } from './cover-image';

type PublicTripSummary = components['schemas']['PublicTripSummary'];

/**
 * The public catalogue (`/`), reachable without a session. A trip with no
 * seats left still appears -- marked sold out and with no reserve button --
 * so a visitor learns the trip exists and was popular, instead of it
 * silently vanishing.
 */
@Component({
  selector: 'rm-trip-list',
  imports: [CalendarDatePipe, RouterLink, TranslatePipe, ErrorCodePipe, MoneyPipe],
  templateUrl: './trip-list.component.html',
  styleUrl: './trip-list.component.scss',
})
export class TripListComponent {
  private readonly api = inject(PublicCatalogueApi);

  readonly isAuthenticated = inject(AuthService).isAuthenticated;
  readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  readonly trips = signal<PublicTripSummary[]>([]);
  readonly error = signal<unknown>(null);
  readonly coverImage = coverImage;

  constructor() {
    this.api
      .list()
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: (trips) => {
          this.trips.set(trips);
          this.status.set('ready');
        },
        error: (error: unknown) => {
          this.error.set(error);
          this.status.set('error');
        },
      });
  }
}
