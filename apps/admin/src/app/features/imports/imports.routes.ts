import type { Routes } from '@angular/router';

/** The parent `imports` route (in `app.routes.ts`) gates entry on `import.manage`, the only permission both screens use. */
export const importsRoutes: Routes = [
  {
    path: '',
    loadComponent: () => import('./imports-list.component').then((m) => m.ImportsListComponent),
  },
  {
    path: ':batchId',
    loadComponent: () => import('./import-batch.component').then((m) => m.ImportBatchComponent),
  },
];
