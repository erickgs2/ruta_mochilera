import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  FormBuilder,
  ReactiveFormsModule,
  Validators,
  type FormControl,
  type FormGroup,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
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

type ItemRowForm = FormGroup<{
  concept: FormControl<string>;
  supplier: FormControl<string>;
  quantity: FormControl<number>;
  unitAmountCents: FormControl<number>;
  notes: FormControl<string>;
}>;

const TABLE_COLUMNS = ['concept', 'supplier', 'quantity', 'unitAmount', 'total', 'actions'] as const;

/** Basis points per 100% -- mirrors `BASIS_POINTS` in `@rm/domain-costing`'s `pricing.ts`. */
const BASIS_POINTS = 10_000;

/** `VALIDATION_FAILED`/`INVALID_CAPACITY` field names a budget-item form (the new-item form and each row) can show inline. */
const ITEM_FIELD_NAMES = ['concept', 'quantity', 'unitAmountCents'] as const;

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
 *
 * Each budget-item row owns its own `ItemRowForm` (see `itemForms`), created
 * once per item id and updated in place rather than re-derived from
 * `costing()` on every render: an edit commits explicitly -- on blur, or
 * when `rm-money-input` reports it was blurred via `(committed)` -- so
 * typing "150.00" sends exactly one `PUT`, not one per keystroke. A row that
 * is mid-save or still showing an unresolved error is skipped when
 * `applyCosting` re-syncs the table from a fresher server response (see
 * `syncItemForms`), so a failed edit's text never silently disappears just
 * because some other row saved successfully in the meantime.
 */
@Component({
  selector: 'rm-trip-costing',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
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

  /** One `ItemRowForm` per budget item, keyed by id -- see the class doc comment. */
  private readonly itemForms = new Map<string, ItemRowForm>();
  /** Item ids with a `PUT` currently in flight, so a second blur on the same row cannot fire a second request. */
  readonly savingItemIds = signal<ReadonlySet<string>>(new Set());
  /** Item ids whose last save attempt failed, keyed to the raw error -- rendered inline via `rmErrorCode` so the edit stays visible and marked instead of vanishing. */
  readonly itemErrors = signal<Readonly<Record<string, unknown>>>({});

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
      this.itemForms.clear();
      this.itemErrors.set({});
      this.savingItemIds.set(new Set());
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
    this.syncItemForms(found.items);

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

  /**
   * Creates, updates or drops each row's `ItemRowForm` to match the current
   * server state -- but only when that row is safe to overwrite. A row with
   * an in-flight save (`savingItemIds`) or an unresolved error
   * (`itemErrors`) is left exactly as the administrator typed it: this is
   * what keeps a failed edit visible instead of it being silently discarded
   * the moment some other row's edit succeeds and the whole list re-renders
   * from a fresh `TripCosting` response.
   */
  private syncItemForms(items: readonly BudgetItem[]): void {
    const currentIds = new Set(items.map((item) => item.id));
    for (const id of [...this.itemForms.keys()]) {
      if (!currentIds.has(id)) this.itemForms.delete(id);
    }

    for (const item of items) {
      const existing = this.itemForms.get(item.id);
      if (existing) {
        if (existing.pristine && !this.itemErrors()[item.id]) {
          existing.setValue(this.rowFormValue(item), { emitEvent: false });
        }
        continue;
      }
      this.itemForms.set(item.id, this.buildItemRowForm(item));
    }
  }

  private rowFormValue(item: BudgetItem) {
    return {
      concept: item.concept,
      supplier: item.supplier ?? '',
      quantity: item.quantity,
      unitAmountCents: item.unitAmountCents,
      notes: item.notes ?? '',
    };
  }

  private buildItemRowForm(item: BudgetItem): ItemRowForm {
    return this.formBuilder.nonNullable.group(this.rowFormValue(item));
  }

  /** The row's own editable form, for the template to bind each cell to. Always present for a row currently in `costing()!.items`, since `applyCosting` builds one for every item before the table ever renders it. */
  itemForm(item: BudgetItem): ItemRowForm {
    return this.itemForms.get(item.id)!;
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
        error: (error: unknown) => {
          if (this.applyServerFieldError(error, this.newItemForm, ITEM_FIELD_NAMES)) return;
          this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
        },
      });
  }

  /**
   * Commits one row's edit, called on blur (native inputs) or on
   * `rm-money-input`'s `(committed)` output -- never on every keystroke, so
   * typing an amount sends exactly one `PUT`, not one per character. A
   * no-op when nothing changed (`form.pristine`) or a save for this exact
   * row is already in flight, so a second blur without an edit in between
   * cannot fire a duplicate request.
   */
  commitItem(itemId: string): void {
    const tripId = this.tripId();
    const form = this.itemForms.get(itemId);
    if (!tripId || !form) return;
    if (form.pristine || this.savingItemIds().has(itemId)) return;

    const value = form.getRawValue();
    this.savingItemIds.update((ids) => new Set(ids).add(itemId));

    this.costingApi
      .updateItem(tripId, itemId, {
        concept: value.concept,
        supplier: value.supplier.trim() || undefined,
        quantity: value.quantity,
        unitAmountCents: value.unitAmountCents,
        notes: value.notes.trim() || undefined,
      })
      .subscribe({
        next: (updated) => {
          this.savingItemIds.update((ids) => dropFromSet(ids, itemId));
          this.itemErrors.update((errors) => dropKey(errors, itemId));
          form.markAsPristine();
          this.applyCosting(updated);
        },
        error: (error: unknown) => {
          this.savingItemIds.update((ids) => dropFromSet(ids, itemId));
          this.applyServerFieldError(error, form, ITEM_FIELD_NAMES);
          // Deliberately does not touch `form`'s value, and `syncItemForms`
          // (via `itemErrors` below) will not overwrite it either: the
          // administrator's typed value stays on screen, visibly marked as
          // unsaved, rather than disappearing the next time an unrelated
          // row saves successfully and this table re-renders from the
          // server's response.
          this.itemErrors.update((errors) => ({ ...errors, [itemId]: error }));
        },
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
          if (this.applyServerFieldError(error, this.marginForm, ['marginValue'])) return;
          if (this.applyServerFieldError(error, this.priceForm, ['manualPricePerSeatCents'])) return;
          this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
        },
      });
  }

  /**
   * Maps a `VALIDATION_FAILED`/`INVALID_CAPACITY`-shaped response's
   * `details.field` onto the matching control in `form`, the same pattern
   * `TripFormComponent.serverFieldFrom` uses -- a server error belongs on
   * the offending field, never as a page-level toast, so it can be asserted
   * through `FormControl.hasError('server')` rather than DOM text. Returns
   * `false` (touching nothing) when the error does not name one of `fields`,
   * so the caller's fallback (a snackbar) still fires for anything this
   * form cannot localise.
   */
  private applyServerFieldError(error: unknown, form: FormGroup, fields: readonly string[]): boolean {
    if (!(error instanceof HttpErrorResponse)) return false;
    const field = error.error?.details?.field;
    if (typeof field !== 'string' || !fields.includes(field)) return false;
    const control = form.get(field);
    if (!control) return false;
    // The raw error, not just `true`, is stored under `server`: `hasError('server')`
    // still works (any truthy value satisfies it) for tests, and the template
    // can additionally render the actual message via `errors!['server'] | rmErrorCode`.
    control.setErrors({ ...control.errors, server: error });
    return true;
  }
}

function dropFromSet<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

function dropKey<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
