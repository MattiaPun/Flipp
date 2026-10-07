// Browser end-to-end tests. Starts a throwaway server with its own data directory.
import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `flipp-e2e-${Date.now()}`);
const port = 3990;

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning server/index.js',
    url: `http://localhost:${port}/api/auth/me`,
    env: { PORT: String(port), DATA_DIR: dataDir, SETUP_TOKEN: 'e2e-token', JWT_SECRET: 'e2e-secret' },
    reuseExistingServer: false,
  },
});
