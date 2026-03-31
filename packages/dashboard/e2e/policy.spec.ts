import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";

test.describe("Workspace Policy", () => {
  test("Scenario 401: Viewer Read-Only Policy", async ({ page }) => {
    await setupWorkspace(page, "policy-401", "workspace_viewer", [], "/policy");
    
    // Save should not be visible for viewers
    await expect(page.getByTestId("save-policy-btn")).not.toBeVisible();
    
    // Verify inputs are disabled
    const inputs = page.locator("input.policy-input");
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      await expect(inputs.nth(i)).toBeDisabled();
    }
  });

  test("Scenario 403: Validation Errors", async ({ page }) => {
    await setupWorkspace(page, "policy-403", "workspace_admin", [], "/policy");
    
    // Wait for the existing rule to be visible before adding a new one
    await page.getByTestId("policy-rule-card").first().waitFor({ state: "visible", timeout: 15000 });

    // Test duplicate rule ID validation
    await page.getByTestId("add-rule-btn").click();
    const ruleIds = page.getByTestId("rule-id-input");
    await expect(ruleIds).toHaveCount(2, { timeout: 10000 });
    
    await ruleIds.nth(0).fill("duplicate-id");
    await ruleIds.nth(1).fill("duplicate-id");

    // Add a secret name to Rule 2 so we don't hit the "missing secret name" error instead
    const secretNames = page.getByTestId("rule-secret-input");
    await secretNames.nth(1).fill("stripe.dummy.key");

    await Promise.all([
      page.waitForResponse(
        resp => resp.url().includes("/api/v2/workspace/policy/validate") && resp.request().method() === "POST"
      ),
      page.getByTestId("validate-policy-btn").click()
    ]);

    // Validation should report issues
    await expect(page.getByTestId("policy-status-message")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("policy-status-message")).toContainText("returned issues", { ignoreCase: true });

    const issueList = page.getByTestId("policy-issue-list");
    await expect(issueList).toBeVisible({ timeout: 15000 });
    
    // Wait for the specific error message to appear in the issues list
    const issueMessage = page.getByTestId("policy-issue-message").filter({ hasText: /unique/i });
    await expect(issueMessage).toBeVisible({ timeout: 10000 });

    // Save should be blocked
    await expect(page.getByTestId("save-policy-btn")).toBeDisabled();
  });
});
