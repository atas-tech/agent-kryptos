import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";

test.describe("Management & Enrollment", () => {

  test("Scenario 301: Enroll Agent Flow (Admin)", async ({ page }) => {
    // Start at root path
    await setupWorkspace(page, "mgmt-301");
    
    await page.getByTestId("nav-link-agents").click();
    await expect(page).toHaveURL("/agents", { timeout: 10000 });

    await page.getByTestId("enroll-agent-btn").click();
    await page.getByTestId("enroll-agent-id-input").fill("manual-worker");
    await page.getByTestId("enroll-agent-display-name-input").fill("Manual Test Worker");
    
    const [enrollResponse] = await Promise.all([
      page.waitForResponse(
        resp => resp.url().includes("/api/v2/agents") && resp.request().method() === "POST"
      ),
      page.getByTestId("enroll-agent-submit").click()
    ]);
    expect(enrollResponse.status()).toBe(201);

    // Verify key reveal modal
    await expect(page.getByTestId("revealed-api-key")).toBeVisible({ timeout: 15000 });
    
    // The checkbox enables the close button
    const checkbox = page.getByTestId("reveal-save-checkbox");
    await expect(checkbox).toBeVisible();
    await checkbox.check({ force: true });
    await expect(checkbox).toBeChecked({ timeout: 15000 });
    
    const closeBtn = page.getByTestId("reveal-close-btn");
    await expect(closeBtn).toBeEnabled({ timeout: 20000 });
    await closeBtn.click();
    
    await expect(page.getByTestId("revealed-api-key")).not.toBeVisible();
  });

  test("Scenario 305: Dynamic Member List & Roles", async ({ page }) => {
    const { adminEmail } = await setupWorkspace(page, "mgmt-305", "workspace_admin", [], "/members");
    
    await expect(page.getByTestId("members-title")).toBeVisible({ timeout: 15000 });

    // Add another admin first, so the first one isn't the "last admin"
    const secondAdmin = `admin2-${Date.now()}@example.com`;
    await page.getByTestId("add-member-btn").click();
    await page.getByTestId("add-member-email-input").fill(secondAdmin);
    await page.getByTestId("add-member-password-input").fill("AdminPass123!");
    await page.getByTestId("add-member-role-select").selectOption("workspace_admin");
    await Promise.all([
      page.waitForResponse(
        resp => resp.url().includes("/api/v2/members") && resp.request().method() === "POST"
      ),
      page.getByTestId("add-member-submit").click()
    ]);
    
    // Handle potential list delay/hydration race
    let memberVisible = false;
    for (let i = 0; i < 6; i++) {
        const memberCell = page.getByTestId("member-email-cell").filter({ hasText: secondAdmin });
        if (await memberCell.isVisible()) {
            memberVisible = true;
            break;
        }
        console.log(`[E2E] Member ${secondAdmin} not in list yet (attempt ${i+1}/6). Reloading...`);
        await page.reload();
        await page.getByTestId("members-title").waitFor({ timeout: 15000 });
        await page.waitForTimeout(2000); 
    }
    expect(memberVisible, `Invited member ${secondAdmin} never appeared in the list`).toBe(true);
    
    // Stabilize: explicitly wait for modal to disappear
    await expect(page.getByTestId("add-member-email-input")).not.toBeVisible();

    // Now change the role of the original admin
    const roleSelect = page.getByTestId(`role-select-${adminEmail}`);
    await expect(roleSelect).toBeVisible({ timeout: 10000 });
    await Promise.all([
      page.waitForResponse(
        resp => resp.url().includes("/api/v2/members") && resp.request().method() === "PATCH"
      ),
      roleSelect.selectOption("workspace_viewer")
    ]);
    
    await expect(page.getByTestId("members-success-banner")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("members-success-banner")).toContainText("Role updated");
    await expect(roleSelect).toHaveValue("workspace_viewer");
  });

  test("Scenario 307: Agent Metadata View", async ({ page }) => {
    // Seed with a pre-enrolled agent
    await setupWorkspace(page, "mgmt-307", "workspace_admin", ["metadata-bot"], "/agents");
    
    const agentRow = page.getByTestId("agent-row-metadata-bot");
    await expect(agentRow).toBeVisible({ timeout: 15000 });
    
    // Verify ID in the cell and status badge
    await expect(agentRow.getByTestId("agent-id-cell")).toHaveText("metadata-bot");
    await expect(page.getByTestId("agent-status-metadata-bot")).toContainText(/active/i);
  });

  test("Scenario 308: Invite Member UI Validation", async ({ page }) => {
    await setupWorkspace(page, "mgmt-308", "workspace_admin", [], "/members");
    
    await page.getByTestId("add-member-btn").click();
    await page.getByTestId("add-member-email-input").fill("invalid-email");
    
    // We expect native HTML5 validation to block submission or the UI to stay open
    await page.getByTestId("add-member-submit").click();
    
    // Form should still be visible because email is invalid (native or app-level validation)
    await expect(page.getByTestId("add-member-email-input")).toBeVisible();
  });
});
