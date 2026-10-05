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
    path: 'account',
    canActivate: [authGuard],
    loadComponent: () => import('./features/home/home.component').then((m) => m.HomeComponent),
  },
  { path: '**', redirectTo: '' },
];
