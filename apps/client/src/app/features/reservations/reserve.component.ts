import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { PublicCatalogueApi, ReservationsApi, type components } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';
import { LanguageService } from '@rm/i18n';
import { SessionUserRefresher } from '../../core/session-user';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { MoneyPipe } from '../../shared/money.pipe';
import { PaymentMethodComponent } from '../payments/payment-method.component';

type PublicTripDetail = components['schemas']['PublicTripDetail'];
type ReservationDetail = components['schemas']['ReservationDetail'];

/**
 * `/trips/:slug/reserve`, behind the session guard.
 *
 * Creates the hold first and then shows the amounts **from that response**
 * -- total, minimum deposit and the suggested monthly payment -- without
 * recomputing any of them: a second implementation of the monthly payment
 * here would drift from the backend's sooner or later.
 *
 * A customer whose email is not verified sees an invitation to verify
 * instead of the reserve button. `/me` is re-read on arrival because the
 * cached user may predate a verification; `EMAIL_NOT_VERIFIED` from the API
 * leads to the same invitation, as a fallback.
 */
@Component({
  selector: 'rm-reserve',
  imports: [RouterLink, TranslatePipe, ErrorCodePipe, MoneyPipe, PaymentMethodComponent],
  templateUrl: './reserve.component.html',
  styleUrl: './reservations.scss',
})
export class ReserveComponent {
  private readonly catalogue = inject(PublicCatalogueApi);
  private readonly reservations = inject(ReservationsApi);
  private readonly language = inject(LanguageService);
  private readonly router = inject(Router);
  private readonly sessionUser = inject(SessionUserRefresher);

  readonly user = inject(AuthService).user;
  readonly slug = inject(ActivatedRoute).snapshot.paramMap.get('slug') ?? '';
  readonly trip = signal<PublicTripDetail | null>(null);
  readonly tripError = signal<unknown>(null);
  readonly reservation = signal<ReservationDetail | null>(null);
  readonly loading = signal(false);
  readonly error = signal<unknown>(null);
  readonly mustVerify = signal(false);

  readonly tripName = computed(() => {
    const translations = this.trip()?.translations ?? [];
    return (
      translations.find((t) => t.locale === this.language.current())?.name ??
      translations.find((t) => t.locale === 'es')?.name ??
      this.slug
    );
  });

  readonly showVerifyInvite = computed(() => this.mustVerify() || this.user()?.emailVerified === false);

  constructor() {
    this.catalogue.get(this.slug).subscribe({
      next: (trip) => this.trip.set(trip),
      error: (error: unknown) => this.tripError.set(error),
    });
    void this.sessionUser.refresh().catch(() => undefined);
  }

  async reserve(): Promise<void> {
    const trip = this.trip();
    if (!trip || this.loading() || this.showVerifyInvite()) return;

    this.loading.set(true);
    this.error.set(null);
    try {
      this.reservation.set(await firstValueFrom(this.reservations.create(trip.id)));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.error?.code === 'EMAIL_NOT_VERIFIED') this.mustVerify.set(true);
      else this.error.set(error);
    } finally {
      this.loading.set(false);
    }
  }

  /** Stripe accepted the card: the reservation screen waits for the webhook. */
  async onCardConfirmed(): Promise<void> {
    const reservation = this.reservation();
    if (reservation) await this.router.navigate(['/reservations', reservation.id], { queryParams: { processing: 1 } });
  }
}
