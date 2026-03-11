import { describe, expect, it } from "vitest";
import { AgentSecretRuntime, SecretMissingError } from "../src/index.js";

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
});
