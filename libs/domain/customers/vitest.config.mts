import { defineConfig } from 'vitest/config';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/libs/domain/customers',
  plugins: [nxViteTsPaths(), nxCopyAssetsPlugin(['*.md'])],
  test: {
    name: 'customers',
    watch: false,
    globals: true,
    environment: 'node',
    // Integration suites on a real PostgreSQL, tested alongside other projects
    // (and other checkouts) on one machine: Vitest's 5s default turns a busy
    // moment into a spurious timeout.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/libs/domain/customers',
      provider: 'v8' as const,
    },
  },
}));
