import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { API_BASE_URL } from '@rm/api-client';
import { keyedTranslations, shown } from '../../testing/keyed-translations';
import { inboxItem } from '../../testing/reservation-fixtures';
import { InboxComponent } from './inbox.component';

const newest = inboxItem({ id: 'd-new', title: 'Newest notice', createdAt: '2026-10-03T00:00:00.000Z' });
const older = inboxItem({ id: 'd-old', title: 'Older notice', createdAt: '2026-10-01T00:00:00.000Z' });
const alreadyRead = inboxItem({ id: 'd-read', title: 'Read notice', status: 'READ', readAt: '2026-09-30T00:00:00.000Z', createdAt: '2026-09-29T00:00:00.000Z' });

function setup(page: object) {
  TestBed.configureTestingModule({
    imports: [InboxComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideTranslateService({ lang: 'es', fallbackLang: 'es' }),
      { provide: API_BASE_URL, useValue: '' },
    ],
  });
  TestBed.inject(TranslateService).setTranslation('es', keyedTranslations(['inbox.empty', 'inbox.loadMore', 'errors.UNKNOWN']));
  const fixture = TestBed.createComponent(InboxComponent);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/v1/notifications').flush(page);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, http, element: fixture.nativeElement as HTMLElement };
}

function titles(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll('.inbox-item-title')).map((node) => node.textContent?.trim() ?? '');
}

function unread(element: HTMLElement): string {
  return element.querySelector('.inbox-unread-count')?.textContent?.trim() ?? '';
}

describe('InboxComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it("lists the customer's own deliveries most recent first, as the API orders them", () => {
    const { element } = setup({ items: [newest, older, alreadyRead], nextCursor: null, unreadCount: 2 });

    expect(titles(element)).toEqual(['Newest notice', 'Older notice', 'Read notice']);
  });

  it('marks an unread delivery as read when it is opened', async () => {
    const { fixture, component, http, element } = setup({ items: [newest, older], nextCursor: null, unreadCount: 2 });

    const opened = component.open(newest);
    http.expectOne('/api/v1/notifications/d-new/read').flush({ ...newest, status: 'READ', readAt: '2026-10-05T00:00:00.000Z' });
    await opened;
    fixture.detectChanges();

    const item = element.querySelector('[data-delivery-id="d-new"]') as HTMLElement;
    expect(item.classList).not.toContain('inbox-item--unread');
    expect(item.querySelector('.inbox-item-body')?.textContent).toContain(newest.body);
  });

  it('lowers the unread counter when one is opened', async () => {
    const { fixture, component, http, element } = setup({ items: [newest, older], nextCursor: null, unreadCount: 5 });
    expect(unread(element)).toBe('5');

    const opened = component.open(older);
    http.expectOne('/api/v1/notifications/d-old/read').flush({});
    await opened;
    fixture.detectChanges();

    expect(unread(element)).toBe('4');
  });

  it('does not call the API, nor lower the counter, when an already read delivery is opened', async () => {
    const { fixture, component, http, element } = setup({ items: [alreadyRead], nextCursor: null, unreadCount: 0 });

    await component.open(alreadyRead);
    fixture.detectChanges();

    http.expectNone('/api/v1/notifications/d-read/read');
    expect(element.querySelector('.inbox-unread-count')).toBeNull();
  });

  it('loads the next page with the cursor and appends it', () => {
    const { fixture, component, http } = setup({ items: [newest], nextCursor: 'cursor-1', unreadCount: 2 });

    component.loadMore();
    http.expectOne('/api/v1/notifications?cursor=cursor-1').flush({ items: [older], nextCursor: null, unreadCount: 2 });
    fixture.detectChanges();

    expect(titles(fixture.nativeElement)).toEqual(['Newest notice', 'Older notice']);
    expect(fixture.nativeElement.textContent).not.toContain(shown('inbox.loadMore'));
  });

  it('shows the empty state for an empty inbox', () => {
    const { element } = setup({ items: [], nextCursor: null, unreadCount: 0 });

    expect(element.textContent).toContain(shown('inbox.empty'));
  });
});
