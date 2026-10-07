import type { Routes } from '@angular/router';
import { authGuard, permissionGuard } from '@rm/auth-web';

export const appRoutes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.component').then((m) => m.LoginComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell.component').then((m) => m.ShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'trips' },
      {
        path: 'trips',
        canActivate: [permissionGuard('trip.view')],
        loadChildren: () => import('./features/trips/trips.routes').then((m) => m.tripsRoutes),
      },
      {
        path: 'reservations',
        canActivate: [permissionGuard('reservation.view')],
        loadChildren: () => import('./features/reservations/reservations.routes').then((m) => m.reservationsRoutes),
      },
      {
        path: 'customers',
        canActivate: [permissionGuard('customer.view')],
        loadChildren: () => import('./features/customers/customers.routes').then((m) => m.customersRoutes),
      },
      {
        path: 'imports',
        canActivate: [permissionGuard('import.manage')],
        loadChildren: () => import('./features/imports/imports.routes').then((m) => m.importsRoutes),
      },
      {
        path: 'settings/organization',
        canActivate: [permissionGuard('settings.manage')],
        loadComponent: () =>
          import('./features/settings/organization-settings.component').then((m) => m.OrganizationSettingsComponent),
      },
      {
        path: 'staff',
        canActivate: [permissionGuard('staff.view')],
        loadChildren: () => import('./features/staff/staff.routes').then((m) => m.staffRoutes),
      },
      {
        path: 'roles',
        canActivate: [permissionGuard('role.view')],
        loadChildren: () => import('./features/roles/roles.routes').then((m) => m.rolesRoutes),
      },
      {
        path: 'forbidden',
        loadComponent: () => import('./layout/forbidden.component').then((m) => m.ForbiddenComponent),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
