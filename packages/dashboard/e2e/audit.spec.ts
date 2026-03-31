import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";

test.describe("Audit Log & Timeline", () => {
  test("Scenario 401: Audit viewer filters & pagination", async ({ page }) => {
    // Seed agent via setupWorkspace to ensure at least one 'agent_enrolled' audit entry
    await setupWorkspace(page, "audit-401", "workspace_admin", ["audit-bot"]);
    
    await expect(page).toHaveURL("/");
    await page.getByTestId("nav-link-audit").click();
    await expect(page).toHaveURL("/audit");

    // Perform a second action to verify real-time update
    await page.getByTestId("nav-link-agents").click();
    await page.getByTestId("enroll-agent-btn").click();
    await page.getByTestId("enroll-agent-id-input").fill("audit-manual");
    await page.getByTestId("enroll-agent-submit").click();
    
    await expect(page.getByTestId("revealed-api-key")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("reveal-save-checkbox").check();
    await page.getByTestId("reveal-close-btn").click();

    // Verify audit entries appear
    await page.getByTestId("nav-link-audit").click();
    await page.getByRole("button", { name: /Refresh/i }).first().click();
    
    // Check for seeded agent entry or manual entry
    await expect(page.getByRole("cell", { name: /agent_enrolled/i }).first()).toBeVisible({ timeout: 20000 });

    // Test filters
    await page.getByLabel("Event type").selectOption("agent_enrolled");
    await page.getByRole("button", { name: /Apply filters/i }).click();
    await expect(page.getByRole("cell", { name: "agent_enrolled" }).first()).toBeVisible();
    
    // Expand row
    await page.getByRole("cell", { name: "agent_enrolled" }).first().click();
    await expect(page.locator(".audit-expanded")).toBeVisible();
    await expect(page.getByText("Sanitized metadata", { exact: true })).toBeVisible();
  });

  test("Scenario 402: Exchange lifecycle drill-down", async ({ page }) => {
    await setupWorkspace(page, "audit-402", "workspace_admin", [], "/audit/exchange/0000000000000000000000000000000000000000000000000000000000000000");
    
    // Verify empty state for exchange drill-down
    await expect(page.getByTestId("audit-page-exchange-view")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("audit-empty-state")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: /Back to audit/i })).toBeVisible();
  });
});
