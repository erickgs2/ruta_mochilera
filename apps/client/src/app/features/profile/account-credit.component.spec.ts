import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { AccountCreditComponent } from './account-credit.component';

function configure() {
  TestBed.configureTestingModule({
    imports: [AccountCreditComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  const fixture = TestBed.createComponent(AccountCreditComponent);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

describe('AccountCreditComponent', () => {
  it('shows the balance and every movement, with no action to take', () => {
    const { fixture, http } = configure();
    http.expectOne('/api/v1/me/credit').flush({
      balanceCents: 100_000,
      entries: [
        { id: 'e2', amountCents: -50_000, kind: 'REFUND', reservationId: null, paymentId: null, reason: 'x', createdAt: '2026-10-02T10:00:00.000Z' },
        { id: 'e1', amountCents: 150_000, kind: 'CANCELLATION', reservationId: 'r1', paymentId: null, reason: null, createdAt: '2026-10-01T10:00:00.000Z' },
      ],
    });
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.credit-balance')?.textContent).toContain('1,000.00');
    expect(element.querySelectorAll('.credit-entry')).toHaveLength(2);
    expect(element.querySelector('.credit-amount--out')).not.toBeNull();
    expect(element.querySelectorAll('button')).toHaveLength(0);
  });

  it('stays hidden while there has never been a movement', () => {
    const { fixture, http } = configure();
    http.expectOne('/api/v1/me/credit').flush({ balanceCents: 0, entries: [] });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.credit')).toBeNull();
  });
});
