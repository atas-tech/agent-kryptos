import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSecretRuntime } from "../src/index.js";
import { buildApp } from "../../sps-server/src/index.js";
import { __resetJwksCacheForTests } from "../../sps-server/src/middleware/auth.js";
import { createGatewayAuthFixture, type GatewayAuthFixture } from "../../sps-server/tests/gateway-auth.fixture.js";

function createInjectFetch(app: Awaited<ReturnType<typeof buildApp>>): typeof fetch {
  return async (input, init) => {
    const requestUrl = new URL(String(input), "http://localhost");
    const headers = new Headers(init?.headers);
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? Buffer.from(init.body).toString("utf8")
          : init?.body
            ? String(init.body)
            : undefined;

    const response = await app.inject({
      method: init?.method ?? "GET",
      url: `${requestUrl.pathname}${requestUrl.search}`,
      headers: Object.fromEntries(headers.entries()),
      payload: bodyText
    });

    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as HeadersInit
    });
  };
}

describe("AgentSecretRuntime exchange flow", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalProviders = process.env.SPS_AGENT_AUTH_PROVIDERS_JSON;
  let authFixture: GatewayAuthFixture;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    authFixture = await createGatewayAuthFixture();
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = JSON.stringify([
      { name: "legacy-gateway", jwks_file: authFixture.jwksPath, issuer: "gateway", audience: "sps" }
    ]);
    __resetJwksCacheForTests();
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = originalProviders;
    __resetJwksCacheForTests();
    await authFixture.cleanup();
  });

  it("completes a requester -> fulfiller exchange over stub transport", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      secretRegistry: [
        {
          secretName: "stripe.api_key.prod",
          classification: "credential"
        }
      ],
      exchangePolicyRules: [
        {
          ruleId: "stripe-prod",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"]
        }
      ]
    });
    const fetchImpl = createInjectFetch(app);

    try {
      const requesterJwt = await authFixture.issueToken({ agentId: "agent:crm-bot" });
      const fulfillerJwt = await authFixture.issueToken({ agentId: "agent:payment-bot" });

      const requester = new AgentSecretRuntime({
        spsBaseUrl: "http://localhost",
        gatewayBearerToken: requesterJwt,
        fetchImpl
      });
      const fulfiller = new AgentSecretRuntime({
        spsBaseUrl: "http://localhost",
        gatewayBearerToken: fulfillerJwt,
        fetchImpl
      });

      fulfiller.store.storeSecret("stripe.api_key.prod", Buffer.from("sk_test_123"));

      const result = await requester.requestAndStoreExchangeSecret({
        secretName: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfillerHint: "agent:payment-bot",
        reservedTimeoutMs: 2000,
        deliverToken: async (fulfillmentToken) => {
          await fulfiller.fulfillExchange(fulfillmentToken);
        }
      });

      expect(result.fulfilledBy).toBe("agent:payment-bot");
      expect(requester.checkSecretOrThrow("stripe.api_key.prod").toString("utf8")).toBe("sk_test_123");
    } finally {
      await app.close();
    }
  });
});
