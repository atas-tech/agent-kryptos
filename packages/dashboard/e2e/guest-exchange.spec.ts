import { expect, test } from "@playwright/test";
import pg from "pg";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

function generateOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

test.describe("Guest Secret Exchange (Phase 3C)", () => {
  const commonPassword = "LongPassword123!";
  const FACILITATOR_PORT = 3101;

  let pool: pg.Pool;
  let mockFacilitator: http.Server;

  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}] ${msg.text()}`);
    });
  });

  test.beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL || "postgresql://blindpass:localdev@127.0.0.1:5433/agent_blindpass",
    });

    // Start mock facilitator
    mockFacilitator = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const payload = body ? JSON.parse(body) : {};
        console.log(`[Facilitator] Received ${req.method} ${req.url}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/verify" && req.method === "POST") {
          res.end(JSON.stringify({
            isValid: true,
            payer: "0x1111222233334444555566667777888899990000"
          }));
        } else if (req.url === "/settle" && req.method === "POST") {
          res.end(JSON.stringify({
            success: true,
            transaction: `0x${(payload.paymentPayload?.payload?.paymentId || '0').padEnd(64, "0").slice(0, 64)}`
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

  test.afterAll(async () => {
    if (pool) await pool.end();
    if (mockFacilitator) {
      await new Promise<void>(resolve => mockFacilitator.close(() => resolve()));
    }
  });

  async function registerAndVerify(page: any) {
    const timestamp = Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 10000);
    const email = `guest-e2e-${timestamp}@example.com`;
    const slug = `guest-ws-${timestamp}`;

    await page.goto("/register");
    await page.getByLabel("Display name").fill("Guest Test Space");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Workspace slug").fill(slug);
    await page.getByLabel("Master password").fill(commonPassword);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: /Create my account/i }).click();

    await expect(page).toHaveURL("/", { timeout: 15000 });
    await pool.query("UPDATE users SET email_verified = true WHERE email = $1", [email]);
    
    const userRes = await pool.query("SELECT id, workspace_id FROM users WHERE email = $1", [email]);
    const workspaceId = userRes.rows[0].workspace_id;
    const userId = userRes.rows[0].id;
    await pool.query("UPDATE workspaces SET owner_user_id = $1 WHERE id = $2", [userId, workspaceId]);

    await page.reload();
    return { email, slug, workspaceId, userId };
  }

  test("Scenario 917: Guest Agent -> Human Fulfill -> Guest Agent Retrieval", async ({ page }) => {
    console.log('1. Starting registerAndVerify...');
    const { workspaceId, slug, userId } = await registerAndVerify(page);
    console.log(`   Workspace created: ${workspaceId} (${slug})`);

    // 1. Create a Public Offer via pool
    console.log('2. Creating public offer via pool...');
    const offerToken = generateOpaqueToken("po");
    const tokenHash = hashOpaqueToken(offerToken);
    
    const offerRes = await pool.query(
      `
        INSERT INTO public_offers (
          workspace_id, created_by_user_id, offer_label, delivery_mode, payment_policy, 
          price_usd_cents, included_free_uses, secret_name, require_approval, 
          token_hash, status, max_uses, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        ) RETURNING id
      `,
      [
        workspaceId, userId, 'E2E Guest Offer', 'human', 'always_x402', 
        5, 0, 'stripe.api_key.prod', false, 
        tokenHash, 'active', 10, new Date(Date.now() + 86400000)
      ]
    );
    const offer = offerRes.rows[0];
    console.log(`   Offer created: ${offer.id} with token ${offerToken}`);

    // 2. Guest Agent initiates Intent
    console.log('3. Initiating guest intent (preflight)...');
    const intentPreflight = await page.request.post("http://localhost:3100/api/v2/public/intents", {
      data: {
        offer_token: offerToken,
        actor_type: "guest_agent",
        public_key: "9YmP4H5/rZ6JmI0FpG8g+Y4Z+6n2D9+o9z5uV4+G7+I=",
        purpose: "Testing guest fulfillment flow",
        requester_label: "test-guest-agent"
      }
    });

    console.log(`   Preflight status: ${intentPreflight.status()}`);
    expect(intentPreflight.status()).toBe(402);
    const paymentRequiredHeader = intentPreflight.headers()["payment-required"];
    const paymentDetails = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf-8"));
    const option = paymentDetails.accepts[0];

    // 3. Pay x402 (Correct v2 format)
    console.log('4. Activating intent with x402 payment...');
    const paymentId = `pid-guest-${Date.now()}`;
    const paymentSignature = Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted: option,
      payload: { 
        paymentId,
        payer: "0x1111222233334444555566667777888899990000",
        signature: "0xmock-signature"
      }
    })).toString("base64");

    const intentActivation = await page.request.post("http://localhost:3100/api/v2/public/intents", {
      headers: {
        "payment-identifier": paymentId,
        "payment-signature": paymentSignature
      },
      data: {
        offer_token: offerToken,
        actor_type: "guest_agent",
        public_key: "9YmP4H5/rZ6JmI0FpG8g+Y4Z+6n2D9+o9z5uV4+G7+I=",
        purpose: "Testing guest fulfillment flow",
        requester_label: "test-guest-agent"
      }
    });

    if (intentActivation.status() !== 201) {
       console.log(`   Activation failed (${intentActivation.status()}):`, await intentActivation.text());
    }
    expect(intentActivation.status()).toBe(201);
    const activationBody = await intentActivation.json();
    const fulfillUrl = activationBody.fulfill_url;
    const guestAccessToken = activationBody.guest_access_token;
    const intentId = activationBody.intent.intent_id;
    console.log(`   Fulfill URL: ${fulfillUrl}`);

    // 4. Human Fulfiller opens fulfillUrl
    console.log('5. Navigating to fulfillUrl...');
    await page.goto(fulfillUrl);
    
    console.log('6. Verifying browser-ui loaded...');
    await expect(page.getByText("Secure Secret Input")).toBeVisible({ timeout: 15000 });
    
    // 5. Submit the secret
    console.log('7. Filling and submitting secret...');
    const testSecret = "top-secret-guest-value";
    await page.getByPlaceholder("Enter a password, token, or API key").fill(testSecret);
    await page.waitForTimeout(500); // Wait for micro-tasks in browser-ui
    await page.getByRole("button", { name: "Encrypt and Submit" }).click();
    
    console.log('8. Waiting for success message...');
    await expect(page.getByText("Secret submitted successfully")).toBeVisible({ timeout: 15000 });

    // 6. Guest Agent retrieves the secret content
    console.log('9. Retrieving secret content as guest agent...');
    const retrieveRes = await page.request.get(`http://localhost:3100/api/v2/public/intents/${intentId}/retrieve`, {
      headers: {
        "Authorization": `Bearer ${guestAccessToken}`
      }
    });

    console.log(`   Retrieval status: ${retrieveRes.status()}`);
    expect(retrieveRes.status()).toBe(200);
    const contentBody = await retrieveRes.json();
    expect(contentBody.enc).toBeDefined();
    expect(contentBody.ciphertext).toBeDefined();
    console.log('✅ Guest Exchange E2E Success!');
  });
});
