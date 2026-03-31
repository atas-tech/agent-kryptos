import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";

test.describe("Routing & RBAC", () => {

  test("Scenario 004: Force Password Change Enforcement", async ({ page, db }) => {
    const { adminEmail, password } = await setupWorkspace(page, "routing-004");
    
    // Set force_password_change flag directly in DB for the owner
    await db.query("UPDATE users SET force_password_change = true WHERE email = $1", [adminEmail]);
    
    // Logout and log back in to trigger flow
    await page.getByTestId("logout-button").first().click();
    await page.goto("/login");
    await page.getByTestId("login-email").fill(adminEmail);
    await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();

    // Should be redirected to /change-password
    await expect(page).toHaveURL("/change-password", { timeout: 10000 });
    
    // Attempt to visit /agents - should be blocked
    await page.goto("/agents");
    await expect(page).toHaveURL("/change-password");

    // Change password
    await page.getByTestId("change-password-current").fill(password);
    await page.getByTestId("change-password-new").fill("NewPassword123!");
    await page.getByTestId("change-password-confirm").fill("NewPassword123!");
    await page.getByTestId("change-password-submit").click();
  
    // Should now be at dashboard root
    await expect(page).toHaveURL("/", { timeout: 15000 });

    // Should now be allowed to visit /agents
    await page.goto("/agents");
    await expect(page).toHaveURL("/agents");
  });

  test("Scenario 005: Role-based Navigation & Redirects", async ({ page }) => {
    // 1. Operator
    await setupWorkspace(page, "rbac-op", "workspace_operator");

    // Should be at /agents (operator default)
    await expect(page).toHaveURL("/agents", { timeout: 10000 });
    
    // Sidebar should hide Billing & Members
    await expect(page.getByTestId("nav-link-billing")).not.toBeVisible();
    await expect(page.getByTestId("nav-link-members")).not.toBeVisible();

    // 2. Viewer
    // Use a fresh page/context for the second role test to ensure no session leakage
    await setupWorkspace(page, "rbac-view", "workspace_viewer");

    // Viewers should be redirected to /audit
    await expect(page).toHaveURL("/audit", { timeout: 10000 });

    // Sidebar should hide Agents
    await expect(page.getByTestId("nav-link-agents")).not.toBeVisible();
  });
});
