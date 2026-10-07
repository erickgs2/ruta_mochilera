import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Deliberately no `server.url`: Apple rejects a container that just wraps a
 * remote URL under App Store Review Guideline 4.2 ("Minimum Functionality"),
 * and a server outage would leave the app blank with nothing of its own to
 * show. `webDir` points at the Angular production build's browser output
 * (`nx build client`), which `cap sync` copies into each native project so
 * the app ships its own bundled assets.
 *
 * This is also the file Task 15 exists to ask one question about: once the
 * WebView loads this bundle from `capacitor://localhost` (iOS default) or
 * `https://localhost` (Android default -- `server.androidScheme`, left
 * unset here), it is a different origin than the API. See
 * `.superpowers/sdd/2026-10-03-fase-2a-reservas-y-pagos/task-15-report.md`
 * for what that does to the httpOnly refresh cookie `apps/admin` and this
 * app share (`apps/api/src/lib/http/refresh-cookie.ts`) -- the investigation
 * this config exists to trigger, not a working mobile session model.
 */
const config: CapacitorConfig = {
  appId: 'app.rutamochilera.client',
  appName: 'Ruta Mochilera',
  // Relative to this file, not to the repo root: Nx (like every app in this
  // workspace) always builds into `<repo root>/dist/apps/<name>`, two levels
  // above `apps/client`.
  webDir: '../../dist/apps/client/browser',
};

export default config;
