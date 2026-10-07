import { BreakpointObserver } from '@angular/cdk/layout';
import { DatePipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AdminReservationsApi, TripsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { AuthService } from '@rm/auth-web';
import { MoneyPipe, PageHeaderComponent } from '@rm/ui';
import { catchError, combineLatest, map, of, startWith, switchMap } from 'rxjs';

type StaffReservationSummary = components['schemas']['StaffReservationSummary'];
type ReservationStatus = StaffReservationSummary['status'];
type TripSummary = components['schemas']['TripSummary'];

/** Viewport width, in pixels, below which the table becomes a stacked card list -- see the template. */
const HANDSET_BREAKPOINT = '(max-width: 640px)';

const TABLE_COLUMNS = ['code', 'customer', 'trip', 'status', 'balance', 'actions'] as const;

const STATUS_OPTIONS: ReservationStatus[] = ['HELD', 'ACTIVE', 'CANCELLED', 'EXPIRED'];

/** Chip colour per reservation status; the two terminal states stay grey. */
const STATUS_COLOR: Record<ReservationStatus, 'primary' | 'accent' | undefined> = {
  HELD: 'accent',
  ACTIVE: 'primary',
  CANCELLED: undefined,
  EXPIRED: undefined,
};

/**
 * The panel's reservation list (Task 19): every customer's reservations,
 * filterable by trip, status and "pending request only".
 *
 * The order comes from the API -- unresolved cancellation requests first,
 * oldest request first -- and this screen only adds emphasis: those rows are
 * marked and highlighted, because they are the administrator's actual work.
 *
 * The trip filter is offered only to someone holding `trip.view`: its options
 * come from `GET /trips`, which requires it, and someone without it can still
 * use every other filter. Convenience, not security -- the API enforces
 * `reservation.view` on the list itself.
 */
@Component({
  selector: 'rm-reservation-list',
  standalone: true,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTableModule,
    TranslatePipe,
    MoneyPipe,
    PageHeaderComponent,
  ],
  templateUrl: './reservation-list.component.html',
  styleUrl: './reservation-list.component.scss',
})
export class ReservationListComponent {
  private readonly reservationsApi = inject(AdminReservationsApi);
  private readonly tripsApi = inject(TripsApi);
  private readonly auth = inject(AuthService);
  private readonly breakpointObserver = inject(BreakpointObserver);
  private readonly formBuilder = inject(FormBuilder);

  readonly displayedColumns = TABLE_COLUMNS;
  readonly statusOptions = STATUS_OPTIONS;
  readonly canFilterByTrip = this.auth.hasPermission('trip.view');

  readonly filters = this.formBuilder.nonNullable.group({
    tripId: [''],
    status: ['' as '' | ReservationStatus],
    pendingOnly: [false],
  });

  readonly isHandset = toSignal(
    this.breakpointObserver.observe(HANDSET_BREAKPOINT).pipe(map((state) => state.matches)),
    { initialValue: false }
  );

  readonly trips = toSignal(
    this.canFilterByTrip ? this.tripsApi.list().pipe(catchError(() => of([] as TripSummary[]))) : of([] as TripSummary[]),
    { initialValue: [] as TripSummary[] }
  );

  readonly reservations = toSignal(
    combineLatest([
      this.filters.controls.tripId.valueChanges.pipe(startWith(this.filters.controls.tripId.value)),
      this.filters.controls.status.valueChanges.pipe(startWith(this.filters.controls.status.value)),
      this.filters.controls.pendingOnly.valueChanges.pipe(startWith(this.filters.controls.pendingOnly.value)),
    ]).pipe(
      switchMap(([tripId, status, pendingOnly]) =>
        this.reservationsApi.list({
          tripId: tripId || undefined,
          status: status || undefined,
          cancellationPending: pendingOnly ? 'true' : undefined,
        })
      )
    ),
    { initialValue: [] as StaffReservationSummary[] }
  );

  readonly isEmpty = computed(() => this.reservations().length === 0);
  readonly pendingCount = computed(() => this.reservations().filter((row) => row.cancellationPending).length);

  statusColor(status: ReservationStatus): 'primary' | 'accent' | undefined {
    return STATUS_COLOR[status];
  }
}
