import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { StaffApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { HasPermissionDirective } from '@rm/auth-web';
import { PageHeaderComponent } from '@rm/ui';
import { debounceTime, distinctUntilChanged, map, startWith, switchMap } from 'rxjs';

type Staff = components['schemas']['Staff'];

/** Viewport width, in pixels, below which the table becomes a stacked card list -- see the template. */
const HANDSET_BREAKPOINT = '(max-width: 640px)';

const TABLE_COLUMNS = ['fullName', 'email', 'employeeCode', 'status', 'locale', 'actions'] as const;

/**
 * Each language's own name, shown in itself rather than translated -- the
 * same convention `shell.component.html`'s language menu and
 * `staff-form.component.html`'s locale `mat-select` already use. A locale
 * code ("es"/"en") on its own is not something an administrator should have
 * to decode in a table cell.
 */
const LOCALE_LABELS: Record<Staff['locale'], string> = { es: 'Español', en: 'English' };

/**
 * Lists administrator accounts, with a debounced search box calling
 * `StaffApi.list(search)` (server-side filtering, not client-side). "New
 * administrator" and the per-row edit action are gated behind `staff.manage`
 * -- convenience, not security: the API enforces the permission independently.
 */
@Component({
  selector: 'rm-staff-list',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatTableModule,
    TranslatePipe,
    HasPermissionDirective,
    PageHeaderComponent,
  ],
  templateUrl: './staff-list.component.html',
  styleUrl: './staff-list.component.scss',
})
export class StaffListComponent {
  private readonly staffApi = inject(StaffApi);
  private readonly breakpointObserver = inject(BreakpointObserver);

  readonly displayedColumns = TABLE_COLUMNS;
  readonly searchControl = new FormControl('', { nonNullable: true });

  readonly isHandset = toSignal(
    this.breakpointObserver.observe(HANDSET_BREAKPOINT).pipe(map((state) => state.matches)),
    { initialValue: false }
  );

  readonly staff = toSignal(
    this.searchControl.valueChanges.pipe(
      // Debounce first, then prepend the initial "no filter" load: that load
      // fires immediately on subscribe rather than waiting out the debounce
      // window, while every value the user actually types still goes through it.
      debounceTime(300),
      startWith(''),
      distinctUntilChanged(),
      switchMap((search) => this.staffApi.list(search.trim() || undefined))
    ),
    { initialValue: [] as Staff[] }
  );

  localeLabel(locale: Staff['locale']): string {
    return LOCALE_LABELS[locale];
  }
}
