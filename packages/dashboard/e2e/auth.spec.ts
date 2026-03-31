import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";

test.describe("Authentication", () => {
  const password = "LongPassword123!";

  test("Scenario 001: First-time Registration (Golden Path)", async ({ page }) => {
    const timestamp = Date.now();
    const workspaceSlug = `e2e-reg-${timestamp}`;
    const email = `admin-reg-${timestamp}@example.com`;

    await page.goto("/register");

    await page.getByTestId("register-display-name").fill("E2E Workspace");
    await page.getByTestId("register-email").fill(email);
    await page.getByTestId("register-slug").fill(workspaceSlug);
    await page.getByTestId("register-password").fill(password);
    
    await page.getByTestId("register-terms").check();
    
    await page.getByTestId("register-submit").click();

    // Should redirect to dashboard home
    await expect(page).toHaveURL("/", { timeout: 20000 });
    await expect(page.getByTestId("sidebar-workspace-name")).toHaveText("E2E Workspace");
    
    // Verify browser storage does not leak the access_token (which should be in-memory only)
    const localStorage = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(localStorage).not.toContain("access_token");
  });

  test("Scenario 002: Login & Session Persistence", async ({ page }) => {
    const { adminEmail, password: seededPassword } = await setupWorkspace(page, "auth-002");
    
    // Logout first to test login
    const logoutBtn = page.getByTestId("logout-button");
    await logoutBtn.scrollIntoViewIfNeeded();
    await logoutBtn.dispatchEvent("click");
    await expect(page).toHaveURL("/login", { timeout: 15000 });

    // Login
    await page.getByTestId("login-email").fill(adminEmail);
    await page.getByTestId("login-password").fill(seededPassword);
    await page.getByTestId("login-submit").click();

    await expect(page).toHaveURL("/", { timeout: 15000 });
    await expect(page.getByTestId("nav-sidebar")).toBeVisible();

    // Reload page; verify session persists via refresh token
    await page.reload();
    await expect(page).toHaveURL("/", { timeout: 15000 });
    await expect(page.getByTestId("nav-sidebar")).toBeVisible();
  });

  test("Scenario 003: Logout Flow", async ({ page }) => {
    await setupWorkspace(page, "auth-003");

    // Click logout
    const logoutBtn = page.getByTestId("logout-button");
    await logoutBtn.scrollIntoViewIfNeeded();
    await logoutBtn.dispatchEvent("click");

    // Should redirect to login
    await expect(page).toHaveURL("/login", { timeout: 15000 });

    // Attempt to visit protected route
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });
});
