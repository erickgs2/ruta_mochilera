import { Component, Directive, effect, inject, Injector, input, type OnInit, TemplateRef, ViewContainerRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it } from 'vitest';

/**
 * Documents, with a runnable reproduction, the exact environment limitation
 * that `HasPermissionDirective` (`has-permission.directive.ts`) works around
 * by using a classic `@Input()` instead of a signal `input()`.
 *
 * Both tests below are expected to fail (`it.fails`) -- if either one starts
 * passing (e.g. after an Angular, vitest, or vite upgrade fixes the
 * underlying JIT compilation gap), `it.fails` itself fails, which is the
 * signal to come back and simplify `HasPermissionDirective` to use `input()`
 * again. Kept as a permanent regression check rather than a comment, since
 * an unverified claim in a comment is workspace lore future tasks would
 * otherwise take on faith.
 *
 * Root cause, as far as this reproduction narrows it down: `libs/auth-web`
 * has no ngtsc AOT compilation step (it runs on vitest via a generic
 * `@nx/vite` config, unlike `apps/admin`/`libs/ui`, which use
 * `jest-preset-angular`'s AOT-adjacent pipeline) -- see `src/test-setup.ts`.
 * Under Angular's runtime JIT compiler (`@angular/compiler`), a *structural*
 * directive's signal `input()` binding (`*fooBar="'x'"`, which desugars to a
 * property binding on the synthesized `<ng-template>`) never actually
 * reaches the signal: the browser console shows `NG0303: Can't bind to
 * 'fooBar'...`, and reading the input afterwards -- whether inside a
 * `constructor`-scoped `effect()` (throws `NG0950`, since a *required*
 * input is read before it is ever set) or an `ngOnInit`-scoped one with an
 * explicit `Injector` (silently keeps a *non-required* input's default
 * value forever, since the update that would change it never lands) --
 * observes only the initial state. A classic `@Input()` decorator, by
 * contrast, is assigned via plain property assignment rather than the
 * signal-input machinery, and is unaffected.
 */
describe('structural directive + signal input, JIT-mode limitation (see has-permission.directive.ts)', () => {
  it.fails('a required signal input throws NG0950 even when read from an ngOnInit-scoped effect with an explicit injector', async () => {
    @Directive({ selector: '[fooBar]', standalone: true })
    class RequiredInputDirective implements OnInit {
      readonly fooBar = input.required<string>();
      private readonly template = inject(TemplateRef<unknown>);
      private readonly container = inject(ViewContainerRef);
      private readonly injector = inject(Injector);

      ngOnInit(): void {
        effect(
          () => {
            this.container.clear();
            if (this.fooBar() === 'x') this.container.createEmbeddedView(this.template);
          },
          { injector: this.injector }
        );
      }
    }

    @Component({ standalone: true, imports: [RequiredInputDirective], template: `<span *fooBar="'x'">hi</span>` })
    class HostComponent {}

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it.fails('a non-required signal input never receives its bound value, even from an ngOnInit-scoped effect', async () => {
    @Directive({ selector: '[fooBar]', standalone: true })
    class OptionalInputDirective implements OnInit {
      readonly fooBar = input<string>('');
      private readonly template = inject(TemplateRef<unknown>);
      private readonly container = inject(ViewContainerRef);
      private readonly injector = inject(Injector);

      ngOnInit(): void {
        effect(
          () => {
            this.container.clear();
            if (this.fooBar() === 'x') this.container.createEmbeddedView(this.template);
          },
          { injector: this.injector }
        );
      }
    }

    @Component({ standalone: true, imports: [OptionalInputDirective], template: `<span *fooBar="'x'">hi</span>` })
    class HostComponent {}

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    // If the binding worked, this would read 'hi'; it stays '' instead.
    if (fixture.nativeElement.textContent !== 'hi') {
      throw new Error(`expected 'hi', got ${JSON.stringify(fixture.nativeElement.textContent)}`);
    }
  });
});
