import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";

test.describe("Analytics Dashboard (Milestone 8)", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("Scenario 601: Analytics dashboard overview and metrics", async ({ page }) => {
    // 1. Setup workspace with target navigation to analytics
    await setupWorkspace(page, "analytics-601", "workspace_admin", [], "/analytics");
    
    // 2. Wait for the analytics hero components to appear
    await expect(page.getByTestId("analytics-title")).toBeVisible({ timeout: 30 * 1000 });

    // 3. Verify analytics-specific stats (always rendered in stats-row)
    await expect(page.getByTestId("analytics-active-agents")).toBeVisible({ timeout: 15 * 1000 });
    await expect(page.getByTestId("analytics-request-count-value")).toBeVisible();
    await expect(page.getByTestId("analytics-successful-exchanges")).toBeVisible();
    await expect(page.getByTestId("analytics-failed-exchanges")).toBeVisible();
  });
});
