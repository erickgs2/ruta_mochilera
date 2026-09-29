import {
  Directive,
  effect,
  inject,
  Injector,
  Input,
  type OnInit,
  TemplateRef,
  ViewContainerRef,
} from '@angular/core';
import { AuthService } from './auth.service';

/**
 * Structural directive: `*rmHasPermission="'trip.create'"` renders its
 * template only when the current user holds that permission.
 *
 * This is a visual convenience only, not a security boundary: the API
 * independently enforces the same permission on every request the hidden
 * UI would otherwise trigger. Hiding a button here saves the user a
 * round-trip to a screen or action that would fail server-side anyway; it
 * does not, by itself, protect anything.
 *
 * Implementation note: `rmHasPermission` is a classic `@Input()`, not a
 * signal `input()`. In this workspace's JIT (non-AOT) test/build pipeline, a
 * signal input on a *structural* directive is not reliably wired up by the
 * template compiler -- the bound value silently never reaches the signal.
 * A plain `@Input()` does not have that problem, and Angular guarantees it
 * is set before `ngOnInit`. The `effect()` that reacts to permission
 * changes is therefore created in `ngOnInit` (with an explicit `injector`,
 * since `ngOnInit` is not itself an injection context) rather than in the
 * constructor, so its first run always sees the real bound value.
 */
@Directive({ selector: '[rmHasPermission]', standalone: true })
export class HasPermissionDirective implements OnInit {
  @Input() rmHasPermission = '';

  private readonly auth = inject(AuthService);
  private readonly template = inject(TemplateRef<unknown>);
  private readonly container = inject(ViewContainerRef);
  private readonly injector = inject(Injector);

  ngOnInit(): void {
    effect(
      () => {
        const allowed = this.auth.hasPermission(this.rmHasPermission);
        this.container.clear();
        if (allowed) this.container.createEmbeddedView(this.template);
      },
      { injector: this.injector }
    );
  }
}
