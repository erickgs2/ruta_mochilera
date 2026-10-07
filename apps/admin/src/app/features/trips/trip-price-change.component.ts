import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TripsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { ConfirmDialogComponent, ErrorCodePipe, MoneyPipe, PageHeaderComponent } from '@rm/ui';

type PriceChangePreview = components['schemas']['PriceChangePreview'];

const NOTICE_MAX_LENGTH = 2000;

/**
 * Brings a trip's current price to its existing reservations (Phase 2B,
 * §5.6, `trip.change_price`). Always previews first -- which reservations
 * change, by how much, and the credit a lower price creates -- and only then
 * asks for the notice every affected customer receives (Spanish mandatory,
 * English optional) and a confirmation. `NO_PRICE_CHANGE` is not an error
 * here, just "nothing to do".
 */
@Component({
  selector: 'rm-trip-price-change',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatTableModule,
    TranslatePipe,
    ErrorCodePipe,
    MoneyPipe,
    PageHeaderComponent,
  ],
  providers: [ErrorCodePipe, MoneyPipe],
  templateUrl: './trip-price-change.component.html',
  styleUrl: './trip-price-change.component.scss',
})
export class TripPriceChangeComponent implements OnInit {
  private readonly tripsApi = inject(TripsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly money = inject(MoneyPipe);

  private tripId = '';

  readonly columns = ['code', 'customer', 'previous', 'new', 'paid', 'balance', 'credit'] as const;
  readonly noticeMaxLength = NOTICE_MAX_LENGTH;
  readonly preview = signal<PriceChangePreview | null>(null);
  readonly nothingToDo = signal(false);
  readonly loadError = signal<unknown>(null);
  readonly applying = signal(false);

  readonly form = inject(FormBuilder).nonNullable.group({
    noticeEs: ['', [Validators.required, Validators.maxLength(NOTICE_MAX_LENGTH)]],
    noticeEn: ['', Validators.maxLength(NOTICE_MAX_LENGTH)],
  });

  ngOnInit(): void {
    this.route.params.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.tripId = params['tripId'] as string;
      this.load();
    });
  }

  apply(): void {
    const preview = this.preview();
    const noticeEs = this.form.controls.noticeEs.value.trim();
    if (!preview || !noticeEs) {
      this.form.markAllAsTouched();
      return;
    }
    const count = preview.reservations.length;
    this.dialog
      .open(ConfirmDialogComponent, {
        data: {
          title: this.translate.instant('priceChange.confirmTitle', { count }),
          message: this.translate.instant('priceChange.confirmMessage', { price: this.money.transform(preview.priceCents) }),
          confirmKey: 'adminCustomers.credit.confirm',
          cancelKey: 'adminCustomers.credit.back',
        },
      })
      .afterClosed()
      .subscribe((confirmed: boolean) => {
        if (!confirmed) return;
        this.applying.set(true);
        const noticeEn = this.form.controls.noticeEn.value.trim();
        this.tripsApi.applyPriceChange(this.tripId, { noticeEs, ...(noticeEn ? { noticeEn } : {}) }).subscribe({
          next: (applied) => {
            this.applying.set(false);
            this.form.reset();
            this.snackBar.open(
              this.translate.instant('priceChange.applied', { count: applied.reservations.length }),
              undefined,
              { duration: 5000 }
            );
            this.load();
          },
          error: (error: unknown) => {
            this.applying.set(false);
            this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
            this.load();
          },
        });
      });
  }

  private load(): void {
    this.tripsApi.previewPriceChange(this.tripId).subscribe({
      next: (preview) => {
        this.loadError.set(null);
        this.nothingToDo.set(false);
        this.preview.set(preview);
      },
      error: (error: unknown) => {
        this.preview.set(null);
        if (error instanceof HttpErrorResponse && error.error?.code === 'NO_PRICE_CHANGE') {
          this.nothingToDo.set(true);
          return;
        }
        this.loadError.set(error);
      },
    });
  }
}
