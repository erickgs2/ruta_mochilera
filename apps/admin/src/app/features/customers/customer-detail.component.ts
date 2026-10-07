import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { CustomersApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { HasPermissionDirective } from '@rm/auth-web';
import { CalendarDatePipe, DateTimePipe } from '@rm/i18n';
import { ErrorCodePipe, MoneyPipe, PageHeaderComponent } from '@rm/ui';
import { CounterReservationComponent } from './counter-reservation.component';
import { CustomerBackfillComponent } from './customer-backfill.component';
import { CustomerCreditComponent } from './customer-credit.component';

type CustomerDetail = components['schemas']['CustomerDetail'];

/**
 * One customer at the counter (Phase 2B): their details, whether they have
 * activated their app account (and the invitation to do it), their
 * reservations, their account credit, and the counter actions -- a new
 * reservation, historical capture. Each block is shown only to someone
 * holding its permission; the API checks the same on every call.
 */
@Component({
  selector: 'rm-customer-detail',
  standalone: true,
  imports: [
    DateTimePipe,
    CalendarDatePipe,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    ErrorCodePipe,
    HasPermissionDirective,
    MoneyPipe,
    PageHeaderComponent,
    CounterReservationComponent,
    CustomerBackfillComponent,
    CustomerCreditComponent,
  ],
  providers: [ErrorCodePipe],
  templateUrl: './customer-detail.component.html',
  styleUrl: './customer-detail.component.scss',
})
export class CustomerDetailComponent implements OnInit {
  private readonly customersApi = inject(CustomersApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);

  readonly customer = signal<CustomerDetail | null>(null);
  readonly loadError = signal<unknown>(null);
  readonly inviting = signal(false);

  ngOnInit(): void {
    this.route.params.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.customer.set(null);
      this.load(params['customerId'] as string);
    });
  }

  invite(): void {
    const customer = this.customer();
    if (!customer) return;
    this.inviting.set(true);
    this.customersApi.invite(customer.id).subscribe({
      next: (updated) => {
        this.inviting.set(false);
        this.customer.set(updated);
        this.snackBar.open(this.translate.instant('adminCustomers.detail.invited'), undefined, { duration: 4000 });
      },
      error: (error: unknown) => {
        this.inviting.set(false);
        this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
      },
    });
  }

  reload(): void {
    const customer = this.customer();
    if (customer) this.load(customer.id);
  }

  private load(customerId: string): void {
    this.customersApi.get(customerId).subscribe({
      next: (customer) => {
        this.loadError.set(null);
        this.customer.set(customer);
      },
      error: (error: unknown) => this.loadError.set(error),
    });
  }
}
