import { defineConfig } from '@playwright/test'

/**
 * Visual checks for the component gallery only.
 *
 * Baselines live in `tests/` and belong to this project; nothing is compared
 * against screenshots of any other app. The renderer is served without
 * Electron, which is why the gallery must boot with no `window.api`.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5183',
    // Uses the installed Google Chrome instead of downloading a browser.
    channel: 'chrome',
    viewport: { width: 1280, height: 2400 },
    deviceScaleFactor: 1,
    trace: 'off',
  },
  webServer: {
    command: 'pnpm exec electron-vite dev --rendererOnly',
    url: 'http://127.0.0.1:5183',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
