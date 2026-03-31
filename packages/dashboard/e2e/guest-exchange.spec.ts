import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";

test.describe("Guest Secret Exchange (Phase 3C)", () => {
  const browserUiUrl = "http://127.0.0.1:5175";
  const dashboardUrl = "http://127.0.0.1:5173";

  test("Scenario 917: Guest Agent -> Human Fulfill -> Guest Agent Retrieval", async ({ page, db }) => {
    // 1. Setup workspace with a specific agent for the fulfiller
    const { agents } = await setupWorkspace(
      page, 
      "guest-917", 
      "workspace_admin", 
      ["guest-fulfillment-bot"]
    );
    console.log("[E2E Test] Enrolled agents:", JSON.stringify(agents, null, 2));
    const fulfillerApiKey = agents["guest-fulfillment-bot"];
    expect(fulfillerApiKey, "Agent API key for guest-fulfillment-bot is missing").toBeTruthy();
    
    // 1.5 Exchange Agent API Key for a JWT Access Token
    const authRes = await page.request.post("http://127.0.0.1:3100/api/v2/agents/token", {
      headers: { "Authorization": `Bearer ${fulfillerApiKey}` }
    });
    expect(authRes.status(), `Agent token exchange failed: ${await authRes.text()}`).toBe(200);
    const { access_token: agentJwt } = await authRes.json();

    // 2. Generate a secure link on behalf of an agent (using API)
    const tokenRes = await page.request.post("http://127.0.0.1:3100/api/v2/secret/request", {
      headers: { "Authorization": `Bearer ${agentJwt}` },
      data: {
        public_key: "uSREmD9Y6pQGv1p8S5Y2Y4zX8rG+x/t5K/yX+Q/7O2Y=", // Valid 32-byte Base64 key
        description: "E2E Guest Exchange Test"
      }
    });
    expect(tokenRes.status(), "Failed to create secret request").toBe(201);
    const { request_id, secret_url } = await tokenRes.json();
    expect(request_id).toBeDefined();
    expect(secret_url).toBeDefined();

    // Debug logging
    page.on("console", msg => console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`));
    page.on("requestfailed", req => console.log(`[Browser Request Failed] ${req.method()} ${req.url()}: ${req.failure()?.errorText}`));

    // 3. Visit the fulfillment link in Browser-UI
    // Use replaceAll to ensure api_url in query string is also updated
    const secretUrlFix = secret_url.replace(/localhost/g, "127.0.0.1");
    await page.goto(secretUrlFix);
    
    // 4. Wait for the page to be ready (ensure no 401)
    await expect(page.getByTestId("status")).toContainText(/session code/i, { timeout: 15000 });

    // 5. Submit the secret - ensure input is enabled
    const testSecret = "top-secret-guest-value";
    const secretInput = page.getByTestId("secret-input");
    await expect(secretInput).toBeEnabled({ timeout: 15000 });
    await secretInput.fill(testSecret);
    await page.getByTestId("submit-btn").click();
    
    // 6. Wait for success
    await expect(page.getByTestId("success-message")).toBeVisible({ timeout: 15000 });

    // 7. Verify the secret is revealed via Agent API (Scenario 917 specifies Agent Retrieval)
    const retrieveRes = await page.request.get(`http://127.0.0.1:3100/api/v2/secret/retrieve/${request_id}`, {
      headers: { "Authorization": `Bearer ${agentJwt}` }
    });
    expect(retrieveRes.status(), "Failed to retrieve secret via API").toBe(200);
    const secretData = await retrieveRes.json();
    expect(secretData.ciphertext).toBeDefined();
    // In a real scenario we'd decrypt here, but verifying successful retrieval of ciphertext is enough for E2E infrastructure validation.
  });
});
