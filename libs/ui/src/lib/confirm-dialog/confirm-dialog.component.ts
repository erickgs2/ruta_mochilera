import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';

export interface ConfirmDialogData {
  /** Already-translated dialog title, e.g. "Delete role". */
  title: string;
  /** Already-translated body message, e.g. "This cannot be undone." */
  message: string;
  /** Translation key for the confirm button; defaults to `common.confirm`. */
  confirmKey?: string;
  /** Translation key for the cancel button; defaults to `common.cancel`. */
  cancelKey?: string;
}

/**
 * A generic yes/no confirmation dialog for destructive or hard-to-undo
 * actions (deleting a role, disabling a staff account, cancelling a trip).
 * Opened via `MatDialog.open(ConfirmDialogComponent, { data })`; resolves to
 * `true` on confirm, `false` on cancel or backdrop dismissal.
 */
@Component({
  selector: 'rm-confirm-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, TranslatePipe],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>{{ data.message }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">{{ data.cancelKey ?? 'common.cancel' | translate }}</button>
      <button mat-flat-button color="warn" (click)="confirm()">
        {{ data.confirmKey ?? 'common.confirm' | translate }}
      </button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialogComponent {
  private readonly dialogRef = inject(MatDialogRef<ConfirmDialogComponent, boolean>);
  readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);

  confirm(): void {
    this.dialogRef.close(true);
  }

  cancel(): void {
    this.dialogRef.close(false);
  }
}
