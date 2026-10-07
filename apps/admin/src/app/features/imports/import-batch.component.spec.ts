import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '@rm/auth-web';
import { staffWith, testProviders } from '../customers/customers.spec-helpers';
import { ImportBatchComponent, POLL_INTERVAL_MS } from './import-batch.component';

const URL = '/api/v1/admin/imports/batch-1';

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'batch-1',
    type: 'CUSTOMERS',
    fileName: 'clientes.csv',
    status: 'VALIDATED',
    rowsTotal: 2,
    rowsOk: 1,
    rowsFailed: 1,
    sendEmails: false,
    createdAt: '2026-10-07T10:00:00.000Z',
    appliedAt: null,
    report: {
      columns: ['full_name', 'email'],
      fileErrors: [],
      rows: [
        { row: 2, values: { full_name: 'Ana', email: 'ana@example.com' }, status: 'VALID', errors: [] },
        { row: 3, values: { full_name: '', email: 'x' }, status: 'INVALID', errors: [{ column: 'email', code: 'INVALID_EMAIL' }] },
      ],
    },
    ...overrides,
  };
}

function configure() {
  const setup = testProviders();
  TestBed.configureTestingModule({
    imports: [ImportBatchComponent],
    providers: [...setup.providers, { provide: ActivatedRoute, useValue: { params: of({ batchId: 'batch-1' }) } }],
  });
  TestBed.inject(AuthService).setSessionForTesting('access', staffWith(['import.manage']));
  const fixture = TestBed.createComponent(ImportBatchComponent);
  fixture.detectChanges();
  return { fixture, httpMock: TestBed.inject(HttpTestingController), dialogOpen: setup.dialogOpen };
}

describe('ImportBatchComponent', () => {
  afterEach(() => {
    localStorage.clear();
    jest.useRealTimers();
  });

  it('shows every row with its errors, by column and code', () => {
    const { fixture, httpMock } = configure();
    httpMock.expectOne(URL).flush(batch());
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.batch-table tr.mat-mdc-row');
    expect(rows).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.batch-error-chip').textContent).toContain('email');
  });

  it('confirms, applies, and follows the batch until it is applied', () => {
    jest.useFakeTimers();
    const { fixture, httpMock, dialogOpen } = configure();
    httpMock.expectOne(URL).flush(batch());
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.batch-apply') as HTMLButtonElement).click();
    expect(dialogOpen).toHaveBeenCalled();
    httpMock.expectOne(`${URL}/apply`).flush(batch({ status: 'APPLYING' }));

    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    httpMock.expectOne(URL).flush(batch({ status: 'APPLYING' }));
    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    const applied = batch({ status: 'APPLIED' });
    applied.report.rows = [
      { ...applied.report.rows[0], outcome: 'CREATED' },
      { ...applied.report.rows[1], outcome: 'FAILED', outcomeCode: 'VALIDATION_FAILED' },
    ] as never;
    httpMock.expectOne(URL).flush(applied);
    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    httpMock.expectNone(URL);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.batch-apply')).toBeNull();
    expect(fixture.nativeElement.querySelector('.batch-status').textContent).toContain('adminImports.statuses.APPLIED');
  });

  it('shows file errors instead of rows for an invalid file', () => {
    const { fixture, httpMock } = configure();
    httpMock.expectOne(URL).flush(batch({ status: 'FAILED', report: { columns: [], fileErrors: [{ code: 'MISSING_COLUMN', column: 'phone' }], rows: [] } }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.batch-file-errors')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.batch-apply')).toBeNull();
  });
});
