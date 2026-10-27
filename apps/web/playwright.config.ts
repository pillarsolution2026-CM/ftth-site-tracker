import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 3100;
const API_PORT = 3101;
// Chromium is preinstalled (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers); never run `playwright install`.
const executablePath = process.env.E2E_CHROMIUM_PATH;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: [
    {
      command: 'node e2e/mock-api.ts',
      env: { MOCK_API_PORT: String(API_PORT) },
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // Requires `pnpm build` first (the `build` task precedes `test:e2e` in CI).
      command: `pnpm exec next start -p ${WEB_PORT}`,
      env: { API_URL: `http://127.0.0.1:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}/ar/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
