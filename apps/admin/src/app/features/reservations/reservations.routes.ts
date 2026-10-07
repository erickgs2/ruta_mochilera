import type { Routes } from '@angular/router';

/**
 * The parent `reservations` route (in `app.routes.ts`) gates entry on
 * `reservation.view`, which is all both screens need to open. Cancelling and
 * the payment history are gated inside the detail screen on their own
 * permissions -- and, like everything here, again by the API.
 */
export const reservationsRoutes: Routes = [
  {
    path: '',
    loadComponent: () => import('./reservation-list.component').then((m) => m.ReservationListComponent),
  },
  {
    path: ':reservationId',
    loadComponent: () => import('./reservation-detail.component').then((m) => m.ReservationDetailComponent),
  },
];
