import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";
import http from "node:http";
import type { Pool } from "pg";

test.describe("x402 Payments (Milestone 6)", () => {
  const FACILITATOR_PORT = 3101;

  let mockFacilitator: http.Server;
  let facilitatorVerifyCalls: any[] = [];
  let facilitatorSettleCalls: any[] = [];
  let settleGate: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    // Attempt non-interactive kill
    // No easy way here without spawn, so we rely on the command line cleanup or mock error handling.
    mockFacilitator = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch (e) { /* ignore */ }
        
        if (req.url === "/verify" && req.method === "POST") {
          facilitatorVerifyCalls.push(payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            isValid: true,
            scheme: "exact",
            networkId: (payload as any).paymentPayload?.network,
            payer: (payload as any).paymentPayload?.payer
          }));
        } else if (req.url === "/settle" && req.method === "POST") {
          facilitatorSettleCalls.push(payload);
          if (settleGate) { await settleGate(); }
          
          const pid = (payload as any).paymentId || (payload as any).paymentPayload?.payload?.paymentId || "0x-def-pid";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            transaction: `0x${pid.padEnd(64, "0").slice(0, 64)}`
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      mockFacilitator.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          // Instead of force-killing inside the test (which requires shell access and can be flaky),
          // we warn and assume the existing one is compatible. In serial CI mode, this handles
          // leftovers from previous runs.
          console.warn(`[x402 setup] Port ${FACILITATOR_PORT} is in use. Attempting to proceed with existing listener.`);
          resolve();
        } else {
          reject(err);
        }
      });
      mockFacilitator.listen(FACILITATOR_PORT, "127.0.0.1", () => resolve());
    });
  });

  test.beforeEach(async () => {
    facilitatorVerifyCalls = [];
    facilitatorSettleCalls = [];
    settleGate = null;
  });

  test.afterAll(async () => {
    if (mockFacilitator && mockFacilitator.listening) {
      await new Promise<void>(resolve => mockFacilitator.close(() => resolve()));
    }
  });

  async function getAgentToken(page: any, apiKey: string) {
    const response = await page.request.post("http://127.0.0.1:3100/api/v2/agents/token", {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    expect(response.status(), "Failed to get agent token").toBe(200);
    const { access_token } = await response.json();
    return access_token;
  }

  async function exhaustFreeCap(db: Pool, workspaceId: string, used = 11) { // Set to 11 to exceed 10 cap
    const now = new Date();
    const usageMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const result = await db.query(`
      INSERT INTO workspace_exchange_usage (workspace_id, usage_month, free_exchange_used, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (workspace_id, usage_month) DO UPDATE SET free_exchange_used = EXCLUDED.free_exchange_used, updated_at = now()
    `, [workspaceId, usageMonth, used]);
    if (result.rowCount === 0) {
       console.error(`[exhaustFreeCap] No rows affected for workspace ${workspaceId}`);
    }
  }

  test("Scenario 601: Free-tier workspace hits 402 after monthly free cap", async ({ page, db }) => {
    const agentId = "agent-601";
    const { workspaceId, agents } = await setupWorkspace(page, "x402-601", "workspace_admin", [agentId], "/", 11);
    const accessToken = await getAgentToken(page, agents[agentId]);

    const response = await page.request.post("http://127.0.0.1:3100/api/v2/secret/exchange/request", {
      headers: { "Authorization": `Bearer ${accessToken}` },
      data: {
        public_key: "cHVibGljLWtleS1kYXRh",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-customer-order",
        fulfiller_hint: "agent:601-fulfiller"
      }
    });

    if (response.status() !== 402) {
      const body = await response.text();
      console.error(`[x402-601] Expected 402 but got ${response.status()}: ${body}`);
    }
    expect(response.status()).toBe(402);
  });

  test("Scenario 605: Successful payment verification and settlement", async ({ page, db }) => {
    const agentId = "agent-605";
    const { workspaceId, agents } = await setupWorkspace(page, "x402-605", "workspace_admin", [agentId], "/billing", 10);
    const accessToken = await getAgentToken(page, agents[agentId]);
    
    const quota = page.getByTestId("quota-exchange-requests").getByTestId("quota-value");
    await expect(quota.filter({ hasText: "10/10" }).or(quota.filter({ hasText: "11/10" }))).toBeVisible({ timeout: 15000 });

    // Set allowance via dashboard
    await page.getByTestId("billing-agent-select").selectOption(agentId);
    await page.getByTestId("billing-budget-input").fill("50");
    
    await Promise.all([
      page.waitForResponse(res => res.url().includes("/api/v2/billing/allowances") && res.request().method() === "POST"),
      page.getByTestId("billing-save-allowance").click()
    ]);
    
    // Check record in list
    const record = page.locator("tr").filter({ hasText: agentId });
    await expect(record).toBeVisible({ timeout: 15000 });
    await expect(record).toContainText("$0.50");

    const data = { public_key: "cHVibGlj", secret_name: "stripe.api_key.prod", purpose: "charge", fulfiller_hint: "f" };

    const preflight = await page.request.post("http://127.0.0.1:3100/api/v2/secret/exchange/request", {
      headers: { "Authorization": `Bearer ${accessToken}` },
      data
    });
    expect(preflight.status()).toBe(402);
    
    // Playwright lowercases header names
    const paymentRequiredHeader = preflight.headers()["payment-required"];
    if (!paymentRequiredHeader) {
      console.error("[x402-605] Missing payment-required header. Headers found:", preflight.headers());
    }
    expect(paymentRequiredHeader).toBeDefined();

    const paymentDetails = JSON.parse(Buffer.from(paymentRequiredHeader!, "base64").toString("utf8"));
    const option = paymentDetails.accepts[0];

    const paymentId = `pid-605-${Date.now()}`;
    const paymentSignature = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: option,
      payload: { paymentId, _ts: Date.now() },
      resource: paymentDetails.resource
    })).toString("base64");

    const paidAttempt = await page.request.post("http://127.0.0.1:3100/api/v2/secret/exchange/request", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "payment-identifier": paymentId,
        "payment-signature": paymentSignature
      },
      data
    });

    if (paidAttempt.status() !== 201) {
      const body = await paidAttempt.text();
      const status = paidAttempt.status();
      console.error(`[x402-605] paidAttempt failed with status ${status}. Body:`, body);
      // Fail early with clear message if payment fails in SPS
      expect(status, `Exchange request failed after payment: ${body}`).toBe(201);
    }

    expect(paidAttempt.status()).toBe(201);
    expect(facilitatorVerifyCalls.length).toBe(1);
    expect(facilitatorSettleCalls.length).toBe(1);

    // Verify in dashboard ledger with polling/retries as record might take time to propagate
    let found = false;
    for (let i = 0; i < 6; i++) {
      console.log(`[E2E] Checking ledger (attempt ${i + 1}/6)...`);
      await page.reload({ waitUntil: "networkidle" });
      
      const ledgerRow = page.locator("tr").filter({
        has: page.getByTestId("ledger-agent-id").filter({ hasText: agentId })
      });

      if (await ledgerRow.isVisible()) {
        const hasSettledText = await ledgerRow.getByTestId("ledger-status-badge").innerText();
        if (hasSettledText.toLowerCase().includes("settled")) {
          found = true;
          break;
        }
      }
      
      console.log(`[E2E] Ledger row for ${agentId} not found yet. Waiting 3s...`);
      await page.waitForTimeout(3000);
    }

    if (!found) {
      const allIds = await page.getByTestId("ledger-agent-id").allTextContents();
      console.log("[E2E] Visible ledger agent IDs:", allIds);
    }

    expect(found, `Ledger record for agent ${agentId} did not appear after 30s`).toBe(true);
  });

});
