import { BreakpointObserver } from '@angular/cdk/layout';
import { DatePipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { TripsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { HasPermissionDirective } from '@rm/auth-web';
import { MoneyPipe, PageHeaderComponent } from '@rm/ui';
import { combineLatest, debounceTime, distinctUntilChanged, map, startWith, switchMap } from 'rxjs';

type TripSummary = components['schemas']['TripSummary'];
type TripStatus = TripSummary['status'];

/** Viewport width, in pixels, below which the table becomes a stacked card list -- see the template. */
const HANDSET_BREAKPOINT = '(max-width: 640px)';

const TABLE_COLUMNS = ['name', 'status', 'departureDate', 'seats', 'pricePerSeat', 'actions'] as const;

const STATUS_OPTIONS: TripStatus[] = ['DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

/**
 * Chip colour per trip status. `undefined` renders Material's default
 * (grey) chip, used for the two terminal states so they read as inert
 * rather than drawing attention the way `primary`/`accent`/`warn` would.
 */
const STATUS_COLOR: Record<TripStatus, 'primary' | 'accent' | 'warn' | undefined> = {
  DRAFT: undefined,
  PUBLISHED: 'primary',
  IN_PROGRESS: 'accent',
  COMPLETED: undefined,
  CANCELLED: 'warn',
};

/**
 * Lists every trip with its status, departure date, available/total seats
 * and current price per seat, with server-side filtering by status and a
 * debounced text search on name (mirrors `StaffListComponent`'s search).
 *
 * "New trip" and the per-row edit/images/costing links are each gated behind
 * their own permission (`trip.create`, `trip.update`, `trip.budget.view`) --
 * convenience, not security: every one of those routes independently
 * enforces the same permission through `permissionGuard` in `trips.routes.ts`,
 * and the API enforces it again on every request.
 */
@Component({
  selector: 'rm-trips-list',
  standalone: true,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTableModule,
    TranslatePipe,
    HasPermissionDirective,
    MoneyPipe,
    PageHeaderComponent,
  ],
  templateUrl: './trips-list.component.html',
  styleUrl: './trips-list.component.scss',
})
export class TripsListComponent {
  private readonly tripsApi = inject(TripsApi);
  private readonly breakpointObserver = inject(BreakpointObserver);
  private readonly formBuilder = inject(FormBuilder);

  readonly displayedColumns = TABLE_COLUMNS;
  readonly statusOptions = STATUS_OPTIONS;

  readonly filters = this.formBuilder.nonNullable.group({
    search: [''],
    status: ['' as '' | TripStatus],
  });

  readonly isHandset = toSignal(
    this.breakpointObserver.observe(HANDSET_BREAKPOINT).pipe(map((state) => state.matches)),
    { initialValue: false }
  );

  readonly trips = toSignal(
    combineLatest([
      this.filters.controls.search.valueChanges.pipe(debounceTime(300), startWith(''), distinctUntilChanged()),
      this.filters.controls.status.valueChanges.pipe(startWith(this.filters.controls.status.value)),
    ]).pipe(
      switchMap(([search, status]) =>
        this.tripsApi.list({ search: search.trim() || undefined, status: status || undefined })
      )
    ),
    { initialValue: [] as TripSummary[] }
  );

  readonly isEmpty = computed(() => this.trips().length === 0);

  statusColor(status: TripStatus): 'primary' | 'accent' | 'warn' | undefined {
    return STATUS_COLOR[status];
  }
}
