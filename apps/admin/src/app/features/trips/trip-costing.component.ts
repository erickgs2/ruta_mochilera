import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { ActivatedRoute } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { CostingApi, TripsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { ConfirmDialogComponent, ErrorCodePipe, MoneyInputComponent, MoneyPipe, PageHeaderComponent } from '@rm/ui';
import { map } from 'rxjs';

type TripCosting = components['schemas']['TripCosting'];
type BudgetItem = components['schemas']['BudgetItem'];
type MarginMode = TripCosting['marginMode'];
type PriceMode = TripCosting['priceMode'];
type TripStatus = components['schemas']['Trip']['status'];

const TABLE_COLUMNS = ['concept', 'supplier', 'quantity', 'unitAmount', 'total', 'actions'] as const;

/** Basis points per 100% -- mirrors `BASIS_POINTS` in `@rm/domain-costing`'s `pricing.ts`. */
const BASIS_POINTS = 10_000;

/**
 * Costing screen: the editable budget line-item table, the margin policy
 * that turns the budget total into a sale price, and the manual-price
 * override. This is the screen the task brief calls "the central hazard":
 * `marginValue` is basis points under `PERCENTAGE` and cents under the two
 * fixed modes, and nothing in the wire format tells the two apart -- see
 * `MarginMode` and `PricingInput.marginValue`'s doc comment in
 * `@rm/domain-costing`.
 *
 * The fix here is that the *value the user types never has an ambiguous
 * unit*: `marginForm.controls.marginValue` holds a plain percentage (e.g.
 * "20" for 20 %) while `marginMode` is `PERCENTAGE`, and holds cents (via
 * `rm-money-input`, which is itself unambiguous) under either fixed mode.
 * `wireMarginValue()` is the single place that converts the currently-
 * displayed number into what the wire format actually wants, right before
 * `savePricingPolicy` sends it -- so a caller can never accidentally forward
 * a percentage where the API expects basis points or cents, or vice versa.
 *
 * `tripId` comes off `ActivatedRoute.params` (not `paramMap`) reactively --
 * still never `.snapshot`, for the same route-reuse reason documented on the
 * other trip screens.
 */
@Component({
  selector: 'rm-trip-costing',
  standalone: true,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTableModule,
    TranslatePipe,
    ErrorCodePipe,
    MoneyInputComponent,
    MoneyPipe,
    PageHeaderComponent,
  ],
  templateUrl: './trip-costing.component.html',
  styleUrl: './trip-costing.component.scss',
  // `ErrorCodePipe` is a `@Pipe`, never `providedIn: 'root'`; listing it here
  // is what lets `inject(ErrorCodePipe)` below resolve it.
  providers: [ErrorCodePipe],
})
export class TripCostingComponent {
  private readonly costingApi = inject(CostingApi);
  private readonly tripsApi = inject(TripsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly formBuilder = inject(FormBuilder);

  private readonly tripId = toSignal(
    this.route.params.pipe(map((params) => (params['tripId'] as string | undefined) ?? null)),
    { initialValue: (this.route.snapshot.params['tripId'] as string | undefined) ?? null }
  );

  readonly displayedColumns = TABLE_COLUMNS;
  readonly costing = signal<TripCosting | null>(null);
  readonly tripStatus = signal<TripStatus | null>(null);
  readonly saving = signal(false);

  /** Loaded once per trip id, so a later budget-item edit does not clobber unsaved margin/price edits -- see `applyCosting`. */
  private policyInitializedFor: string | null = null;
  /** True while `applyCosting` is seeding `marginForm` from the server, so that write does not itself trigger the mode-change reset below. */
  private suppressMarginValueReset = false;

  readonly newItemForm = this.formBuilder.nonNullable.group({
    concept: ['', Validators.required],
    supplier: [''],
    quantity: [1, [Validators.required, Validators.min(1)]],
    unitAmountCents: [0, [Validators.required, Validators.min(1)]],
    notes: [''],
  });

  readonly marginForm = this.formBuilder.nonNullable.group({
    marginMode: 'PERCENTAGE' as MarginMode,
    // Percent (e.g. 20 for 20 %) under PERCENTAGE, cents under either fixed
    // mode -- see the class doc comment.
    marginValue: 0,
  });

  readonly priceForm = this.formBuilder.nonNullable.group({
    priceMode: 'AUTO' as PriceMode,
    manualPricePerSeatCents: 0,
  });

  readonly marginMode = toSignal(this.marginForm.controls.marginMode.valueChanges, {
    initialValue: this.marginForm.controls.marginMode.value,
  });
  readonly priceMode = toSignal(this.priceForm.controls.priceMode.valueChanges, {
    initialValue: this.priceForm.controls.priceMode.value,
  });

  /** Translation key for the margin field's label suffix -- "%" for PERCENTAGE, currency for either fixed mode. */
  readonly marginUnitLabel = computed(() =>
    this.marginMode() === 'PERCENTAGE' ? 'costing.unit.percent' : 'costing.unit.currency'
  );

  /** Translation key for the margin field's hint -- one per mode, since the two fixed modes share a unit but not a meaning. */
  readonly marginHintKey = computed(() => `costing.marginValueHint.${this.marginMode()}`);

  readonly isPriceOverridden = computed(() => this.costing()?.priceMode === 'MANUAL');

  readonly showRepriceNotice = computed(() => this.tripStatus() !== null && this.tripStatus() !== 'DRAFT');

  constructor() {
    this.route.params.subscribe((params) => {
      const tripId = (params['tripId'] as string | undefined) ?? null;
      this.costing.set(null);
      this.tripStatus.set(null);
      this.policyInitializedFor = null;
      if (!tripId) return;
      this.load(tripId);
    });

    // Switching margin mode leaves the raw number in `marginValue` sitting
    // there under a new unit -- e.g. "20" meant 20 % a moment ago and would
    // now be read as 20 cents. Clearing it on every mode change (except the
    // one `applyCosting` performs while seeding the form from the server,
    // suppressed via `suppressMarginValueReset` below) means a stale number
    // can never be silently reinterpreted in the wrong unit.
    this.marginForm.controls.marginMode.valueChanges.subscribe(() => {
      if (this.suppressMarginValueReset) return;
      this.marginForm.controls.marginValue.setValue(0);
    });
  }

  private load(tripId: string): void {
    this.costingApi.get(tripId).subscribe((found) => {
      if (this.tripId() !== tripId) return;
      this.applyCosting(found);
    });
    this.tripsApi.get(tripId).subscribe((found) => {
      if (this.tripId() !== tripId) return;
      this.tripStatus.set(found.status);
    });
  }

  private applyCosting(found: TripCosting): void {
    this.costing.set(found);

    // Only seed the margin/price forms the first time this trip's costing
    // loads: every later call comes from a budget-item mutation that leaves
    // the margin policy itself unchanged, and re-patching here would discard
    // whatever the administrator is mid-typing in those fields.
    if (this.policyInitializedFor === found.tripId) return;
    this.policyInitializedFor = found.tripId;

    this.suppressMarginValueReset = true;
    this.marginForm.setValue({
      marginMode: found.marginMode,
      marginValue: found.marginMode === 'PERCENTAGE' ? found.marginValue / 100 : found.marginValue,
    });
    this.suppressMarginValueReset = false;
    this.priceForm.setValue({
      priceMode: found.priceMode,
      manualPricePerSeatCents: found.priceMode === 'MANUAL' ? found.pricePerSeatCents : 0,
    });
  }

  rowTotal(item: BudgetItem): number {
    return item.quantity * item.unitAmountCents;
  }

  addItem(): void {
    const tripId = this.tripId();
    if (!tripId || this.newItemForm.invalid) return;

    const value = this.newItemForm.getRawValue();
    this.costingApi
      .addItem(tripId, {
        concept: value.concept,
        supplier: value.supplier.trim() || undefined,
        quantity: value.quantity,
        unitAmountCents: value.unitAmountCents,
        notes: value.notes.trim() || undefined,
      })
      .subscribe({
        next: (updated) => {
          this.applyCosting(updated);
          this.newItemForm.reset({ concept: '', supplier: '', quantity: 1, unitAmountCents: 0, notes: '' });
        },
        error: (error: unknown) => this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 }),
      });
  }

  updateItemField(item: BudgetItem, patch: Partial<Pick<BudgetItem, 'concept' | 'supplier' | 'quantity' | 'unitAmountCents' | 'notes'>>): void {
    const tripId = this.tripId();
    if (!tripId) return;

    const merged = { ...item, ...patch };
    this.costingApi
      .updateItem(tripId, item.id, {
        concept: merged.concept,
        supplier: merged.supplier ?? undefined,
        quantity: merged.quantity,
        unitAmountCents: merged.unitAmountCents,
        notes: merged.notes ?? undefined,
      })
      .subscribe({
        next: (updated) => this.applyCosting(updated),
        error: (error: unknown) => this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 }),
      });
  }

  deleteItem(item: BudgetItem): void {
    const tripId = this.tripId();
    if (!tripId) return;

    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.translate.instant('costing.deleteItemTitle'),
        message: this.translate.instant('costing.deleteItemMessage', { concept: item.concept }),
      },
    });

    ref.afterClosed().subscribe((confirmed: boolean) => {
      if (!confirmed) return;
      this.costingApi.deleteItem(tripId, item.id).subscribe({
        next: (updated) => this.applyCosting(updated),
        error: (error: unknown) => this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 }),
      });
    });
  }

  /**
   * Converts the margin field's on-screen value into what
   * `PricingPolicyRequest.marginValue` actually wants: basis points under
   * `PERCENTAGE` (so "20", meaning 20 %, becomes 2000 -- `BASIS_POINTS` is
   * 10000 per 100 %, so one percentage point is 100 basis points), or the raw
   * cents figure -- already correct, since it came straight from
   * `rm-money-input` -- under either fixed mode. Deliberately named after
   * "wire", not "cents": the whole point of this function is that its result
   * is *not* always cents. This is the one place the conversion happens;
   * nothing downstream of it ever sees an ambiguous number.
   */
  private wireMarginValue(): number {
    const raw = this.marginForm.controls.marginValue.value;
    const mode = this.marginForm.controls.marginMode.value;
    return mode === 'PERCENTAGE' ? Math.round(raw * (BASIS_POINTS / 100)) : raw;
  }

  savePricingPolicy(): void {
    const tripId = this.tripId();
    if (!tripId || this.saving()) return;

    const marginMode = this.marginForm.controls.marginMode.value;
    const priceMode = this.priceForm.controls.priceMode.value;

    this.saving.set(true);
    this.costingApi
      .setPricingPolicy(tripId, {
        marginMode,
        marginValue: this.wireMarginValue(),
        priceMode,
        manualPricePerSeatCents:
          priceMode === 'MANUAL' ? this.priceForm.controls.manualPricePerSeatCents.value : undefined,
      })
      .subscribe({
        next: (updated) => {
          this.saving.set(false);
          this.applyCosting(updated);
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
        },
      });
  }
}
