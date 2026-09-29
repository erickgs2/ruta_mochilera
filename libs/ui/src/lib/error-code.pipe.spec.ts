import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { ErrorCodePipe } from './error-code.pipe';

describe('ErrorCodePipe', () => {
  let pipe: ErrorCodePipe;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideTranslateService({ lang: 'es', fallbackLang: 'es' })],
    });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('es', {
      errors: {
        TRIP_SOLD_OUT: 'El viaje ya no tiene lugares disponibles.',
        UNKNOWN: 'Ocurrió un error inesperado.',
      },
    });
    pipe = TestBed.runInInjectionContext(() => new ErrorCodePipe());
  });

  it('translates the code carried by an HttpErrorResponse', () => {
    const error = new HttpErrorResponse({ status: 409, error: { code: 'TRIP_SOLD_OUT' } });
    expect(pipe.transform(error)).toBe('El viaje ya no tiene lugares disponibles.');
  });

  it('translates a bare error code string', () => {
    expect(pipe.transform('TRIP_SOLD_OUT')).toBe('El viaje ya no tiene lugares disponibles.');
  });

  it('falls back to the generic message for a code with no translation', () => {
    expect(pipe.transform('SOME_FUTURE_CODE')).toBe('Ocurrió un error inesperado.');
  });

  it('falls back to the generic message for an HttpErrorResponse without a code', () => {
    const error = new HttpErrorResponse({ status: 500, error: {} });
    expect(pipe.transform(error)).toBe('Ocurrió un error inesperado.');
  });

  it('falls back to the generic message for an unrecognized value, never an empty string', () => {
    expect(pipe.transform(undefined)).toBe('Ocurrió un error inesperado.');
    expect(pipe.transform(undefined)).not.toBe('');
  });
});
