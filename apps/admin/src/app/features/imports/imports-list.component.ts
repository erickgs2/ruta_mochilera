import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ImportsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { DateTimePipe } from '@rm/i18n';
import { ErrorCodePipe, PageHeaderComponent, saveFile } from '@rm/ui';

type ImportBatchSummary = components['schemas']['ImportBatchSummary'];

/** Spec §5.8: the API refuses more (IMPORT_TOO_LARGE); checked here too, before uploading 5 MB for nothing. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * CSV imports (Phase 2B, §5.8, `import.manage`): the two templates, the
 * upload -- which only validates and opens the preview -- and the history of
 * batches.
 */
@Component({
  selector: 'rm-imports-list',
  standalone: true,
  imports: [
    DateTimePipe,
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatIconModule,
    MatTableModule,
    TranslatePipe,
    PageHeaderComponent,
  ],
  providers: [ErrorCodePipe],
  templateUrl: './imports-list.component.html',
  styleUrl: './imports-list.component.scss',
})
export class ImportsListComponent {
  private readonly importsApi = inject(ImportsApi);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly errorCode = inject(ErrorCodePipe);

  readonly columns = ['date', 'file', 'type', 'status', 'rows'] as const;
  readonly batches = signal<ImportBatchSummary[]>([]);
  readonly file = signal<File | null>(null);
  readonly uploading = signal(false);

  readonly form = inject(FormBuilder).nonNullable.group({
    type: ['CUSTOMERS' as 'CUSTOMERS' | 'PAYMENTS'],
    sendEmails: [false],
  });

  constructor() {
    this.importsApi.list().subscribe({ next: (batches) => this.batches.set(batches), error: () => this.batches.set([]) });
  }

  downloadTemplate(type: 'customers' | 'payments'): void {
    this.importsApi.template(type).subscribe({
      next: (blob) => saveFile(blob, type === 'customers' ? 'plantilla-clientes.csv' : 'plantilla-pagos.csv'),
      error: (error: unknown) => this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 }),
    });
  }

  choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.file.set(input.files?.[0] ?? null);
  }

  async upload(): Promise<void> {
    const file = this.file();
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      this.snackBar.open(this.errorCode.transform('IMPORT_TOO_LARGE'), undefined, { duration: 6000 });
      return;
    }
    this.uploading.set(true);
    const content = await file.text();
    const { type, sendEmails } = this.form.getRawValue();
    this.importsApi.upload({ type, fileName: file.name, content, sendEmails }).subscribe({
      next: (batch) => {
        this.uploading.set(false);
        void this.router.navigate(['/imports', batch.id]);
      },
      error: (error: unknown) => {
        this.uploading.set(false);
        this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
      },
    });
  }
}
