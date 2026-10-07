import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ImportsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { DateTimePipe } from '@rm/i18n';
import { ConfirmDialogComponent, ErrorCodePipe, PageHeaderComponent } from '@rm/ui';
import { timer } from 'rxjs';

type ImportBatch = components['schemas']['ImportBatch'];
type ImportRow = ImportBatch['report']['rows'][number];

/** How often an APPLYING batch is asked for again. */
export const POLL_INTERVAL_MS = 2_000;
/** Rows drawn at once: a 5,000-row table helps nobody; the filter narrows it. */
const MAX_ROWS_SHOWN = 500;

/**
 * One import batch (Phase 2B, §5.8): before applying, the preview -- every
 * row ready, with errors (column and code, translated) or already existing --
 * and the confirmation; after, the report of what each row did. While the
 * worker applies it, the screen asks again every couple of seconds.
 */
@Component({
  selector: 'rm-import-batch',
  standalone: true,
  imports: [
    DateTimePipe,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatSlideToggleModule,
    MatTableModule,
    TranslatePipe,
    ErrorCodePipe,
    PageHeaderComponent,
  ],
  providers: [ErrorCodePipe],
  templateUrl: './import-batch.component.html',
  styleUrl: './import-batch.component.scss',
})
export class ImportBatchComponent implements OnInit {
  private readonly importsApi = inject(ImportsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);

  readonly columns = ['row', 'values', 'status', 'detail'] as const;
  readonly batch = signal<ImportBatch | null>(null);
  readonly loadError = signal<unknown>(null);
  readonly problemsOnly = signal(false);
  readonly applying = signal(false);

  readonly rows = computed(() => {
    const rows = this.batch()?.report.rows ?? [];
    const filtered = this.problemsOnly() ? rows.filter((row) => this.isProblem(row)) : rows;
    return filtered.slice(0, MAX_ROWS_SHOWN);
  });
  readonly hiddenRows = computed(() => {
    const rows = this.batch()?.report.rows ?? [];
    const total = this.problemsOnly() ? rows.filter((row) => this.isProblem(row)).length : rows.length;
    return Math.max(0, total - MAX_ROWS_SHOWN);
  });
  readonly applicableRows = computed(() => (this.batch()?.report.rows ?? []).filter((row) => row.status === 'VALID').length);

  private batchId = '';
  private polling = false;

  ngOnInit(): void {
    this.route.params.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.batchId = params['batchId'] as string;
      this.load();
    });
  }

  isProblem(row: ImportRow): boolean {
    return row.outcome ? row.outcome === 'FAILED' : row.status === 'INVALID';
  }

  /**
   * The row's first values, in the template's column order -- the stored
   * report is `jsonb`, which does not keep the keys in the order they were
   * written.
   */
  summary(row: ImportRow): string {
    const columns = this.batch()?.report.columns ?? Object.keys(row.values);
    return columns
      .map((column) => row.values[column] ?? '')
      .filter((value) => value !== '')
      .slice(0, 3)
      .join(' · ');
  }

  apply(): void {
    const batch = this.batch();
    if (!batch) return;
    this.dialog
      .open(ConfirmDialogComponent, {
        data: {
          title: this.translate.instant('adminImports.applyTitle', { count: this.applicableRows() }),
          message: this.translate.instant('adminImports.applyMessage'),
          confirmKey: 'adminCustomers.credit.confirm',
          cancelKey: 'adminCustomers.credit.back',
        },
      })
      .afterClosed()
      .subscribe((confirmed: boolean) => {
        if (!confirmed) return;
        this.applying.set(true);
        this.importsApi.apply(batch.id).subscribe({
          next: (claimed) => {
            this.applying.set(false);
            this.batch.set(claimed);
            this.pollWhileApplying();
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
    this.importsApi.get(this.batchId).subscribe({
      next: (batch) => {
        this.loadError.set(null);
        this.batch.set(batch);
        if (!batch.report.rows.some((row) => this.isProblem(row))) this.problemsOnly.set(false);
        this.pollWhileApplying();
      },
      error: (error: unknown) => this.loadError.set(error),
    });
  }

  private pollWhileApplying(): void {
    if (this.batch()?.status !== 'APPLYING' || this.polling) return;
    this.polling = true;
    timer(POLL_INTERVAL_MS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.importsApi.get(this.batchId).subscribe({
          next: (batch) => {
            this.polling = false;
            this.batch.set(batch);
            if (batch.status === 'APPLIED') {
              this.snackBar.open(this.translate.instant('adminImports.applied'), undefined, { duration: 5000 });
            }
            this.pollWhileApplying();
          },
          error: () => {
            this.polling = false;
          },
        });
      });
  }
}
