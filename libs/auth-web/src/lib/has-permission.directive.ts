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
 * signal `input()` -- including `input.required()`. Both were tried and
 * both fail: `libs/auth-web/src/lib/structural-directive-signal-input.repro.spec.ts`
 * is a runnable reproduction showing that a signal input on a *structural*
 * directive is never actually wired up by the template compiler under this
 * workspace's JIT (non-AOT) test pipeline, regardless of whether the input
 * is required or optional, or whether the code that reads it runs in the
 * constructor or in `ngOnInit`. A classic `@Input()` does not have that
 * problem, and Angular guarantees it is assigned before `ngOnInit` runs.
 * The `effect()` that reacts to permission changes is therefore created in
 * `ngOnInit` (with an explicit `injector`, since `ngOnInit` is not itself an
 * injection context) so its first run always sees the real bound value.
 *
 * Losing `input.required()` also loses its compile-time and runtime
 * "you forgot to bind this" safety net, so `ngOnInit` re-creates the loud
 * half of that contract by hand: an unbound (empty-string) permission
 * throws immediately, rather than silently rendering nothing forever.
 */
@Directive({ selector: '[rmHasPermission]', standalone: true })
export class HasPermissionDirective implements OnInit {
  @Input() rmHasPermission = '';

  private readonly auth = inject(AuthService);
  private readonly template = inject(TemplateRef<unknown>);
  private readonly container = inject(ViewContainerRef);
  private readonly injector = inject(Injector);

  ngOnInit(): void {
    if (!this.rmHasPermission) {
      throw new Error(
        '[rmHasPermission] requires a permission key, e.g. *rmHasPermission="\'trip.view\'" -- got an empty value.'
      );
    }

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
