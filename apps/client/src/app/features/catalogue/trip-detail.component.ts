import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, of, switchMap, tap } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { PublicCatalogueApi, type components } from '@rm/api-client';
import { CalendarDatePipe, LanguageService } from '@rm/i18n';
import { ErrorCodePipe } from '../../shared/error-code.pipe';
import { MoneyPipe } from '../../shared/money.pipe';

type PublicTripDetail = components['schemas']['PublicTripDetail'];

/**
 * `/trips/:slug`, reachable without a session. The API answers 404 both for
 * a slug that never existed and for a trip that is no longer published, and
 * both land on the same not-found state -- never a blank screen.
 *
 * The reserve button links to `/trips/:slug/reserve`, which Task 17 adds.
 */
@Component({
  selector: 'rm-trip-detail',
  imports: [CalendarDatePipe, RouterLink, TranslatePipe, ErrorCodePipe, MoneyPipe],
  templateUrl: './trip-detail.component.html',
  styleUrl: './trip-detail.component.scss',
})
export class TripDetailComponent {
  private readonly api = inject(PublicCatalogueApi);
  private readonly language = inject(LanguageService);

  readonly status = signal<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  readonly trip = signal<PublicTripDetail | null>(null);
  readonly error = signal<unknown>(null);

  /** The translation in the visitor's language, else Spanish (the agency's default), else whichever exists. */
  readonly translation = computed(() => {
    const translations = this.trip()?.translations ?? [];
    return (
      translations.find((candidate) => candidate.locale === this.language.current()) ??
      translations.find((candidate) => candidate.locale === 'es') ??
      translations[0] ??
      null
    );
  });

  readonly images = computed(() => [...(this.trip()?.images ?? [])].sort((a, b) => a.position - b.position));

  constructor() {
    // `switchMap`: navigating from one trip to another cancels the previous
    // slug's request, so a slow response can never overwrite the newer trip.
    inject(ActivatedRoute)
      .paramMap.pipe(
        map((params) => params.get('slug') ?? ''),
        tap(() => {
          this.status.set('loading');
          this.error.set(null);
          this.trip.set(null);
        }),
        switchMap((slug) =>
          this.api.get(slug).pipe(
            map((trip) => ({ trip, error: null as unknown })),
            catchError((error: unknown) => of({ trip: null, error }))
          )
        ),
        takeUntilDestroyed()
      )
      .subscribe(({ trip, error }) => {
        this.trip.set(trip);
        this.error.set(error);
        if (trip) this.status.set('ready');
        else this.status.set(error instanceof HttpErrorResponse && error.status === 404 ? 'not-found' : 'error');
      });
  }
}
