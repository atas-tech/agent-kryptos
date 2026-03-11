import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../packages/sps-server/dist/index.js";
import { issueJwt, loadOrCreateGatewayIdentity, writeJwksFile } from "../packages/gateway/dist/identity.js";
import { requestExchangeFlow, fulfillExchangeFlow } from "../packages/openclaw-plugin/sps-bridge.mjs";

async function runDemo() {
  process.env.NODE_ENV = "test";
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "sps-a2a-demo-"));
  const keyPath = path.join(tempDir, "gateway-key.json");
  const jwksPath = path.join(tempDir, "jwks.json");
  const identity = await loadOrCreateGatewayIdentity({ keyPath });
  await writeJwksFile(identity, jwksPath);
  
  // Set the JWKS file so the local SPS server trusts our minted JWTs
  process.env.SPS_GATEWAY_JWKS_FILE = jwksPath;

  const app = await buildApp({
    useInMemoryStore: true,
    hmacSecret: "demo-a2a-hmac-secret",
    // baseUrl is passed after app starts if needed
    secretRegistry: [{
      secretName: "stripe.api_key.prod",
      classification: "high"
    }],
    exchangePolicyRules: [{
      ruleId: "demo-a2a-rule",
      secretName: "stripe.api_key.prod",
      requesterIds: ["agent-b"],
      fulfillerIds: ["agent-a"],
      mode: "allow"
    }]
  });

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = address;


  let passedFulfillmentToken = null;
  let passedExchangeEnvelope = null;

  // Mock transport where agent-b sends the token to agent-a
  const mockTransport = {
    deliverFulfillmentToken: async (envelope) => {
      console.log(`\n[Transport] agent-b sends fulfillment token to ${envelope.fulfillerId}`);
      console.log(`[Transport] Envelope:`, envelope);
      passedFulfillmentToken = envelope.fulfillmentToken;
      passedExchangeEnvelope = envelope;
    }
  };



  try {
    console.log("\n--- Starting Phase 2B A2A Demo ---");

    // We start Agent B (requester) in the background so it waits for fulfillment
    const requesterPromise = requestExchangeFlow({
      secretName: "stripe.api_key.prod",
      purpose: "charge-customer-order",
      fulfillerId: "agent-a",
      transport: mockTransport,
      spsBaseUrl: baseUrl,
      agentId: "agent-b",
      identityOptions: { keyPath }
    });

    // Wait for the transport to pick up the token
    while (!passedFulfillmentToken) {
      await new Promise(r => setTimeout(r, 100));
    }

    // Now Agent A (fulfiller) receives the token and fulfills it
    console.log("\n[Agent A] Fulfilling exchange...");
    const fulfillResult = await fulfillExchangeFlow({
      fulfillmentToken: passedFulfillmentToken,
      resolveSecret: async (name) => {
        console.log(`[Agent A] Resolving local secret for ${name}...`);
        if (name === "stripe.api_key.prod") {
          return "sk_test_demo123456789";
        }
        return null; // Not found
      },
      spsBaseUrl: baseUrl,
      agentId: "agent-a",
      identityOptions: { keyPath }
    });

    console.log("[Agent A] Fulfillment successful:", fulfillResult);

    // Now Agent B finishes requesting and gets the decrypted secret
    const requesterResult = await requesterPromise;
    console.log("\n[Agent B] Exchange retrieved!");
    console.log(`[Agent B] Decrypted secret: ${requesterResult.secret.toString('utf8')}`);

    if (requesterResult.secret.toString('utf8') !== "sk_test_demo123456789") {
      throw new Error("Secret mismatch!");
    }

    console.log("\nDemo completed successfully.");
  } finally {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

runDemo().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
