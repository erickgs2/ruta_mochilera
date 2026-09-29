import type { Routes } from '@angular/router';
import { permissionGuard } from '@rm/auth-web';

/**
 * The parent `staff` route (in `app.routes.ts`) already gates entry on
 * `staff.view`. Creating and editing additionally require `staff.manage`
 * here, mirroring `roles.routes.ts`.
 */
export const staffRoutes: Routes = [
  { path: '', loadComponent: () => import('./staff-list.component').then((m) => m.StaffListComponent) },
  {
    path: 'new',
    canActivate: [permissionGuard('staff.manage')],
    loadComponent: () => import('./staff-form.component').then((m) => m.StaffFormComponent),
  },
  {
    path: ':userId',
    canActivate: [permissionGuard('staff.manage')],
    loadComponent: () => import('./staff-form.component').then((m) => m.StaffFormComponent),
  },
];
