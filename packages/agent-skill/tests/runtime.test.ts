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
});
