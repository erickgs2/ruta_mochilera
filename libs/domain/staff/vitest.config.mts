import { defineConfig } from 'vitest/config';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/domain/staff',
  plugins: [nxViteTsPaths(), nxCopyAssetsPlugin(['*.md'])],
  test: {
    name: 'staff',
    watch: false,
    globals: true,
    environment: 'node',
    // Integration suites on a real PostgreSQL, tested alongside other projects
    // (and other checkouts) on one machine: Vitest's 5s/10s defaults turn a busy
    // moment, or the first run's schema migration, into a spurious timeout.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/libs/domain/staff',
      provider: 'v8' as const,
    },
  },
}));
