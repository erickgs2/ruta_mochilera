import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleChange, MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { RbacApi, StaffApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { ConfirmDialogComponent, ErrorCodePipe } from '@rm/ui';
import { map } from 'rxjs';

type Staff = components['schemas']['Staff'];
type Role = components['schemas']['Role'];
type Locale = 'es' | 'en';

/** True when the response is the well-known duplicate-email rejection. */
function isEmailConflict(error: unknown): boolean {
  return error instanceof HttpErrorResponse && error.error?.code === 'EMAIL_ALREADY_REGISTERED';
}

/**
 * Cross-field validator: the two password controls must agree. Skipped once
 * the password control is disabled (edit mode never shows a password field
 * at all -- see the class doc comment), so it never blocks a save it has no
 * bearing on.
 */
function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password');
  const confirmPassword = group.get('confirmPassword');
  if (!password || !confirmPassword || password.disabled) return null;
  return password.value === confirmPassword.value ? null : { passwordMismatch: true };
}

/**
 * Create/edit screen for a staff (administrator) account.
 *
 * Create asks for email, full name, an optional employee code, language,
 * an initial password (with confirmation) and roles. Edit drops email and
 * password entirely -- email is the account's identity and the API does not
 * accept a change to it, and password reset is its own operation in a later
 * phase (see `updateStaff` in `@rm/domain-staff`) -- and adds the
 * enabled/disabled toggle instead.
 *
 * All fields live in one `FormGroup`; the ones a given mode does not use are
 * `.disable()`d rather than removed, which is what excludes them from
 * `form.invalid` and from `getRawValue()`'s use in `buildPayload()` below,
 * without fighting Angular's strict `FormGroup` typing over a shape that
 * differs by mode.
 *
 * There is no "get staff by id" endpoint, so, like `RoleFormComponent`, edit
 * mode fetches the full list and finds the matching account in it.
 *
 * `userId` is read from `ActivatedRoute.paramMap` reactively, not once from
 * `.snapshot`: Angular's default route-reuse strategy reuses this component
 * instance across two URLs matching the same parameterised route, so
 * navigating from `/staff/staff-1` straight to `/staff/staff-2` would
 * otherwise leave the first account's data (and id) sitting in the form. The
 * `effect()` below re-runs -- resetting the form first -- every time the id
 * actually changes; see `RoleFormComponent`'s doc comment for the general
 * hazard this closes.
 */
@Component({
  selector: 'rm-staff-form',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    TranslatePipe,
    ErrorCodePipe,
  ],
  templateUrl: './staff-form.component.html',
  styleUrl: './staff-form.component.scss',
  // `ErrorCodePipe` is a `@Pipe`, never `providedIn: 'root'`; listing it here
  // is what lets `inject(ErrorCodePipe)` below resolve it.
  providers: [ErrorCodePipe],
})
export class StaffFormComponent {
  private readonly staffApi = inject(StaffApi);
  private readonly rbac = inject(RbacApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);
  private readonly formBuilder = inject(FormBuilder);

  private readonly userId = toSignal(this.route.paramMap.pipe(map((params) => params.get('userId'))), {
    initialValue: this.route.snapshot.paramMap.get('userId'),
  });
  readonly isEdit = computed(() => this.userId() !== null);

  readonly saving = signal(false);
  readonly staff = signal<Staff | null>(null);
  readonly roles = signal<Role[]>([]);

  readonly form = this.formBuilder.nonNullable.group(
    {
      email: ['', [Validators.required, Validators.email]],
      fullName: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(120)]],
      employeeCode: ['', Validators.maxLength(40)],
      locale: ['es' as Locale, Validators.required],
      password: ['', [Validators.required, Validators.minLength(10)]],
      confirmPassword: ['', Validators.required],
      roleIds: [[] as string[]],
      status: ['ACTIVE' as 'ACTIVE' | 'DISABLED'],
    },
    { validators: [passwordsMatch] }
  );

  constructor() {
    this.rbac.listRoles().subscribe((roles) => this.roles.set(roles));

    effect(() => {
      const userId = this.userId();

      // Reset to a blank, fully-enabled shape first; the branches below then
      // only disable what this particular id's mode requires. Needed for
      // route reuse (see the class doc comment) and so a stale value --
      // or a leftover `conflict` error from a previous save -- can never
      // survive from one id into the next.
      this.staff.set(null);
      this.form.reset({
        email: '',
        fullName: '',
        employeeCode: '',
        locale: 'es',
        password: '',
        confirmPassword: '',
        roleIds: [],
        status: 'ACTIVE',
      });
      this.form.enable();

      if (!userId) {
        // `status` only exists for edit -- creation always starts ACTIVE.
        this.form.controls.status.disable();
        return;
      }

      // Email is the account's identity and password reset is a separate
      // operation (see the class doc comment): neither applies in edit mode.
      this.form.controls.email.disable();
      this.form.controls.password.disable();
      this.form.controls.confirmPassword.disable();

      this.staffApi.list().subscribe((staff) => {
        // The route may have already moved on to a different id by the time
        // this resolves; ignore a response for an id we've since left.
        if (this.userId() !== userId) return;

        const found = staff.find((candidate) => candidate.id === userId);
        if (!found) return;
        this.staff.set(found);
        this.form.patchValue({
          email: found.email,
          fullName: found.fullName,
          employeeCode: found.employeeCode ?? '',
          locale: found.locale,
          roleIds: found.roleIds,
          status: found.status,
        });
      });
    });
  }

  /** Intercepts the toggle so turning an account off warns about revoked sessions before it takes effect. */
  onStatusToggle(event: MatSlideToggleChange): void {
    if (event.checked) {
      this.form.controls.status.setValue('ACTIVE');
      return;
    }

    // Revert the visual toggle immediately; it is driven by `form.controls.status.value`
    // below, so it only actually flips once (and if) the user confirms.
    event.source.checked = true;

    const fullName = this.form.controls.fullName.value;
    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.translate.instant('staff.disableTitle'),
        message: this.translate.instant('staff.disableMessage', { name: fullName }),
      },
    });

    ref.afterClosed().subscribe((confirmed: boolean) => {
      if (confirmed) this.form.controls.status.setValue('DISABLED');
    });
  }

  save(): void {
    if (this.form.invalid || this.saving()) return;

    this.saving.set(true);
    const userId = this.userId();
    const request$ = userId ? this.staffApi.update(userId, this.buildUpdateBody()) : this.staffApi.create(this.buildCreateBody());

    request$.subscribe({
      next: () => {
        this.saving.set(false);
        void this.router.navigate(['/staff']);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        if (isEmailConflict(error)) {
          this.form.controls.email.setErrors({ ...this.form.controls.email.errors, conflict: true });
          return;
        }
        this.snackBar.open(this.errorCode.transform(error), undefined, { duration: 6000 });
      },
    });
  }

  /**
   * Trims `employeeCode` and, if the result is empty, leaves the key out of
   * the request body entirely (`undefined`, dropped by `JSON.stringify`)
   * rather than sending `""`. The API treats an absent value as "leave
   * unchanged", not "clear" -- there is no way to clear a previously-set
   * employee code through this endpoint (see the class doc comment and the
   * task report) -- so sending an empty string would instead overwrite it
   * with a literal empty string, which is worse than doing nothing.
   */
  private normalizedEmployeeCode(): string | undefined {
    const trimmed = this.form.getRawValue().employeeCode.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  private buildCreateBody() {
    const value = this.form.getRawValue();
    return {
      email: value.email,
      fullName: value.fullName,
      employeeCode: this.normalizedEmployeeCode(),
      locale: value.locale,
      password: value.password,
      roleIds: value.roleIds,
    };
  }

  private buildUpdateBody() {
    const value = this.form.getRawValue();
    return {
      fullName: value.fullName,
      employeeCode: this.normalizedEmployeeCode(),
      locale: value.locale,
      status: value.status,
      roleIds: value.roleIds,
    };
  }
}
