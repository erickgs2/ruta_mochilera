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
        INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
        UNKNOWN: 'Ocurrió un error inesperado.',
      },
    });
    pipe = TestBed.runInInjectionContext(() => new ErrorCodePipe());
  });

  it('translates the code carried by an HttpErrorResponse', () => {
    const error = new HttpErrorResponse({ error: { code: 'INVALID_CREDENTIALS' } });
    expect(pipe.transform(error)).toBe('Correo o contraseña incorrectos.');
  });

  it('translates a bare code string', () => {
    expect(pipe.transform('INVALID_CREDENTIALS')).toBe('Correo o contraseña incorrectos.');
  });

  it('falls back to errors.UNKNOWN for a code with no translation', () => {
    expect(pipe.transform('SOMETHING_NEW')).toBe('Ocurrió un error inesperado.');
  });

  it('falls back to errors.UNKNOWN for a non-HttpErrorResponse, non-string value', () => {
    expect(pipe.transform(null)).toBe('Ocurrió un error inesperado.');
  });
});
