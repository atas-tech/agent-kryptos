import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";
import type { Pool } from "pg";

test.describe("Billing & Quotas (Milestone 5)", () => {

  test("Scenario 504: Admin home shows live quota summary", async ({ page }) => {
    // 1. Setup workspace with target navigation to root (Home)
    await setupWorkspace(page, "billing-504", "workspace_admin", [], "/");
    
    // 2. Wait for the metrics to appear via stable test IDs
    await expect(page.getByTestId("nav-link-billing")).toBeVisible({ timeout: 15000 });
    
    // 3. Find the Secret Requests metric via the summary-card-value
    // In Dashboard.tsx, the 4th card (index 3) is Secret Requests.
    // Or we can find by the card title text if i18n is loaded, but test-id is safer.
    const secretRequestMetric = page.getByTestId("summary-card-value").nth(3);
    await expect(secretRequestMetric).toBeVisible({ timeout: 15000 });
    await expect(secretRequestMetric).toHaveText("0/10");
  });

  test("Scenario 501: Free-tier admin starts checkout", async ({ page }) => {
    await setupWorkspace(page, "billing-501", "workspace_admin", [], "/billing");
    await expect(page.getByTestId("subscription-tier-badge").filter({ hasText: /free/i }).first()).toBeVisible({ timeout: 15000 });
    const upgradeButton = page.getByTestId("billing-upgrade-btn");
    await expect( upgradeButton).toBeVisible();
    await expect(upgradeButton).toBeEnabled();
  });

  test("Scenario 502: Standard-tier admin opens billing portal", async ({ page, db }) => {
    const { workspaceId } = await setupWorkspace(page, "billing-502", "workspace_admin", [], "/billing");
    
    await db.query(`
      UPDATE workspaces 
      SET tier = 'standard', billing_provider = 'stripe', subscription_status = 'active'
      WHERE id = $1
    `, [workspaceId]);
    
    await page.reload();
    await expect(page.getByTestId("subscription-tier-badge").first()).toHaveText(/standard/i, { timeout: 15000 });
    const portalButton = page.getByTestId("billing-portal-btn");
    await expect(portalButton).toBeVisible();
    await expect(portalButton).toBeEnabled();
  });

  test("Scenario 505: Non-admins do not land on the home summary", async ({ page }) => {
    await setupWorkspace(page, "billing-505", "workspace_operator");
    await expect(page).toHaveURL(/.*\/agents/, { timeout: 15000 });
    await page.goto("http://127.0.0.1:5173/");
    await expect(page).toHaveURL(/.*\/agents/);
  });
});
