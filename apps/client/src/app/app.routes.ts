import type { Routes } from '@angular/router';
import { authGuard } from '@rm/auth-web';

/**
 * The catalogue and every authentication screen are public: a visitor can
 * browse trips and create an account without a session. Everything else
 * sits behind `authGuard`.
 */
export const appRoutes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/catalogue/trip-list.component').then((m) => m.TripListComponent),
  },
  {
    path: 'trips/:slug',
    loadComponent: () => import('./features/catalogue/trip-detail.component').then((m) => m.TripDetailComponent),
  },
  {
    // Exactly the path the trip detail's reserve button links to.
    path: 'trips/:slug/reserve',
    canActivate: [authGuard],
    loadComponent: () => import('./features/reservations/reserve.component').then((m) => m.ReserveComponent),
  },
  {
    path: 'reservations',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/reservations/reservation-list.component').then((m) => m.ReservationListComponent),
  },
  {
    path: 'reservations/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/reservations/reservation-detail.component').then((m) => m.ReservationDetailComponent),
  },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'register',
    loadComponent: () => import('./features/auth/register.component').then((m) => m.RegisterComponent),
  },
  {
    path: 'verify-email',
    loadComponent: () => import('./features/auth/verify-email.component').then((m) => m.VerifyEmailComponent),
  },
  {
    path: 'forgot-password',
    loadComponent: () =>
      import('./features/auth/forgot-password.component').then((m) => m.ForgotPasswordComponent),
  },
  {
    // The path the password reset email links to: `${CLIENT_APP_URL}/reset-password?token=…`
    // (see `requestPasswordReset` in `@rm/domain-identity`).
    path: 'reset-password',
    loadComponent: () => import('./features/auth/reset-password.component').then((m) => m.ResetPasswordComponent),
  },
  {
    // The path a counter customer's invitation links to:
    // `${CLIENT_APP_URL}/invitation?token=…` (see `invitationEmailMessage` in `@rm/domain-identity`).
    path: 'invitation',
    loadComponent: () => import('./features/auth/invitation.component').then((m) => m.InvitationComponent),
  },
  {
    path: 'account',
    canActivate: [authGuard],
    loadComponent: () => import('./features/profile/profile.component').then((m) => m.ProfileComponent),
  },
  {
    path: 'reservations/:id/payments',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/payments/payment-history.component').then((m) => m.PaymentHistoryComponent),
  },
  {
    path: 'inbox',
    canActivate: [authGuard],
    loadComponent: () => import('./features/inbox/inbox.component').then((m) => m.InboxComponent),
  },
  { path: '**', redirectTo: '' },
];
