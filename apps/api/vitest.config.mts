import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api',
  plugins: [react(), nxViteTsPaths()],
  test: {
    name: 'api',
    watch: false,
    globals: true,
    // `apps/api` serves Next.js Route Handlers only, never React components,
    // so it needs Node's real globals rather than jsdom's. This matters
    // beyond style: jsdom's realm ships its own `Uint8Array`/`TextEncoder`
    // constructors, and jose's `instanceof Uint8Array` check against a key
    // built from jsdom's `TextEncoder` fails cross-realm even though the
    // value is a `Uint8Array` in every practical sense -- it broke
    // `signAccessToken` in the auth integration suite until this was fixed.
    environment: 'node',
    include: [
      '{src,app,pages,specs}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    ],
    setupFiles: ['./src/test-setup.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/api',
      provider: 'v8' as const,
    },
  },
}));
