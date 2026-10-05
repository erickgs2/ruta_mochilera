import type { Routes } from '@angular/router';
import { authGuard } from '@rm/auth-web';

/**
 * Deliberately small: this task (Task 15) only needs to answer whether the
 * session survives a reload in the browser and inside Capacitor. The real
 * screens (catalog, trip detail, reservation, payment -- see the spec's §8)
 * land in later tasks once that question is settled.
 */
export const appRoutes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'register',
    loadComponent: () => import('./features/auth/register.component').then((m) => m.RegisterComponent),
  },
  {
    path: '',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./features/home/home.component').then((m) => m.HomeComponent),
  },
  { path: '**', redirectTo: '' },
];
