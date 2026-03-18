import { expect, test } from "@playwright/test";
import pg from "pg";

test.describe("Workspace Policy", () => {
  const password = "LongPassword123!";

  async function setupWorkspace(page: any) {
    const timestamp = Date.now() + Math.floor(Math.random() * 10000);
    const workspaceSlug = `e2e-policy-${timestamp}`;
    const adminEmail = `admin-policy-${timestamp}@example.com`;

    // 1. Register a fresh workspace
    await page.goto("/register");
    await page.getByLabel("Display name").fill("Policy Test Space");
    await page.getByLabel("Email address").fill(adminEmail);
    await page.getByLabel("Workspace slug").fill(workspaceSlug);
    await page.getByLabel("Master password").fill(password);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Create my account/i }).click();
    
    await expect(page).toHaveURL("/", { timeout: 15000 });
    
    // 2. Mark owner as verified in DB
    const dbUrl = process.env.DATABASE_URL || "postgresql://kryptos:localdev@127.0.0.1:5433/agent_kryptos";
    const client = new pg.Client({ connectionString: dbUrl });
    try {
      await client.connect();
      await client.query(
        "UPDATE users SET email_verified = true WHERE email = $1",
        [adminEmail]
      );
    } catch (err) {
      // Ignore if DB not available in this env
    } finally {
      await client.end();
    }
    
    // 3. Reload to reflect verification status
    await page.reload();
    await expect(page).toHaveURL("/", { timeout: 10000 });
    
    return { workspaceSlug, adminEmail };
  }

  test("Scenario 401: Admin Policy Management", async ({ page }) => {
    const { adminEmail } = await setupWorkspace(page);
    
    await page.goto("/policy");
    await expect(page).toHaveURL("/policy", { timeout: 10000 });

    // Add a secret to the registry
    await page.getByTestId("add-secret-entry-btn").click();
    const secretRows = page.locator("table.data-table tbody tr");
    const lastSecretRow = secretRows.last();
    await lastSecretRow.locator('input[placeholder="stripe.api_key.prod"]').fill("stripe.api_key.prod");
    await lastSecretRow.locator('input[placeholder="finance"]').fill("finance");
    await lastSecretRow.locator('input[placeholder="Stripe production key"]').fill("E2E Test Secret");

    // Add an exchange rule
    await page.getByTestId("add-rule-btn").click();
    const ruleCards = page.locator(".policy-rule-card");
    const lastRuleCard = ruleCards.last();
    await lastRuleCard.locator('input[placeholder="allow-stripe"]').fill("e2e-rule");
    await lastRuleCard.locator('input[placeholder="stripe.api_key.prod"]').fill("stripe.api_key.prod");
    await lastRuleCard.locator("select").selectOption("pending_approval");
    await lastRuleCard.locator('input[placeholder="Primary payments flow"]').fill("Requires review");

    // Validate
    await page.getByRole("button", { name: /Validate/i }).click();
    await expect(page.getByText("Policy validation passed.")).toBeVisible();

    // Save
    const patchResponse = page.waitForResponse(resp => 
      resp.url().includes("/api/v2/workspace/policy") && resp.request().method() === "PATCH",
      { timeout: 10000 }
    );
    await page.getByTestId("save-policy-btn").click();
    const response = await patchResponse;
    const body = await response.json();
    expect(body.policy.version).toBeGreaterThan(1); // Assuming 1 is from bootstrap/seed

    await expect(page.getByText(/Policy saved as version \d+/)).toBeVisible();
  });

  test("Scenario 402: Operator Read-Only Access", async ({ page }) => {
    const { adminEmail } = await setupWorkspace(page);

    // 1. Create an operator
    await page.goto("/members");
    const operatorEmail = `operator-${Date.now()}@example.com`;
    await page.getByRole("button", { name: /Add member/i }).click();
    await page.getByLabel("Email address").fill(operatorEmail);
    await page.getByLabel("Temporary password").fill("SecureTempPassword123!");
    await page.getByRole("button", { name: /Create member/i }).click();
    
    // Set role to operator
    const roleSelect = page.getByTestId(`role-select-${operatorEmail}`).first();
    await roleSelect.selectOption("workspace_operator");

    // 2. Logout admin and login as operator
    await page.getByRole("button", { name: /Logout/i }).first().click();
    await page.goto("/login");
    await page.getByLabel("Email address").fill(operatorEmail);
    await page.getByLabel("Master password").fill("SecureTempPassword123!");
    await page.getByRole("button", { name: /Sign in/i }).click();

    // Forced password change
    await page.getByLabel("Current password").fill("SecureTempPassword123!");
    await page.getByLabel("New password").fill(password);
    await page.getByLabel("Repeat new password").fill(password);
    await page.getByRole("button", { name: /Update password/i }).click();
    await expect(page).toHaveURL("/");

    // 3. Navigate to policy page and verify read-only
    await page.goto("/policy");
    await expect(page.getByText("Operator view")).toBeVisible();
    await expect(page.getByTestId("add-secret-entry-btn")).not.toBeVisible();
    await expect(page.getByTestId("add-rule-btn")).not.toBeVisible();
    await expect(page.getByTestId("save-policy-btn")).not.toBeVisible();
    
    const inputs = page.locator("input.policy-input");
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      await expect(inputs.nth(i)).toBeDisabled();
    }
  });

  test("Scenario 403: Validation Errors", async ({ page }) => {
    const { adminEmail } = await setupWorkspace(page);
    
    await page.goto("/policy");
    
    // Add two rules with the same ID
    await page.getByTestId("add-rule-btn").click();
    await page.getByTestId("add-rule-btn").click();
    
    const ruleCards = page.locator(".policy-rule-card");
    await ruleCards.nth(0).locator('input[placeholder="allow-stripe"]').fill("duplicate-id");
    await ruleCards.nth(1).locator('input[placeholder="allow-stripe"]').fill("duplicate-id");

    // Validate
    await page.getByRole("button", { name: /Validate/i }).click();
    await expect(page.getByText("Policy validation returned issues.")).toBeVisible();
    await expect(page.getByText("duplicate_rule_id")).toBeVisible();

    // Verify Save is disabled
    await expect(page.getByTestId("save-policy-btn")).toBeDisabled();
  });
});
