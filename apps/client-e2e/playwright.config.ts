import { defineConfig, devices } from '@playwright/test';
import { API_URL, CLIENT_PORT, CLIENT_URL, e2eProcessEnv, WORKSPACE_ROOT } from './src/support/e2e-env';

/**
 * End-to-end coverage of the customer app against the real API and a real
 * PostgreSQL (Task 21). See `src/support/e2e-env.ts` for what makes a run
 * deterministic: its own database, its own ports, the fake payment provider.
 *
 * Both servers are started here. Locally an already-running pair on the
 * E2E ports is reused; on CI they are always fresh.
 */
export default defineConfig({
  testDir: './src',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: '../../dist/client-e2e-report' }]] : 'list',
  outputDir: '../../dist/client-e2e-results',
  use: {
    baseURL: CLIENT_URL,
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /reset\.setup\.ts/ },
    {
      name: 'chromium',
      testMatch: /\.e2e\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], browserName: 'chromium' },
    },
  ],
  webServer: [
    {
      // The project directory as an argument, not as `cwd`: `pnpm exec`
      // resolves from the workspace root whatever directory it starts in.
      command: `pnpm exec next dev apps/api --port ${new URL(API_URL).port}`,
      cwd: WORKSPACE_ROOT,
      env: e2eProcessEnv(),
      // No database involved: the schema is migrated by the setup project,
      // which only runs once this server answers.
      url: `${API_URL}/api/v1/openapi.json`,
      timeout: 240_000,
      reuseExistingServer: !process.env['CI'],
    },
    {
      command: `pnpm exec nx serve client --port=${CLIENT_PORT} --proxyConfig=apps/client-e2e/proxy.e2e.json`,
      cwd: WORKSPACE_ROOT,
      env: e2eProcessEnv(),
      url: CLIENT_URL,
      timeout: 240_000,
      reuseExistingServer: !process.env['CI'],
    },
  ],
});
