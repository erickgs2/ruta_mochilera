import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { RbacApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { HasPermissionDirective } from '@rm/auth-web';
import { ConfirmDialogComponent, ErrorCodePipe, PageHeaderComponent } from '@rm/ui';
import { map } from 'rxjs';

type Role = components['schemas']['Role'];

/** Viewport width, in pixels, below which the table becomes a stacked card list -- see the template. */
const HANDSET_BREAKPOINT = '(max-width: 640px)';

const TABLE_COLUMNS = ['name', 'description', 'permissions', 'users', 'actions'] as const;

/**
 * Lists every role with its permission count and assigned-user count.
 * "New role" and the per-row edit/delete actions are gated behind
 * `role.manage` -- a user with only `role.view` sees the list, read-only.
 * This is convenience, not security: the API enforces `role.manage`
 * independently on every write.
 */
@Component({
  selector: 'rm-roles-list',
  standalone: true,
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatTableModule,
    TranslatePipe,
    HasPermissionDirective,
    ErrorCodePipe,
    PageHeaderComponent,
  ],
  templateUrl: './roles-list.component.html',
  styleUrl: './roles-list.component.scss',
  // `ErrorCodePipe` is a `@Pipe`, never `providedIn: 'root'`; listing it here
  // is what lets `inject(ErrorCodePipe)` below resolve it.
  providers: [ErrorCodePipe],
})
export class RolesListComponent {
  private readonly rbac = inject(RbacApi);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly breakpointObserver = inject(BreakpointObserver);

  readonly displayedColumns = TABLE_COLUMNS;
  readonly roles = signal<Role[]>([]);
  readonly loading = signal(true);

  readonly isHandset = toSignal(
    this.breakpointObserver.observe(HANDSET_BREAKPOINT).pipe(map((state) => state.matches)),
    { initialValue: false }
  );

  constructor() {
    this.load();
  }

  delete(role: Role): void {
    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.translate.instant('roles.deleteTitle'),
        message: this.translate.instant('roles.deleteMessage', { name: role.name }),
      },
    });

    ref.afterClosed().subscribe((confirmed: boolean) => {
      if (!confirmed) return;
      this.rbac.deleteRole(role.id).subscribe({
        next: () => this.load(),
        error: (error: unknown) => {
          // Most commonly ROLE_IN_USE: the list looked clear a moment ago,
          // but PostgreSQL's foreign key is the actual, up-to-date source of
          // truth (see `deleteRole` in `@rm/domain-rbac`).
          this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
        },
      });
    });
  }

  private load(): void {
    this.loading.set(true);
    this.rbac.listRoles().subscribe({
      next: (roles) => {
        this.roles.set(roles);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
