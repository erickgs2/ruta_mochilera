import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatStepperModule } from '@angular/material/stepper';
import { MatTabsModule } from '@angular/material/tabs';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TripsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { HasPermissionDirective } from '@rm/auth-web';
import { ConfirmDialogComponent, ErrorCodePipe, MoneyInputComponent, PageHeaderComponent } from '@rm/ui';
import { map } from 'rxjs';
import { toApiDate, toPickerDate } from '../../shared/calendar-date';

type Trip = components['schemas']['Trip'];
type TripStatus = Trip['status'];

/**
 * Frontend copy of `libs/domain/trips/src/lib/trip-status.ts`'s transition
 * table, kept deliberately tiny and duplicated rather than imported: Angular
 * must never depend on a backend domain package (see CLAUDE.md), and this is
 * convenience only -- `TripsApi.changeStatus` still hits an endpoint that
 * re-validates the same rule server-side. If the two ever drift, the server
 * is the one that is right; this table only decides which buttons to show.
 */
const ALLOWED_TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const STATUS_OPTIONS: TripStatus[] = ['DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

/** Maps a `VALIDATION_FAILED`/`INVALID_CAPACITY` response's `details.field` onto the control it belongs to. */
const SERVER_FIELD_CONTROLS = new Set(['departureDate', 'returnDate', 'paymentDeadline', 'totalCapacity', 'preSoldSeats']);

/**
 * Cross-field validator replicating, for immediate feedback, three rules
 * `trip-service.ts` enforces server-side: `returnDate >= departureDate`,
 * `paymentDeadline <= departureDate`, and `preSoldSeats <= totalCapacity`.
 * This is comfort, not the rule -- the backend validates independently and
 * is what actually decides whether a trip is created or updated.
 */
function tripCrossFieldValidator(group: AbstractControl): ValidationErrors | null {
  const departureDate = group.get('departureDate')?.value as Date | null;
  const returnDate = group.get('returnDate')?.value as Date | null;
  const paymentDeadline = group.get('paymentDeadline')?.value as Date | null;
  const totalCapacity = group.get('totalCapacity')?.value as number | null;
  const preSoldSeats = group.get('preSoldSeats')?.value as number | null;

  const errors: ValidationErrors = {};
  if (departureDate && returnDate && returnDate < departureDate) errors['returnBeforeDeparture'] = true;
  if (departureDate && paymentDeadline && paymentDeadline > departureDate) errors['paymentAfterDeparture'] = true;
  if (totalCapacity != null && preSoldSeats != null && preSoldSeats > totalCapacity) {
    errors['preSoldExceedsCapacity'] = true;
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Create/edit screen for a trip: general dates and capacity, Spanish/English
 * content, and (behind `data.backfill`) the hot-start fields for a trip
 * already underway. In edit mode it also hosts the status-transition panel,
 * since a trip's status only makes sense once the trip itself exists.
 *
 * Deliberately does not expose `marginMode`/`marginValue` here: those are the
 * costing screen's responsibility (`TripCostingComponent`), which is where
 * the agency actually works out its margin. A brand-new trip is created with
 * a neutral `PERCENTAGE`/`0` starting policy and no budget yet; an edited
 * trip's existing policy is fetched and sent back unchanged, since
 * `UpdateTripRequest` still requires the fields even though this form never
 * lets a person touch them.
 *
 * `tripId` is read from `ActivatedRoute.paramMap` reactively, not once from
 * `.snapshot`, for the same route-reuse reason documented on
 * `StaffFormComponent` and `RoleFormComponent`: navigating from
 * `/trips/trip-1` straight to `/trips/trip-2` must not leave the first
 * trip's data sitting in the form.
 */
@Component({
  selector: 'rm-trip-form',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatChipsModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatStepperModule,
    MatTabsModule,
    TranslatePipe,
    HasPermissionDirective,
    ErrorCodePipe,
    MoneyInputComponent,
    PageHeaderComponent,
  ],
  templateUrl: './trip-form.component.html',
  styleUrl: './trip-form.component.scss',
  // `ErrorCodePipe` is a `@Pipe`, never `providedIn: 'root'`; listing it here
  // is what lets `inject(ErrorCodePipe)` below resolve it.
  providers: [ErrorCodePipe],
})
export class TripFormComponent {
  private readonly tripsApi = inject(TripsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly formBuilder = inject(FormBuilder);

  private readonly tripId = toSignal(this.route.paramMap.pipe(map((params) => params.get('tripId'))), {
    initialValue: this.route.snapshot.paramMap.get('tripId'),
  });
  readonly isEdit = computed(() => this.tripId() !== null);

  readonly saving = signal(false);
  readonly changingStatus = signal(false);
  readonly trip = signal<Trip | null>(null);
  readonly statusOptions = STATUS_OPTIONS;
  /** Today at midnight, the default lower bound on the departure date picker while the hot-start checkbox is off. */
  readonly today = new Date(new Date().setHours(0, 0, 0, 0));

  readonly form = this.formBuilder.nonNullable.group(
    {
      departureDate: [null as Date | null, Validators.required],
      returnDate: [null as Date | null, Validators.required],
      paymentDeadline: [null as Date | null, Validators.required],
      totalCapacity: [1, [Validators.required, Validators.min(1)]],
      minimumDepositCents: [0, Validators.required],
      holdTtlHours: [72, [Validators.required, Validators.min(1)]],
      nameEs: ['', Validators.required],
      descriptionEs: ['', Validators.required],
      itineraryEs: ['', Validators.required],
      includesEs: ['', Validators.required],
      excludesEs: ['', Validators.required],
      nameEn: [''],
      descriptionEn: [''],
      itineraryEn: [''],
      includesEn: [''],
      excludesEn: [''],
      isBackfilled: [false],
      preSoldSeats: [0, Validators.min(0)],
      initialStatus: ['DRAFT' as TripStatus],
    },
    { validators: [tripCrossFieldValidator] }
  );

  /** Wrapped as a signal so the departure date picker's `[min]` binding reacts to the checkbox under zoneless change detection. */
  readonly isBackfilled = toSignal(this.form.controls.isBackfilled.valueChanges, {
    initialValue: this.form.controls.isBackfilled.value,
  });
  readonly minDepartureDate = computed(() => (this.isBackfilled() ? null : this.today));

  /** The margin/price policy already on the trip, preserved verbatim on update -- see the class doc comment. */
  private existingMarginMode: Trip['marginMode'] = 'PERCENTAGE';
  private existingMarginValue = 0;

  /**
   * Translation keys explaining why "Publish" is unavailable, computed
   * client-side from the same two conditions `changeTripStatus` enforces
   * server-side (`TRIP_NOT_PUBLISHABLE`'s `details.missing`): at least one
   * image and a price above zero. Showing this instead of a disabled button
   * with no explanation, and instead of letting the click round-trip into a
   * rejection, is the whole point of computing it here.
   */
  readonly publishBlockedReasons = computed<string[]>(() => {
    const current = this.trip();
    if (!current) return [];
    const reasons: string[] = [];
    if (current.images.length === 0) reasons.push('trips.publishMissingImages');
    if (current.pricePerSeatCents <= 0) reasons.push('trips.publishMissingPrice');
    return reasons;
  });

  readonly availableTransitions = computed<TripStatus[]>(() => {
    const current = this.trip();
    return current ? ALLOWED_TRANSITIONS[current.status] : [];
  });

  constructor() {
    effect(() => {
      const tripId = this.tripId();

      // Reset to a blank, fully-enabled shape first -- see the class doc
      // comment on why this must happen unconditionally before either branch.
      this.trip.set(null);
      this.form.reset({
        departureDate: null,
        returnDate: null,
        paymentDeadline: null,
        totalCapacity: 1,
        minimumDepositCents: 0,
        holdTtlHours: 72,
        nameEs: '',
        descriptionEs: '',
        itineraryEs: '',
        includesEs: '',
        excludesEs: '',
        nameEn: '',
        descriptionEn: '',
        itineraryEn: '',
        includesEn: '',
        excludesEn: '',
        isBackfilled: false,
        preSoldSeats: 0,
        initialStatus: 'DRAFT',
      });
      this.existingMarginMode = 'PERCENTAGE';
      this.existingMarginValue = 0;

      if (!tripId) return;

      this.tripsApi.get(tripId).subscribe((found) => {
        // The route may have already moved on to a different id by the time
        // this resolves; a response for an id we've since left must not
        // overwrite whatever the (possibly still-loading) new id put here.
        if (this.tripId() !== tripId) return;

        this.trip.set(found);
        this.existingMarginMode = found.marginMode;
        this.existingMarginValue = found.marginValue;

        const spanish = found.translations.find((translation) => translation.locale === 'es');
        const english = found.translations.find((translation) => translation.locale === 'en');

        this.form.patchValue({
          departureDate: toPickerDate(found.departureDate),
          returnDate: toPickerDate(found.returnDate),
          paymentDeadline: toPickerDate(found.paymentDeadline),
          totalCapacity: found.totalCapacity,
          minimumDepositCents: found.minimumDepositCents,
          holdTtlHours: found.holdTtlHours,
          nameEs: spanish?.name ?? '',
          descriptionEs: spanish?.description ?? '',
          itineraryEs: spanish?.itinerary ?? '',
          includesEs: spanish?.includes ?? '',
          excludesEs: spanish?.excludes ?? '',
          nameEn: english?.name ?? '',
          descriptionEn: english?.description ?? '',
          itineraryEn: english?.itinerary ?? '',
          includesEn: english?.includes ?? '',
          excludesEn: english?.excludes ?? '',
          preSoldSeats: found.preSoldSeats,
        });
      });
    });
  }

  save(): void {
    if (this.form.invalid || this.saving()) return;

    this.saving.set(true);
    const tripId = this.tripId();
    const request$ = tripId ? this.tripsApi.update(tripId, this.buildUpdateBody()) : this.tripsApi.create(this.buildCreateBody());

    request$.subscribe({
      next: () => {
        this.saving.set(false);
        void this.router.navigate(['/trips']);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        const field = this.serverFieldFrom(error);
        if (field) {
          const control = this.form.get(field);
          control?.setErrors({ ...control.errors, server: true });
          return;
        }
        this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
      },
    });
  }

  requestStatusChange(target: TripStatus): void {
    const tripId = this.tripId();
    if (!tripId || this.changingStatus()) return;

    const statusLabel = this.translate.instant(`trips.status.${target}`);
    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.translate.instant('trips.confirmStatusChangeTitle'),
        message: this.translate.instant('trips.confirmStatusChangeMessage', { status: statusLabel }),
      },
    });

    ref.afterClosed().subscribe((confirmed: boolean) => {
      if (!confirmed) return;
      this.changingStatus.set(true);
      this.tripsApi.changeStatus(tripId, target).subscribe({
        next: (updated) => {
          this.changingStatus.set(false);
          this.trip.set(updated);
        },
        error: (error: unknown) => {
          this.changingStatus.set(false);
          this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
        },
      });
    });
  }

  private serverFieldFrom(error: unknown): string | null {
    if (!(error instanceof HttpErrorResponse)) return null;
    const field = error.error?.details?.field;
    return typeof field === 'string' && SERVER_FIELD_CONTROLS.has(field) ? field : null;
  }

  private buildTranslations(value: {
    nameEs: string;
    descriptionEs: string;
    itineraryEs: string;
    includesEs: string;
    excludesEs: string;
    nameEn: string;
    descriptionEn: string;
    itineraryEn: string;
    includesEn: string;
    excludesEn: string;
  }) {
    const translations: {
      locale: 'es' | 'en';
      name: string;
      description: string;
      itinerary: string;
      includes: string;
      excludes: string;
    }[] = [
      {
        locale: 'es',
        name: value.nameEs,
        description: value.descriptionEs,
        itinerary: value.itineraryEs,
        includes: value.includesEs,
        excludes: value.excludesEs,
      },
    ];
    // English is optional and falls back to Spanish when absent (see
    // `spanishName` in `trip-service.ts`): only send an English row when the
    // administrator actually typed a name for it.
    if (value.nameEn.trim() !== '') {
      translations.push({
        locale: 'en',
        name: value.nameEn,
        description: value.descriptionEn,
        itinerary: value.itineraryEn,
        includes: value.includesEn,
        excludes: value.excludesEn,
      });
    }
    return translations;
  }

  private buildCreateBody() {
    const value = this.form.getRawValue();
    return {
      departureDate: toApiDate(value.departureDate as Date),
      returnDate: toApiDate(value.returnDate as Date),
      paymentDeadline: toApiDate(value.paymentDeadline as Date),
      totalCapacity: value.totalCapacity,
      preSoldSeats: value.isBackfilled ? value.preSoldSeats : 0,
      holdTtlHours: value.holdTtlHours,
      minimumDepositCents: value.minimumDepositCents,
      // A brand-new trip starts with a neutral margin policy; the costing
      // screen is where it gets a real one -- see the class doc comment.
      marginMode: 'PERCENTAGE' as const,
      marginValue: 0,
      translations: this.buildTranslations(value),
      isBackfilled: value.isBackfilled,
      initialStatus: value.isBackfilled ? value.initialStatus : undefined,
    };
  }

  private buildUpdateBody() {
    const value = this.form.getRawValue();
    return {
      departureDate: toApiDate(value.departureDate as Date),
      returnDate: toApiDate(value.returnDate as Date),
      paymentDeadline: toApiDate(value.paymentDeadline as Date),
      totalCapacity: value.totalCapacity,
      preSoldSeats: value.preSoldSeats,
      holdTtlHours: value.holdTtlHours,
      minimumDepositCents: value.minimumDepositCents,
      // Preserved verbatim -- this form never edits the margin policy.
      marginMode: this.existingMarginMode,
      marginValue: this.existingMarginValue,
      translations: this.buildTranslations(value),
    };
  }
}
