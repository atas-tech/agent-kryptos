import { describe, expect, it } from "vitest";
import { SpsClient } from "../src/sps-client.js";

describe("SpsClient", () => {
  it("requests and polls until submitted", async () => {
    let statusCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v2/secret/request")) {
        return new Response(
          JSON.stringify({
            request_id: "req-1",
            confirmation_code: "BLUE-FOX-42",
            secret_url: "http://localhost/r/req-1"
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }

      if (url.endsWith("/api/v2/secret/status/req-1")) {
        statusCalls += 1;
        const status = statusCalls < 2 ? "pending" : "submitted";
        return new Response(JSON.stringify({ status }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/api/v2/secret/retrieve/req-1")) {
        return new Response(
          JSON.stringify({
            enc: "enc",
            ciphertext: "ct"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response("not found", { status: 404 });
    };

    const client = new SpsClient({
      baseUrl: "http://localhost:3100",
      gatewayBearerToken: "token",
      fetchImpl
    });

    const request = await client.requestSecret({
      description: "API key",
      publicKey: "pub"
    });

    expect(request.requestId).toBe("req-1");

    const poll = await client.pollStatus("req-1", 1, 1000, 500);
    expect(poll.status).toBe("submitted");

    const retrieved = await client.retrieveSecret("req-1");
    expect(retrieved).toEqual({ enc: "enc", ciphertext: "ct" });
  });

  it("times out when never submitted", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/status/")) {
        return new Response(JSON.stringify({ status: "pending" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    };

    const client = new SpsClient({
      baseUrl: "http://localhost:3100",
      gatewayBearerToken: "token",
      fetchImpl
    });

    await expect(client.pollStatus("req-timeout", 1, 5, 5)).rejects.toThrow(
      "User did not provide the secret in time"
    );
  });

  it("supports exchange request / status / retrieve", async () => {
    let statusCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v2/secret/exchange/request")) {
        return new Response(
          JSON.stringify({
            exchange_id: "ex-1",
            status: "pending",
            expires_at: 123456,
            fulfillment_token: "token-1"
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }

      if (url.endsWith("/api/v2/secret/exchange/status/ex-1")) {
        statusCalls += 1;
        const status = statusCalls < 2 ? "pending" : "submitted";
        return new Response(JSON.stringify({ status }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/api/v2/secret/exchange/retrieve/ex-1")) {
        return new Response(
          JSON.stringify({
            enc: "enc",
            ciphertext: "ct",
            secret_name: "stripe.api_key.prod",
            fulfilled_by: "agent:payment-bot"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response("not found", { status: 404 });
    };

    const client = new SpsClient({
      baseUrl: "http://localhost:3100",
      gatewayBearerToken: "token",
      fetchImpl
    });

    const created = await client.createExchangeRequest({
      publicKey: "pub",
      secretName: "stripe.api_key.prod",
      purpose: "charge-order",
      fulfillerHint: "agent:payment-bot"
    });
    expect(created.exchangeId).toBe("ex-1");

    const poll = await client.pollExchangeStatus("ex-1", 1, 1000, 100);
    expect(poll.status).toBe("submitted");

    const retrieved = await client.retrieveExchange("ex-1");
    expect(retrieved).toEqual({
      enc: "enc",
      ciphertext: "ct",
      secretName: "stripe.api_key.prod",
      fulfilledBy: "agent:payment-bot"
    });
  });

  it("fails fast when exchange stays reserved too long", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v2/secret/exchange/status/")) {
        return new Response(JSON.stringify({ status: "reserved" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.includes("/api/v2/secret/exchange/revoke/")) {
        return new Response(JSON.stringify({ status: "revoked" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response("not found", { status: 404 });
    };

    const client = new SpsClient({
      baseUrl: "http://localhost:3100",
      gatewayBearerToken: "token",
      fetchImpl
    });

    await expect(client.pollExchangeStatus("ex-stalled", 1, 1000, 5)).rejects.toThrow(
      "did not complete the exchange in time"
    );
  });
});
