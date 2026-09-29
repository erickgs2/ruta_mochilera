import type { Routes } from '@angular/router';
import { permissionGuard } from '@rm/auth-web';

/**
 * The parent `trips` route (in `app.routes.ts`) already gates entry on
 * `trip.view`. Creating and editing require `trip.create`/`trip.update`
 * here, and the costing screen requires `trip.budget.view` -- mirroring the
 * gating `roles.routes.ts` and `staff.routes.ts` already established.
 *
 * `:tripId/images` and `:tripId/costing` are separate routes rather than
 * tabs inside the edit form: each is its own screen with its own API calls
 * (`TripsApi`'s image endpoints, `CostingApi`), and giving each a URL lets an
 * administrator bookmark or share a direct link to a trip's costing sheet.
 */
export const tripsRoutes: Routes = [
  { path: '', loadComponent: () => import('./trips-list.component').then((m) => m.TripsListComponent) },
  {
    path: 'new',
    canActivate: [permissionGuard('trip.create')],
    loadComponent: () => import('./trip-form.component').then((m) => m.TripFormComponent),
  },
  {
    path: ':tripId',
    canActivate: [permissionGuard('trip.update')],
    loadComponent: () => import('./trip-form.component').then((m) => m.TripFormComponent),
  },
  {
    path: ':tripId/images',
    canActivate: [permissionGuard('trip.update')],
    loadComponent: () => import('./trip-images.component').then((m) => m.TripImagesComponent),
  },
  {
    path: ':tripId/costing',
    canActivate: [permissionGuard('trip.budget.view')],
    loadComponent: () => import('./trip-costing.component').then((m) => m.TripCostingComponent),
  },
];
