import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { CustomersApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { HasPermissionDirective } from '@rm/auth-web';
import { PageHeaderComponent } from '@rm/ui';
import { catchError, combineLatest, debounceTime, distinctUntilChanged, map, of, startWith, switchMap, tap } from 'rxjs';

type CustomerPage = components['schemas']['CustomerPage'];
type CustomerSummary = CustomerPage['items'][number];

/** Viewport width, in pixels, below which the table becomes a stacked card list. */
const HANDSET_BREAKPOINT = '(max-width: 640px)';
/** How long typing must pause before the search goes out: one request per thought, not per key. */
export const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 20;

const EMPTY_PAGE: CustomerPage = { items: [], total: 0, page: 1, pageSize: PAGE_SIZE };

/**
 * The counter's customer search (Phase 2B, §5.1): one box for name, email or
 * phone -- accents and case do not matter, the API folds them -- with
 * paging. Typing goes out after a short pause; a new search starts again at
 * page one.
 */
@Component({
  selector: 'rm-customer-list',
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
    HasPermissionDirective,
    PageHeaderComponent,
  ],
  templateUrl: './customer-list.component.html',
  styleUrl: './customer-list.component.scss',
})
export class CustomerListComponent {
  private readonly customersApi = inject(CustomersApi);
  private readonly breakpointObserver = inject(BreakpointObserver);

  readonly columns = ['name', 'email', 'phone', 'account'] as const;
  readonly search = new FormControl('', { nonNullable: true });
  readonly page = signal(1);

  readonly isHandset = toSignal(
    this.breakpointObserver.observe(HANDSET_BREAKPOINT).pipe(map((state) => state.matches)),
    { initialValue: false }
  );

  private readonly query$ = this.search.valueChanges.pipe(
    debounceTime(SEARCH_DEBOUNCE_MS),
    map((value) => value.trim()),
    distinctUntilChanged(),
    // A new search always starts on its first page.
    tap(() => this.page.set(1)),
    startWith('')
  );

  readonly result = toSignal(
    combineLatest([this.query$, toObservable(this.page)]).pipe(
      switchMap(([search, page]) =>
        this.customersApi.search({ search: search || undefined, page, pageSize: PAGE_SIZE }).pipe(catchError(() => of(EMPTY_PAGE)))
      )
    ),
    { initialValue: EMPTY_PAGE }
  );

  readonly pages = computed(() => Math.max(1, Math.ceil(this.result().total / this.result().pageSize)));

  previous(): void {
    this.page.update((page) => Math.max(1, page - 1));
  }

  next(): void {
    this.page.update((page) => Math.min(this.pages(), page + 1));
  }

  accountKey(customer: CustomerSummary): string {
    if (customer.hasPassword) return 'adminCustomers.account.active';
    return customer.invitedAt ? 'adminCustomers.account.invited' : 'adminCustomers.account.none';
  }
}
