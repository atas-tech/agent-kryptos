import { describe, expect, it } from "vitest";
import { AgentSecretRuntime, EXCHANGE_FULFILLMENT_ENVELOPE_KIND, SecretMissingError } from "../src/index.js";

describe("AgentSecretRuntime", () => {
  it("throws SecretMissingError when checking a missing secret", () => {
    const runtime = new AgentSecretRuntime({
      spsBaseUrl: "http://localhost:3100",
      gatewayBearerToken: "token"
    });

    expect(() => runtime.checkSecretOrThrow("missing_key")).toThrowError(SecretMissingError);
    expect(() => runtime.checkSecretOrThrow("missing_key")).toThrowError(
      "Secret 'missing_key' is missing from memory. Use the 'request_secret' tool with 're_request: true' to ask the user to re-enter it."
    );
  });

  it("returns secret if it is present", () => {
    const runtime = new AgentSecretRuntime({
      spsBaseUrl: "http://localhost:3100",
      gatewayBearerToken: "token"
    });

    runtime.store.storeSecret("present_key", Buffer.from("super_secret"));

    const value = runtime.checkSecretOrThrow("present_key");
    expect(value.toString("utf8")).toBe("super_secret");
  });

  it("fails closed when asked to fulfill an exchange without the secret", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v2/secret/exchange/fulfill")) {
        return new Response(
          JSON.stringify({
            exchange_id: "ex-1",
            status: "reserved",
            requester_id: "agent:requester",
            requester_public_key: "cHVibGlj",
            secret_name: "stripe.api_key.prod",
            purpose: "charge-order",
            fulfilled_by: "agent:fulfiller",
            expires_at: 123456
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response("not found", { status: 404 });
    };

    const runtime = new AgentSecretRuntime({
      spsBaseUrl: "http://localhost:3100",
      gatewayBearerToken: "token",
      fetchImpl
    });

    await expect(runtime.fulfillExchange("token-1")).rejects.toThrowError(SecretMissingError);
  });

  it("requires a transport or delivery callback for exchange requests", async () => {
    const runtime = new AgentSecretRuntime({
      spsBaseUrl: "http://localhost:3100",
      gatewayBearerToken: "token"
    });

    await expect(
      runtime.requestAndStoreExchangeSecret({
        secretName: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfillerHint: "agent:payment-bot"
      })
    ).rejects.toThrowError("Either transport or deliverToken must be provided");
  });

  it("delivers a structured fulfillment envelope through the transport interface", async () => {
    let deliveredEnvelope: Record<string, unknown> | null = null;
    let statusCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v2/secret/exchange/request")) {
        return new Response(
          JSON.stringify({
            exchange_id: "ex-transport",
            status: "pending",
            expires_at: Date.now() + 60_000,
            fulfillment_token: "token-transport"
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }

      if (url.endsWith("/api/v2/secret/exchange/status/ex-transport")) {
        statusCalls += 1;
        return new Response(JSON.stringify({ status: statusCalls === 1 ? "pending" : "submitted" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/api/v2/secret/exchange/retrieve/ex-transport")) {
        return new Response("not found", { status: 410 });
      }

      return new Response("not found", { status: 404 });
    };

    const runtime = new AgentSecretRuntime({
      spsBaseUrl: "http://localhost:3100",
      gatewayBearerToken: "token",
      fetchImpl,
      agentId: "agent:crm-bot"
    });

    await expect(
      runtime.requestAndStoreExchangeSecret({
        secretName: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfillerHint: "agent:payment-bot",
        reservedTimeoutMs: 10,
        transport: {
          async deliverFulfillmentToken(envelope) {
            deliveredEnvelope = envelope as unknown as Record<string, unknown>;
          }
        }
      })
    ).rejects.toThrowError("Exchange no longer available");

    expect(deliveredEnvelope).toEqual({
      kind: EXCHANGE_FULFILLMENT_ENVELOPE_KIND,
      exchangeId: "ex-transport",
      requesterId: "agent:crm-bot",
      fulfillerId: "agent:payment-bot",
      secretName: "stripe.api_key.prod",
      purpose: "charge-order",
      fulfillmentToken: "token-transport"
    });
  });

  it("best-effort revokes the exchange when transport delivery fails", async () => {
    let revokeCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v2/secret/exchange/request")) {
        return new Response(
          JSON.stringify({
            exchange_id: "ex-revoke",
            status: "pending",
            expires_at: Date.now() + 60_000,
            fulfillment_token: "token-revoke"
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }

      if (url.endsWith("/api/v2/secret/exchange/revoke/ex-revoke")) {
        revokeCalls += 1;
        expect(init?.method).toBe("DELETE");
        return new Response(JSON.stringify({ status: "revoked" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response("not found", { status: 404 });
    };

    const runtime = new AgentSecretRuntime({
      spsBaseUrl: "http://localhost:3100",
      gatewayBearerToken: "token",
      fetchImpl,
      agentId: "agent:crm-bot"
    });

    await expect(
      runtime.requestAndStoreExchangeSecret({
        secretName: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfillerHint: "agent:payment-bot",
        transport: {
          async deliverFulfillmentToken() {
            throw new Error("runtime transport unavailable");
          }
        }
      })
    ).rejects.toThrowError("runtime transport unavailable");

    expect(revokeCalls).toBe(1);
  });
});
