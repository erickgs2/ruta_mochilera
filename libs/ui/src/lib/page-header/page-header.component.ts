import { Component, input } from '@angular/core';

/**
 * A screen's title bar: a heading plus a right-aligned actions slot (e.g. a
 * "New role" button). List screens across the panel (roles, staff, and
 * whatever Task 18 adds for trips) use this instead of hand-rolling their
 * own header markup, so the phone-width behaviour -- the actions wrap below
 * the title instead of overflowing or shrinking it -- only has to be solved
 * once.
 */
@Component({
  selector: 'rm-page-header',
  standalone: true,
  template: `
    <header class="rm-page-header">
      <h1 class="rm-page-header__title">{{ title() }}</h1>
      <div class="rm-page-header__actions">
        <ng-content></ng-content>
      </div>
    </header>
  `,
  styles: `
    .rm-page-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin: 0.5rem 0 1.25rem;
    }

    .rm-page-header__title {
      margin: 0;
      font-size: 1.625rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.15;
    }

    .rm-page-header__actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
  `,
})
export class PageHeaderComponent {
  /** Already-translated heading text, e.g. `{{ 'roles.title' | translate }}` from the caller's template. */
  readonly title = input.required<string>();
}
