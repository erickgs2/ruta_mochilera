import type { Routes } from '@angular/router';
import { permissionGuard } from '@rm/auth-web';

/**
 * The parent `roles` route (in `app.routes.ts`) already gates entry on
 * `role.view`. Creating and editing additionally require `role.manage` here,
 * so a `role.view`-only user who lands on the list cannot reach the form by
 * typing the URL directly -- the list itself also hides the affordance, but
 * that is convenience only (see `HasPermissionDirective`), not the boundary.
 */
export const rolesRoutes: Routes = [
  { path: '', loadComponent: () => import('./roles-list.component').then((m) => m.RolesListComponent) },
  {
    path: 'new',
    canActivate: [permissionGuard('role.manage')],
    loadComponent: () => import('./role-form.component').then((m) => m.RoleFormComponent),
  },
  {
    path: ':roleId',
    canActivate: [permissionGuard('role.manage')],
    loadComponent: () => import('./role-form.component').then((m) => m.RoleFormComponent),
  },
];
