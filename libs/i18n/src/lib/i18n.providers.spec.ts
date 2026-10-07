import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { provideI18n } from './i18n.providers';

describe('provideI18n', () => {
  it('loads catalogues from a path relative to the base href, so the apps work under /admin/ and /app/', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideI18n()],
    });
    const http = TestBed.inject(HttpTestingController);

    TestBed.inject(TranslateService).use('en').subscribe();

    const request = http.expectOne((req) => req.url.endsWith('en.json'));
    expect(request.request.url).toBe('assets/i18n/en.json');
    request.flush({});
  });
});
