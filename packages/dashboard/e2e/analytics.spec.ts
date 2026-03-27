import { expect, test } from "@playwright/test";
import pg from "pg";

test.describe("Analytics Dashboard", () => {
  const password = "LongPassword123!";

  async function setupWorkspace(page: any) {
    const timestamp = Date.now() + Math.floor(Math.random() * 10000);
    const workspaceSlug = `e2e-analytics-${timestamp}`;
    const adminEmail = `admin-analytics-${timestamp}@example.com`;

    // 1. Register a fresh workspace
    await page.goto("/register");
    await page.getByLabel("Display name").fill("Analytics Test Space");
    await page.getByLabel("Email address").fill(adminEmail);
    await page.getByLabel("Workspace slug").fill(workspaceSlug);
    await page.getByLabel("Master password").fill(password);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Create my account/i }).click();
    await expect(page).toHaveURL("/");

    // 2. Mark owner as verified in DB
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || "postgresql://blindpass:localdev@127.0.0.1:5433/blindpass"
    });
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

  test("Scenario 601: Analytics dashboard overview and metrics", async ({ page, request }) => {
    const { adminEmail } = await setupWorkspace(page);

    // 1. Initially check analytics (should be empty/low)
    await page.getByRole("link", { name: "Analytics" }).click();
    await expect(page).toHaveURL("/analytics");
    
    // 2. Enroll an agent to trigger "Active agents" metric (token minting)
    await page.getByRole("link", { name: "Agents" }).click();
    await expect(page).toHaveURL("/agents");
    
    await page.getByRole("button", { name: /Enroll agent/i }).first().click();
    await page.getByLabel("Agent ID").fill("analytics-bot");
    await page.getByLabel("Agent display name").fill("Analytics Bot");
    await page.getByRole("button", { name: /Create bootstrap key/i }).first().click();

    // extract bootstrap key
    const reveal = page.locator(".modal-card").filter({ hasText: /Bootstrap key/i }).first();
    await expect(reveal).toBeVisible({ timeout: 15000 });
    const bootstrapKey = (await reveal.locator("code").first().innerText()).trim();
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /I saved this key/i }).first().click();

    // 3. Mint a token using the bootstrap key (Direct API call to simulate agent activity)
    // We target the API port directly to bypass any Vite proxy flakes during heavy test runs
    const spsUrl = "http://localhost:3100";
    const tokenResponse = await request.post(`${spsUrl}/api/v2/agents/token`, {
      headers: {
        Authorization: `Bearer ${bootstrapKey}`
      }
    });
    expect(tokenResponse.status()).toBe(200);

    // 4. Create a secret request to trigger "Request volume" metric
    // We need to fetch the user token from the browser context to make an authorized API call
    const userToken = await page.evaluate(() => localStorage.getItem("blindpass_access_token"));
    const createReqResponse = await request.post(`${spsUrl}/api/v2/requests`, {
       headers: {
         Authorization: `Bearer ${userToken}`
       },
       data: {
         purpose: "Analytics Test Request",
         schema_id: "default-v1"
       }
    });
    expect(createReqResponse.status()).toBe(201);

    // 5. Verify metrics on Analytics page
    await page.getByRole("link", { name: "Analytics" }).click();
    await page.getByRole("button", { name: /Refresh/i }).first().click();

    // Active agents should now be >= 1
    const activeAgentsAfter = await page.locator(".metric-panel span:has-text('Active agents') + strong").innerText();
    expect(parseInt(activeAgentsAfter, 10)).toBeGreaterThanOrEqual(1);

    // Request volume should be >= 1
    const requestVolume = await page.locator(".metric-panel span:has-text('Request volume') + strong").innerText();
    expect(parseInt(requestVolume, 10)).toBeGreaterThanOrEqual(1);

    // 6. Verify charts are visible
    await expect(page.locator("div[aria-label='Request volume chart']")).toBeVisible();
    await expect(page.locator("div[aria-label='Exchange outcomes chart']")).toBeVisible();

    // 7. Verify insights panels reflect activity
    await expect(page.getByText(/30-day request pace/i)).toBeVisible();
    await expect(page.getByText(/requests were created across the selected period/i)).toBeVisible();
    await expect(page.getByText(/distinct agents minted tokens in the last/i)).toBeVisible();

    // 8. Test timeframe selector
    await page.getByTestId("analytics-days-select").selectOption("7");
    await expect(page.getByRole("button", { name: /Refresh/i }).first()).toBeDisabled(); // usually disables during fetch
    await page.waitForTimeout(1000); 
  });
});
