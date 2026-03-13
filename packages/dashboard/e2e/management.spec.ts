import { expect, test } from "@playwright/test";
import pg from "pg";

test.describe("Management", () => {
  const password = "LongPassword123!";

  async function setupWorkspace(page: any) {
    const timestamp = Date.now() + Math.floor(Math.random() * 1000);
    const workspaceSlug = `e2e-mgmt-${timestamp}`;
    const adminEmail = `admin-mgmt-${timestamp}@example.com`;

    // 1. Register a fresh workspace
    await page.goto("/register");
    await page.getByLabel("Display name").fill("Mgmt Test Space");
    await page.getByLabel("Email address").fill(adminEmail);
    await page.getByLabel("Workspace slug").fill(workspaceSlug);
    await page.getByLabel("Master password").fill(password);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Create my account/i }).click();
    await expect(page).toHaveURL("/");
    
    // 2. Mark owner as verified in DB
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        "UPDATE users SET email_verified = true WHERE email = $1",
        [adminEmail]
      );
    } finally {
      await client.end();
    }
    
    // 3. Reload to reflect verification status
    await page.reload();
    
    return { workspaceSlug, adminEmail };
  }

  test("Scenario 301: Agent Enrollment and Reveal", async ({ page }) => {
    const { adminEmail } = await setupWorkspace(page);
    
    await page.goto("/agents");
    await expect(page).toHaveURL("/agents");

    await page.getByRole("button", { name: /Enroll agent/i }).first().click();
    await page.getByLabel("Agent ID").fill("e2e-bot");
    await page.getByLabel("Agent display name").fill("E2E Bot");
    await page.getByRole("button", { name: /Create bootstrap key/i }).first().click();

    // Verify key reveal modal appears
    const reveal = page.locator(".modal-card").filter({ hasText: /Bootstrap key/i }).first();
    await expect(reveal).toBeVisible({ timeout: 10000 });
    const apiKey = await reveal.locator("code").first().innerText();
    expect(apiKey).toMatch(/^ak_/);

    // Confirm and close
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /I saved this key/i }).first().click();
    
    // Verify modal closed and key gone
    await expect(reveal).not.toBeVisible();
    await expect(page.getByText("e2e-bot").first()).toBeVisible();
  });

  test("Scenario 305: Member Management", async ({ page }) => {
    const { adminEmail } = await setupWorkspace(page);

    await page.goto("/members");
    await expect(page).toHaveURL("/members");

    // Add member
    await page.getByRole("button", { name: /Add member/i }).first().click();
    const memberEmail = `member-${Date.now()}@example.com`;
    await page.getByLabel("Email address").fill(memberEmail);
    await page.getByLabel("Temporary password").fill("SecureTempPassword123!");
    await page.getByRole("button", { name: /Create member/i }).first().click();

    await expect(page.getByText(memberEmail).first()).toBeVisible();
    await expect(page.getByText("Password reset required").first()).toBeVisible();

    // Update role
    const roleSelect = page.getByTestId(`role-select-${memberEmail}`).first();
    await roleSelect.selectOption("workspace_operator");
    await expect(page.getByText("Updating...", { exact: false }).first()).not.toBeVisible();
    
    // Suspend member
    await page.getByTestId(`suspend-btn-${memberEmail}`).first().click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    
    const patchResponse = page.waitForResponse(resp => 
      resp.url().includes("/api/v2/members/") && resp.request().method() === "PATCH",
      { timeout: 10000 }
    );
    await page.getByTestId("confirm-dialog-btn").first().click();
    await patchResponse;
    
    // Explicit reload to ensure fresh data and bypass any race conditions in list reloads
    await page.reload();
    await expect(page.getByTestId(`member-status-${memberEmail}`).first()).toHaveText("suspended", { timeout: 15000 });
  });

  test("Scenario 307: Last-admin lockout", async ({ page }) => {
    const { adminEmail } = await setupWorkspace(page);

    await page.goto("/members");
    await expect(page).toHaveURL("/members");

    // Admin email should be in the list
    const roleSelect = page.getByTestId(`role-select-${adminEmail}`).first();
    
    // Should be disabled
    await expect(roleSelect).toBeDisabled();
    
    const suspendBtn = page.getByTestId(`suspend-btn-${adminEmail}`).first();
    await expect(suspendBtn).toBeDisabled();
  });

  test("Scenario 308: Workspace Settings Update", async ({ page }) => {
    const { adminEmail } = await setupWorkspace(page);

    await page.goto("/settings");
    await expect(page).toHaveURL("/settings");

    const newName = `Updated Space ${Date.now()}`;
    await page.getByTestId("workspace-display-name-input").first().fill(newName);
    const responsePromise = page.waitForResponse(r => r.url().includes("/api/v2/workspace") && r.request().method() === "PUT");
    await page.getByRole("button", { name: /Save workspace/i }).first().click();
    await responsePromise;
    await page.getByRole("link", { name: /Dashboard/i }).click(); // Use Dashboard to see sidebar update
    await expect(page.locator(".sidebar-workspace__name").first()).toHaveText(newName);
  });
});
