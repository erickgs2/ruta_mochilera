import type { Routes } from '@angular/router';
import { permissionGuard } from '@rm/auth-web';

/**
 * The parent `customers` route (in `app.routes.ts`) gates entry on
 * `customer.view`. Registering a customer also needs `customer.manage`; every
 * action inside the detail screen is gated on its own permission -- and, like
 * everything here, again by the API.
 */
export const customersRoutes: Routes = [
  {
    path: '',
    loadComponent: () => import('./customer-list.component').then((m) => m.CustomerListComponent),
  },
  {
    path: 'new',
    canActivate: [permissionGuard('customer.manage')],
    loadComponent: () => import('./customer-form.component').then((m) => m.CustomerFormComponent),
  },
  {
    path: ':customerId',
    loadComponent: () => import('./customer-detail.component').then((m) => m.CustomerDetailComponent),
  },
];
