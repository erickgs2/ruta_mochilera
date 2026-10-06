import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ReservationsApi, type components } from '@rm/api-client';
import { CalendarDatePipe } from '@rm/i18n';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { MoneyPipe } from '../../shared/money.pipe';

type ReservationSummary = components['schemas']['ReservationSummary'];

/**
 * `/reservations`, behind the session guard ("Mis reservas", spec §287): the
 * customer's whole history, newest first as the API sends it -- cancelled and
 * expired reservations included -- each row naming its trip and linking to
 * its detail. The trip's name and date come with the row (`tripName`,
 * `tripDepartureDate`); this screen does not look trips up on its own.
 */
@Component({
  selector: 'rm-reservation-list',
  imports: [RouterLink, TranslatePipe, ErrorCodePipe, MoneyPipe, CalendarDatePipe],
  templateUrl: './reservation-list.component.html',
  styleUrl: './reservations.scss',
})
export class ReservationListComponent {
  readonly reservations = signal<ReservationSummary[] | null>(null);
  readonly error = signal<unknown>(null);

  constructor() {
    inject(ReservationsApi)
      .list()
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: (reservations) => this.reservations.set(reservations),
        error: (error: unknown) => this.error.set(error),
      });
  }
}
