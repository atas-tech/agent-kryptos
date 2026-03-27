import { expect, test } from "@playwright/test";
import { Pool } from "pg";

test.describe("Routing & RBAC", () => {
  const password = "LongPassword123!";

  let pool: Pool;

  test.beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || "postgresql://blindpass:localdev@127.0.0.1:5433/blindpass",
    });
  });

  test.afterAll(async () => {
    await pool.end();
  });

  async function verifyEmail(email: string) {
    await pool.query("UPDATE users SET email_verified = true WHERE email = $1", [email]);
  }

  test("Scenario 004: Force Password Change Enforcement", async ({ page }) => {
    const timestamp = Date.now();
    const adminEmail = `admin-force-${timestamp}@example.com`;
    const memberEmail = `member-force-${timestamp}@example.com`;

    // 1. Register Admin
    await page.goto("/register");
    await page.getByLabel("Display name").fill("Force Test Admin");
    await page.getByLabel("Email address").fill(adminEmail);
    await page.getByLabel("Workspace slug").fill(`force-${timestamp}`);
    await page.getByLabel("Master password").fill(password);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Create my account/i }).click();
    await expect(page).toHaveURL("/");

    // 2. Setup member with force_password_change = true
    // We'll just register another user and update them in DB to simulate a member
    const logoutBtn = page.getByRole("button", { name: /Log out/i });
    await logoutBtn.scrollIntoViewIfNeeded();
    await logoutBtn.dispatchEvent("click");
    
    await page.goto("/register");
    await page.getByLabel("Display name").fill("Force Member");
    await page.getByLabel("Email address").fill(memberEmail);
    await page.getByLabel("Workspace slug").fill(`force-mem-${timestamp}`);
    await page.getByLabel("Master password").fill(password);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Create my account/i }).click();
    await expect(page).toHaveURL("/");

    await pool.query("UPDATE users SET force_password_change = true WHERE email = $1", [memberEmail]);
    
    // Logout and log back in
    const logoutBtn2 = page.getByRole("button", { name: /Log out/i });
    await logoutBtn2.scrollIntoViewIfNeeded();
    await logoutBtn2.dispatchEvent("click");
    await page.goto("/login");
    await page.getByLabel("Email address").fill(memberEmail);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /Login to portal/i }).dispatchEvent("click");

    // Log any errors if login fails to redirect
    const errorBanner = page.locator(".error-banner");
    if (await errorBanner.isVisible()) {
      console.log(`Login failed with error: ${await errorBanner.textContent()}`);
    }

    // Should be redirected to /change-password
    await expect(page).toHaveURL("/change-password", { timeout: 10000 });
    
    // Attempt to visit /agents
    await page.goto("/agents");
    await expect(page).toHaveURL("/change-password");

    // Change password
    await page.getByLabel("Current password").fill(password);
    await page.getByLabel("New password").first().fill("NewPassword123!");
    await page.getByLabel("Confirm new password").fill("NewPassword123!");
    await page.getByRole("button", { name: /Apply new password/i }).click();
 
    // Should now be at dashboard root
    await expect(page).toHaveURL("/");

    // Should now be allowed to visit /agents
    await page.goto("/agents");
    await expect(page).toHaveURL("/agents");
  });

  test("Scenario 005: Role-based Navigation & Redirects", async ({ page }) => {
    const timestamp = Date.now();
    const opEmail = `op-rbac-${timestamp}@example.com`;
    const viewEmail = `view-rbac-${timestamp}@example.com`;

    // 1. Setup Operator
    await page.goto("/register");
    await page.getByLabel("Display name").fill("Operator User");
    await page.getByLabel("Email address").fill(opEmail);
    await page.getByLabel("Workspace slug").fill(`op-rbac-${timestamp}`);
    await page.getByLabel("Master password").fill(password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /Create my account/i }).dispatchEvent("click");
    await expect(page).toHaveURL("/");

    const resO = await pool.query("UPDATE users SET role = 'workspace_operator' WHERE email = $1", [opEmail]);
    if ((resO.rowCount ?? 0) === 0) {
      // Small retry for DB consistency
      await page.waitForTimeout(500);
      const resO2 = await pool.query("UPDATE users SET role = 'workspace_operator' WHERE email = $1", [opEmail]);
      if ((resO2.rowCount ?? 0) === 0) {
        throw new Error(`User not found for update (after retry): ${opEmail}`);
      }
    }
    
    // Logout and login to get new role
    const logoutBtnO = page.getByRole("button", { name: /Log out/i });
    await logoutBtnO.scrollIntoViewIfNeeded();
    await logoutBtnO.dispatchEvent("click");
    await expect(page).toHaveURL("/login");

    await page.goto("/login");
    await page.getByLabel("Email address").fill(opEmail);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /Login to portal/i }).dispatchEvent("click");

    // Should be at /agents (operator default)
    await expect(page).toHaveURL("/agents", { timeout: 10000 });
    
    // Sidebar should hide Billing & Members
    await expect(page.getByRole("link", { name: /Billing/i })).not.toBeVisible();
    await expect(page.getByRole("link", { name: /Members/i })).not.toBeVisible();

    // 2. Setup Viewer
    const logoutBtn3 = page.getByRole("button", { name: /Log out/i });
    await logoutBtn3.scrollIntoViewIfNeeded();
    await logoutBtn3.dispatchEvent("click");
    await expect(page).toHaveURL("/login");
    
    await page.goto("/register");
    await page.getByLabel("Display name").fill("Viewer User");
    await page.getByLabel("Email address").fill(viewEmail);
    await page.getByLabel("Workspace slug").fill(`view-rbac-${timestamp}`);
    await page.getByLabel("Master password").fill(password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /Create my account/i }).dispatchEvent("click");
    
    // Explicitly wait for registration to finish
    await expect(page).toHaveURL("/", { timeout: 15000 });
    
    // Register defaults to admin, so we update to viewer in DB
    const resV = await pool.query("UPDATE users SET role = 'workspace_viewer' WHERE email = $1", [viewEmail]);
    if ((resV.rowCount ?? 0) === 0) {
      // Small retry for DB consistency
      await page.waitForTimeout(500);
      const resV2 = await pool.query("UPDATE users SET role = 'workspace_viewer' WHERE email = $1", [viewEmail]);
      if ((resV2.rowCount ?? 0) === 0) {
        throw new Error(`User not found for update (after retry): ${viewEmail}`);
      }
    }
    
    // Logout and login to get new role
    const logoutBtnV = page.getByRole("button", { name: /Log out/i });
    await logoutBtnV.scrollIntoViewIfNeeded();
    await logoutBtnV.dispatchEvent("click");
    
    await page.goto("/login");
    await page.getByLabel("Email address").fill(viewEmail);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /Login to portal/i }).dispatchEvent("click");

    // Viewers should be redirected to /audit
    await expect(page).toHaveURL("/audit", { timeout: 10000 });

    // Sidebar should hide Agents
    await expect(page.getByRole("link", { name: /Agents/i })).not.toBeVisible();
  });
});
