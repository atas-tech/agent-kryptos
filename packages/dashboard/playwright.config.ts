import { defineConfig, devices } from "@playwright/test";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./e2e",
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: "html",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: "http://localhost:5173",

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
    
    /* Take screenshot on failure */
    screenshot: "only-on-failure",
    
    /* Viewport size */
    viewport: { width: 1920, height: 1080 },
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: [
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      timeout: 120000,
      reuseExistingServer: true,
      cwd: "./",
      env: {
        VITE_SPS_API_URL: "http://localhost:3100"
      }
    },
    {
      command: "npm run dev",
      url: "http://localhost:3100/healthz",
      reuseExistingServer: true,
      cwd: "../sps-server",
      env: {
        DATABASE_URL: process.env.DATABASE_URL || "postgresql://kryptos:localdev@127.0.0.1:5433/agent_kryptos",
        REDIS_URL: "redis://127.0.0.1:6380",
        SPS_PG_INTEGRATION: "1",
        SPS_USER_JWT_SECRET: "test-user-jwt-secret",
        SPS_AGENT_JWT_SECRET: "test-agent-jwt-secret",
        SPS_HMAC_SECRET: "test-hmac",
        SPS_HOSTED_MODE: "1",
        SPS_HOST: "0.0.0.0",
        STRIPE_SECRET_KEY: "sk_test_dummy",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        SPS_AUTH_REGISTRATION_LIMIT: "100",
        SPS_AUTH_LOGIN_LIMIT: "100",
        SPS_MEMBER_LIMIT_FREE: "10",
        SPS_AGENT_LIMIT_FREE: "10",
        SPS_EXCHANGE_LIMIT_FREE: "100",
        PORT: "3100"
      }
    }
  ],
});
