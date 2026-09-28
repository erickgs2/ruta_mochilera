import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api',
  plugins: [react()],
  test: {
    name: 'api',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: [
      '{src,app,pages,specs}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    ],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/api',
      provider: 'v8' as const,
    },
  },
}));
