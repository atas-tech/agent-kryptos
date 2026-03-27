import { expect, test } from "@playwright/test";

test.describe("Authentication", () => {
  const password = "LongPassword123!";

  test("Scenario 001: First-time Registration", async ({ page }) => {
    const timestamp = Date.now();
    const workspaceSlug = `e2e-reg-${timestamp}`;
    const email = `admin-reg-${timestamp}@example.com`;

    await page.goto("/register");

    await page.getByLabel("Display name").fill("E2E Workspace");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Workspace slug").fill(workspaceSlug);
    await page.getByLabel("Master password").fill(password);
    
    await page.locator('input[type="checkbox"]').check();
    
    await page.getByRole("button", { name: /Create my account/i }).click();

    // Debug: check for error banner if redirect fails
    const errorBanner = page.locator(".error-banner");
    if (await errorBanner.isVisible()) {
      const errorText = await errorBanner.innerText();
      console.error(`Registration failed with error: ${errorText}`);
    }

    // Should redirect to dashboard home
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await expect(page.getByText("Workspace command overview")).toBeVisible();
    await expect(page.locator('.workspace-heading').first()).toHaveText("E2E Workspace");
    
    // Verify browser storage does not retain session tokens.
    const localStorage = await page.evaluate(() => JSON.stringify(window.localStorage));
    const sessionStorage = await page.evaluate(() => JSON.stringify(window.sessionStorage));
    expect(localStorage).not.toContain("access_token");
    expect(localStorage).not.toContain("sps_refresh_token");
    expect(sessionStorage).not.toContain("access_token");
    expect(sessionStorage).not.toContain("sps_refresh_token");
  });

  test("Scenario 002: Login & Session Persistence", async ({ page }) => {
    const timestamp = Date.now();
    const workspaceSlug = `e2e-pers-${timestamp}`;
    const email = `admin-pers-${timestamp}@example.com`;

    // 1. Register first to ensure user exists
    await page.goto("/register");
    await page.getByLabel("Display name").fill("Persistence Test");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Workspace slug").fill(workspaceSlug);
    await page.getByLabel("Master password").fill(password);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Create my account/i }).click();
    await expect(page).toHaveURL("/");
    
    // Logout
    const logoutBtn = page.getByRole("button", { name: /Log out/i });
    await logoutBtn.scrollIntoViewIfNeeded();
    await logoutBtn.dispatchEvent("click");
    await expect(page).toHaveURL("/login");

    // 2. Login
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /Login to portal/i }).click();

    await expect(page).toHaveURL("/");
    await expect(page.getByText("active role")).toBeVisible();

    // 3. Reload page; verify session persists via refresh token
    await page.reload();
    await expect(page).toHaveURL("/", { timeout: 10000 });
    await expect(page.getByText("active role")).toBeVisible();
  });

  test("Scenario 003: Logout Flow", async ({ page }) => {
    const timestamp = Date.now();
    const workspaceSlug = `e2e-logout-${timestamp}`;
    const email = `admin-logout-${timestamp}@example.com`;

    // 1. Register
    await page.goto("/register");
    await page.getByLabel("Display name").fill("Logout Test");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Workspace slug").fill(workspaceSlug);
    await page.getByLabel("Master password").fill(password);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Create my account/i }).click();
    await expect(page).toHaveURL("/");

    // 2. Click logout
    const logoutBtn = page.getByRole("button", { name: /Log out/i });
    await logoutBtn.scrollIntoViewIfNeeded();
    await logoutBtn.dispatchEvent("click");

    // Should redirect to login
    await expect(page).toHaveURL("/login");

    // 3. Attempt to visit protected route
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });
});
