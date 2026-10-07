import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { NotificationsApi, type components } from '@rm/api-client';
import { ErrorCodePipe } from '../../shared/error-code.pipe';

type InboxItem = components['schemas']['InboxPage']['items'][number];

/**
 * `/inbox`, behind the session guard: the customer's own notices, most recent
 * first in the order the API pages them. Opening an unread notice shows its
 * body and marks it read; the unread counter is the server's `unreadCount`
 * (over every page, not just the loaded ones), lowered by one locally after
 * each successful mark so the screen does not need a full reload.
 *
 * Titles and bodies are the text frozen when the notice was sent (see
 * `docs/business-rules/notifications.md`), not error codes.
 */
@Component({
  selector: 'rm-inbox',
  imports: [DatePipe, RouterLink, TranslatePipe, ErrorCodePipe],
  templateUrl: './inbox.component.html',
  styleUrl: './inbox.component.scss',
})
export class InboxComponent {
  private readonly api = inject(NotificationsApi);

  readonly items = signal<InboxItem[]>([]);
  readonly unreadCount = signal(0);
  readonly nextCursor = signal<string | null>(null);
  readonly loading = signal(true);
  readonly error = signal<unknown>(null);
  readonly openedId = signal<string | null>(null);

  constructor() {
    this.fetch();
  }

  loadMore(): void {
    const cursor = this.nextCursor();
    if (cursor) this.fetch(cursor);
  }

  async open(item: InboxItem): Promise<void> {
    this.openedId.set(this.openedId() === item.id ? null : item.id);
    if (item.readAt !== null) return;
    try {
      await firstValueFrom(this.api.markRead(item.id));
      const readAt = new Date().toISOString();
      this.items.update((items) =>
        items.map((candidate) => (candidate.id === item.id ? { ...candidate, status: 'READ', readAt } : candidate))
      );
      this.unreadCount.update((count) => Math.max(0, count - 1));
    } catch (error) {
      this.error.set(error);
    }
  }

  private fetch(cursor?: string): void {
    this.loading.set(true);
    this.api.list(cursor).subscribe({
      next: (page) => {
        this.items.update((items) => (cursor ? [...items, ...page.items] : page.items));
        this.nextCursor.set(page.nextCursor);
        this.unreadCount.set(page.unreadCount);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.error.set(error);
        this.loading.set(false);
      },
    });
  }
}
