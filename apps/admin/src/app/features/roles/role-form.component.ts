import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { RbacApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { ErrorCodePipe } from '@rm/ui';
import { map } from 'rxjs';

type Permission = components['schemas']['Permission'];
type Role = components['schemas']['Role'];

export interface PermissionGroup {
  category: string;
  permissions: Permission[];
}

/** True when the CONFLICT response names `name` as the offending field. */
function isNameConflict(error: unknown): boolean {
  return (
    error instanceof HttpErrorResponse &&
    error.error?.code === 'CONFLICT' &&
    error.error?.details?.field === 'name'
  );
}

/**
 * Create/edit screen for a role: name, description, and the full permission
 * catalog grouped by category with a checkbox per permission.
 *
 * There is no "get role by id" endpoint (see `@rm/api-client`'s `RbacApi`) --
 * the list screen already has every role in memory, but a direct navigation
 * to `/roles/:roleId` (a bookmark, a page refresh) does not. So edit mode
 * re-fetches the full list and picks the matching entry out of it, same as
 * `StaffFormComponent` does for staff.
 *
 * `roleId` is read from `ActivatedRoute.paramMap` reactively, not once from
 * `.snapshot`: Angular's default route-reuse strategy reuses this component
 * instance across two URLs that match the same parameterised route, so a
 * navigation from `/roles/role-1` straight to `/roles/role-2` would
 * otherwise leave the first role's data (and id) sitting in the form,
 * letting a save silently target the wrong role. The `effect()` below
 * re-runs -- resetting the form first -- every time the id actually changes.
 */
@Component({
  selector: 'rm-role-form',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
    ErrorCodePipe,
  ],
  templateUrl: './role-form.component.html',
  styleUrl: './role-form.component.scss',
  // `ErrorCodePipe` is not `providedIn: 'root'` (a `@Pipe` never is), so it
  // must be listed here for `inject(ErrorCodePipe)` below to resolve it --
  // the same pipe used from the template for the inline `mat-error`.
  providers: [ErrorCodePipe],
})
export class RoleFormComponent {
  private readonly rbac = inject(RbacApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly formBuilder = inject(FormBuilder);

  private readonly roleId = toSignal(this.route.paramMap.pipe(map((params) => params.get('roleId'))), {
    initialValue: this.route.snapshot.paramMap.get('roleId'),
  });
  readonly isEdit = computed(() => this.roleId() !== null);

  readonly saving = signal(false);
  readonly role = signal<Role | null>(null);
  readonly permissions = signal<Permission[]>([]);
  readonly selectedPermissions = signal<string[]>([]);

  /** A system role (Super Admin) can never be edited or deleted -- see `SYSTEM_ROLE_IMMUTABLE`. */
  readonly readOnly = computed(() => this.role()?.isSystem ?? false);

  readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    description: ['', Validators.maxLength(240)],
  });

  readonly groupedPermissions = computed<PermissionGroup[]>(() => {
    const byCategory = new Map<string, Permission[]>();
    for (const permission of this.permissions()) {
      const list = byCategory.get(permission.category) ?? [];
      list.push(permission);
      byCategory.set(permission.category, list);
    }
    return [...byCategory.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, list]) => ({
        category,
        permissions: [...list].sort((a, b) => a.key.localeCompare(b.key)),
      }));
  });

  constructor() {
    this.rbac.listPermissions().subscribe((permissions) => this.permissions.set(permissions));

    effect(() => {
      const roleId = this.roleId();

      // Reset first, unconditionally: this effect re-runs whenever the route
      // param changes on the *same* component instance (route reuse), so a
      // stale role's name/description/permissions/isSystem must not survive
      // into the next id's form -- see the class doc comment.
      this.role.set(null);
      this.selectedPermissions.set([]);
      this.form.enable();
      this.form.reset({ name: '', description: '' });

      if (!roleId) return;

      this.rbac.listRoles().subscribe((roles) => {
        // The route may have already moved on to a different id by the time
        // this resolves; a response for an id we've since navigated away
        // from must not overwrite what the (possibly still-loading) new id
        // put in the form.
        if (this.roleId() !== roleId) return;

        const found = roles.find((candidate) => candidate.id === roleId);
        if (!found) return;
        this.role.set(found);
        this.selectedPermissions.set([...found.permissionKeys]);
        this.form.patchValue({ name: found.name, description: found.description });
        if (found.isSystem) this.form.disable();
      });
    });
  }

  /**
   * The backend never sends prose meant to be shown to a person (see
   * `ErrorCodePipe`'s doc comment for the same rule applied to error codes):
   * `Permission.category` and `Permission.description` from
   * `GET /rbac/permissions` are stable, English, developer-facing labels
   * (see `PERMISSIONS` in `@rm/domain-rbac`), not presentation. These three
   * helpers turn a permission key/category into a translation key instead --
   * e.g. `trip.budget.view` becomes `permissions.trip.budget.view.label` --
   * resolved against the `permissions.*` tree in `es.json`/`en.json`, which
   * mirrors every key in `PERMISSIONS` by hand (see the task report for how
   * completeness was checked).
   */
  categoryTranslationKey(category: string): string {
    return `permissions.categories.${category}`;
  }

  permissionLabelKey(key: string): string {
    return `permissions.${key}.label`;
  }

  permissionDescriptionKey(key: string): string {
    return `permissions.${key}.description`;
  }

  isChecked(key: string): boolean {
    return this.selectedPermissions().includes(key);
  }

  togglePermission(key: string, checked: boolean): void {
    this.selectedPermissions.update((keys) =>
      checked ? [...new Set([...keys, key])] : keys.filter((existing) => existing !== key)
    );
  }

  save(): void {
    if (this.form.invalid || this.saving() || this.readOnly()) return;

    this.saving.set(true);
    const { name, description } = this.form.getRawValue();
    const body = { name, description, permissionKeys: this.selectedPermissions() };
    const roleId = this.roleId();
    const request$ = roleId ? this.rbac.updateRole(roleId, body) : this.rbac.createRole(body);

    request$.subscribe({
      next: () => {
        this.saving.set(false);
        void this.router.navigate(['/roles']);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        if (isNameConflict(error)) {
          this.form.controls.name.setErrors({ ...this.form.controls.name.errors, conflict: true });
          return;
        }
        this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
      },
    });
  }
}
