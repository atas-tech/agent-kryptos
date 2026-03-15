import { expect, test } from "@playwright/test";
import pg from "pg";
import http from "node:http";

test.describe("x402 Payments (Milestone 6)", () => {
  const commonPassword = "LongPassword123!";
  const FACILITATOR_PORT = 3101;

  let pool: pg.Pool;
  let mockFacilitator: http.Server;
  let facilitatorVerifyCalls: any[] = [];
  let facilitatorSettleCalls: any[] = [];
  let settleGate: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL || "postgresql://kryptos:localdev@127.0.0.1:5433/agent_kryptos",
    });

    // Start mock facilitator
    mockFacilitator = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        const payload = body ? JSON.parse(body) : {};
        if (req.url === "/verify" && req.method === "POST") {
          facilitatorVerifyCalls.push(payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            valid: true,
            scheme: payload.paymentPayload.scheme,
            networkId: payload.paymentPayload.network,
            payer: payload.paymentPayload.payer
          }));
        } else if (req.url === "/settle" && req.method === "POST") {
          facilitatorSettleCalls.push(payload);
          if (settleGate) {
            await settleGate();
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: "settled",
            txHash: `0x${payload.paymentId.padEnd(64, "0").slice(0, 64)}`
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    await new Promise<void>(resolve => {
      mockFacilitator.listen(FACILITATOR_PORT, resolve);
    });
  });

  test.beforeEach(async () => {
    facilitatorVerifyCalls = [];
    facilitatorSettleCalls = [];
    settleGate = null;
  });

  test.afterAll(async () => {
    if (pool) await pool.end();
    if (mockFacilitator) {
      await new Promise<void>(resolve => mockFacilitator.close(() => resolve()));
    }
  });

  async function setupWorkspace(page: any) {
    const timestamp = Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000);
    const adminEmail = `admin-x402-${timestamp}@example.com`;
    const workspaceSlug = `e2e-x402-${timestamp}`;
    const testPassword = commonPassword;

    await page.goto("/register");
    await page.getByLabel("Display name").fill("x402 Test Space");
    await page.getByLabel("Email address").fill(adminEmail);
    await page.getByLabel("Workspace slug").fill(workspaceSlug);
    await page.getByLabel("Master password").fill(testPassword);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Create my account/i }).click();

    await expect(page).toHaveURL("/", { timeout: 15000 });
    await pool.query("UPDATE users SET email_verified = true WHERE email = $1", [adminEmail]);
    
    const userRes = await pool.query("SELECT id, workspace_id FROM users WHERE email = $1", [adminEmail]);
    const workspaceId = userRes.rows[0].workspace_id;
    const userId = userRes.rows[0].id;
    await pool.query("UPDATE workspaces SET owner_user_id = $1 WHERE id = $2", [userId, workspaceId]);

    await page.reload();
    return { adminEmail, workspaceSlug, workspaceId, userId, testPassword };
  }

  async function enrollAgentAndGetToken(page: any, workspaceId: string, agentId: string) {
    await page.goto("/agents");
    await page.waitForLoadState("networkidle");
    // Click "Enroll agent" in the toolbar
    const enrollBtn = page.getByRole("button", { name: "Enroll agent", exact: true });
    await expect(enrollBtn).toBeVisible({ timeout: 15000 });
    await enrollBtn.click();
    
    // Wait for the modal to be visible
    await expect(page.getByRole("heading", { name: "Enroll a new agent" })).toBeVisible();
    
    await page.getByLabel("Agent ID").fill(agentId);
    await page.getByLabel("Agent display name").fill(`${agentId} Display`);
    
    // The button in the modal says "Create bootstrap key"
    await page.getByRole("button", { name: "Create bootstrap key", exact: true }).click();

    const apiKeyReveal = page.locator(".secret-reveal code");
    await expect(apiKeyReveal).toBeVisible({ timeout: 10000 });
    const apiKeyText = await apiKeyReveal.innerText();
    
    // Check the "I've saved this key" checkbox
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "I saved this key", exact: true }).click();

    // Get JWT via API
    try {
      const response = await page.request.post("http://localhost:3100/api/v2/agents/token", {
        headers: {
          "Authorization": `Bearer ${apiKeyText}`
        }
      });
      if (response.status() !== 200) {
        console.log(`[DEBUG] Token request failed: status=${response.status()} body=${await response.text()}`);
      }
      expect(response.status()).toBe(200);
      const { access_token } = await response.json();
      return { accessToken: access_token, apiKey: apiKeyText };
    } catch (err) {
      console.log(`[DEBUG] Token request threw error: ${err}`);
      throw err;
    }
  }

  async function exhaustFreeCap(workspaceId: string, used = 10) {
    const now = new Date();
    const usageMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    await pool.query(
      `
        INSERT INTO workspace_exchange_usage (workspace_id, usage_month, free_exchange_used, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (workspace_id, usage_month)
        DO UPDATE SET free_exchange_used = EXCLUDED.free_exchange_used, updated_at = now()
      `,
      [workspaceId, usageMonth, used]
    );
  }

  test("Scenario 601: Free-tier workspace hits 402 after monthly free cap", async ({ page }) => {
    const { workspaceId } = await setupWorkspace(page);
    const { accessToken } = await enrollAgentAndGetToken(page, workspaceId, "agent:601");
    await exhaustFreeCap(workspaceId);

    const response = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: {
        "Authorization": `Bearer ${accessToken}`
      },
      data: {
        public_key: "cHVibGljLWtleS1kYXRh",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-customer-order",
        fulfiller_hint: "agent:601-fulfiller"
      }
    });

    if (response.status() !== 402) {
      console.log(`[DEBUG] Scenario 601 failed: status=${response.status()} body=${await response.text()}`);
    }
    expect(response.status()).toBe(402);
    const paymentRequiredHeader = response.headers()["payment-required"];
    expect(paymentRequiredHeader).toBeDefined();

    const payload = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf8"));
    expect(payload.metadata.quoted_amount_cents).toBe(5);
    expect(payload.metadata.quoted_asset_symbol).toBe("USDC");
  });

  test("Scenario 602: Paid-tier agent bypasses payment gate", async ({ page }) => {
    const { workspaceId } = await setupWorkspace(page);
    const { accessToken } = await enrollAgentAndGetToken(page, workspaceId, "agent:602");
    
    // Set workspace to standard tier
    await pool.query("UPDATE workspaces SET tier = 'standard' WHERE id = $1", [workspaceId]);
    await exhaustFreeCap(workspaceId); // Even if "exhausted", standard tier should bypass

    const response = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: {
        "Authorization": `Bearer ${accessToken}`
      },
      data: {
        public_key: "cHVibGljLWtleS1kYXRh",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-customer-order",
        fulfiller_hint: "agent:602-fulfiller"
      }
    });

    if (response.status() !== 201) {
      console.log(`[DEBUG] Scenario 602 failed: status=${response.status()} body=${await response.text()}`);
    }
    expect(response.status()).toBe(201);
  });

  test("Scenario 604: Paid request is denied by default without an allowance", async ({ page }) => {
    const { workspaceId } = await setupWorkspace(page);
    const { accessToken } = await enrollAgentAndGetToken(page, workspaceId, "agent:604");
    await exhaustFreeCap(workspaceId);

    // Get payment details from 402
    const preflight = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: { "Authorization": `Bearer ${accessToken}` },
      data: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge",
        fulfiller_hint: "f"
      }
    });
    const paymentRequiredHeader = preflight.headers()["payment-required"];
    if (!paymentRequiredHeader) {
      console.log(`[DEBUG] Scenario 604 preflight failed: status=${preflight.status()} body=${await preflight.text()}`);
    }
    const paymentDetails = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf8"));
    const option = paymentDetails.accepts[0];

    const paymentId = "pid-604";
    const paymentSignature = Buffer.from(JSON.stringify({
      x402Version: 2,
      paymentId,
      scheme: "exact",
      network: option.network,
      amount: option.maxAmountRequired,
      resource: option.resource
    })).toString("base64");

    const paidAttempt = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "payment-identifier": paymentId,
        "payment-signature": paymentSignature
      },
      data: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge",
        fulfiller_hint: "f"
      }
    });

    expect(paidAttempt.status()).toBe(403);
    const body = await paidAttempt.json();
    expect(body.code).toBe("x402_budget_denied");
  });

  test("Scenario 605: Successful payment verification and settlement", async ({ page }) => {
    const agentId = "agent:605";
    const { workspaceId } = await setupWorkspace(page);
    const { accessToken } = await enrollAgentAndGetToken(page, workspaceId, agentId);
    await exhaustFreeCap(workspaceId);

    // Set allowance via dashboard
    await page.goto("/billing");
    await page.locator("select").first().selectOption(agentId); // Agent select is the first select in the x402 section
    await page.getByLabel("Monthly budget").fill("50");
    await page.getByRole("button", { name: /Save allowance/i }).click();
    await expect(page.locator(".record-title").getByText(agentId, { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("$0.50").first()).toBeVisible(); // 50 cents (budget)

    // Make paid request
    const preflight = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: { "Authorization": `Bearer ${accessToken}` },
      data: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge",
        fulfiller_hint: "f"
      }
    });
    const paymentRequiredHeader = preflight.headers()["payment-required"];
    const paymentDetails = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf8"));
    const option = paymentDetails.accepts[0];

    const paymentId = "pid-605";
    const paymentSignature = Buffer.from(JSON.stringify({
      x402Version: 2,
      paymentId,
      scheme: "exact",
      network: option.network,
      amount: option.maxAmountRequired,
      resource: option.resource
    })).toString("base64");

    const paidAttempt = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "payment-identifier": paymentId,
        "payment-signature": paymentSignature
      },
      data: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge",
        fulfiller_hint: "f"
      }
    });

    expect(paidAttempt.status()).toBe(201);
    expect(facilitatorVerifyCalls.length).toBe(1);
    expect(facilitatorSettleCalls.length).toBe(1);

    // Verify in dashboard ledger
    await page.reload();
    // Use a more specific selector for the transaction history entry
    const row = page.locator("tr").filter({ has: page.locator(".record-title").getByText(agentId, { exact: true }), hasText: "settled" });
    await expect(row).toBeVisible();
    await expect(row.getByText("0.05").first()).toBeVisible();
  });

  test("Scenario 606: Concurrent execution is strictly serialized", async ({ page }) => {
    const { workspaceId } = await setupWorkspace(page);
    const { accessToken } = await enrollAgentAndGetToken(page, workspaceId, "agent:606");
    await exhaustFreeCap(workspaceId);

    // Set allowance
    await pool.query("INSERT INTO agent_allowances (workspace_id, agent_id, monthly_budget_cents, current_spend_cents, updated_at) VALUES ($1, $2, 100, 0, now())", [workspaceId, "agent:606"]);

    const preflight = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: { "Authorization": `Bearer ${accessToken}` },
      data: { public_key: "cHVibGlj", secret_name: "stripe.api_key.prod", purpose: "c", fulfiller_hint: "f" }
    });
    const paymentRequiredHeader = preflight.headers()["payment-required"];
    const paymentDetails = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf8"));
    const option = paymentDetails.accepts[0];

    // Hold settlement
    let release: () => void;
    const gate = new Promise<void>(res => { release = res; });
    settleGate = async () => await gate;

    const firstPromise = page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "payment-identifier": "pid-606-1",
        "payment-signature": Buffer.from(JSON.stringify({
          x402Version: 2, paymentId: "pid-606-1", scheme: "exact", network: option.network, amount: option.maxAmountRequired, resource: option.resource
        })).toString("base64")
      },
      data: { public_key: "cHVibGlj", secret_name: "stripe.api_key.prod", purpose: "c", fulfiller_hint: "f" }
    });

    // Wait a bit for first one to hit the gate
    await new Promise(resolve => setTimeout(resolve, 100));

    const secondResponse = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "payment-identifier": "pid-606-2",
        "payment-signature": Buffer.from(JSON.stringify({
          x402Version: 2, paymentId: "pid-606-2", scheme: "exact", network: option.network, amount: option.maxAmountRequired, resource: option.resource
        })).toString("base64")
      },
      data: { public_key: "cHVibGlj", secret_name: "stripe.api_key.prod", purpose: "c", fulfiller_hint: "f" }
    });

    expect(secondResponse.status()).toBe(409);
    const body = await secondResponse.json();
    expect(body.code).toBe("payment_in_progress");

    // Release and wait for first
    release!();
    const firstResponse = await firstPromise;
    expect(firstResponse.status()).toBe(201);
  });

  test("Scenario 607: Idempotent retry reuses the prior successful result", async ({ page }) => {
    const { workspaceId } = await setupWorkspace(page);
    const { accessToken } = await enrollAgentAndGetToken(page, workspaceId, "agent:607");
    await exhaustFreeCap(workspaceId);
    await pool.query("INSERT INTO agent_allowances (workspace_id, agent_id, monthly_budget_cents, current_spend_cents, updated_at) VALUES ($1, $2, 100, 0, now())", [workspaceId, "agent:607"]);

    const preflight = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: { "Authorization": `Bearer ${accessToken}` },
      data: { public_key: "cHVibGlj", secret_name: "stripe.api_key.prod", purpose: "c", fulfiller_hint: "f" }
    });
    const paymentRequiredHeader = preflight.headers()["payment-required"];
    const paymentDetails = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf8"));
    const option = paymentDetails.accepts[0];

    const paymentId = "pid-607";
    const paymentSignature = Buffer.from(JSON.stringify({
      x402Version: 2, paymentId, scheme: "exact", network: option.network, amount: option.maxAmountRequired, resource: option.resource
    })).toString("base64");

    const payload = { public_key: "cHVibGlj", secret_name: "stripe.api_key.prod", purpose: "c", fulfiller_hint: "f" };

    const firstResponse = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: { "Authorization": `Bearer ${accessToken}`, "payment-identifier": paymentId, "payment-signature": paymentSignature },
      data: payload
    });
    expect(firstResponse.status()).toBe(201);
    const firstJson = await firstResponse.json();

    // Retry
    const secondResponse = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: { "Authorization": `Bearer ${accessToken}`, "payment-identifier": paymentId, "payment-signature": paymentSignature },
      data: payload
    });
    expect(secondResponse.status()).toBe(201);
    const secondJson = await secondResponse.json();
    expect(secondJson.exchange_id).toBe(firstJson.exchange_id);
    
    const paymentResponseHeader = secondResponse.headers()["payment-response"];
    const paymentResponse = JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString("utf8"));
    expect(paymentResponse.cached).toBe(true);

    // Retry with different body
    const thirdResponse = await page.request.post("http://localhost:3100/api/v2/secret/exchange/request", {
      headers: { "Authorization": `Bearer ${accessToken}`, "payment-identifier": paymentId, "payment-signature": paymentSignature },
      data: { ...payload, purpose: "different" }
    });
    expect(thirdResponse.status()).toBe(409);
    expect((await thirdResponse.json()).code).toBe("payment_identifier_conflict");
  });
});
