import { describe, expect, it } from "vitest";
import {
  generateConfirmationCode,
  generateRequestId,
  signGuestFulfillmentToken,
  signFulfillmentToken,
  signPayload,
  verifyFulfillmentToken,
  verifyPayload
} from "../src/services/crypto.js";

describe("crypto", () => {
  it("generates request ids", () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
  });

  it("generates confirmation code format", () => {
    expect(generateConfirmationCode()).toMatch(/^[A-Z]+-[A-Z]+-\d{2}$/);
  });

  it("signs and verifies payload", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signPayload(
      {
        requestId: "abc",
        exp: now + 30,
        scope: "metadata"
      },
      "secret"
    );

    expect(verifyPayload("abc", "metadata", token, "secret", now)).toEqual({ ok: true, exp: now + 30 });
    expect(verifyPayload("abc", "submit", token, "secret", now)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyPayload("abc", "metadata", token, "wrong", now)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects payload signatures with malformed or truncated lengths", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signPayload(
      {
        requestId: "abc",
        exp: now + 30,
        scope: "metadata"
      },
      "secret"
    );

    const [exp, signature] = token.split(".");
    expect(signature).toBeDefined();

    expect(verifyPayload("abc", "metadata", `${exp}.${signature!.slice(0, -1)}`, "secret", now)).toEqual({
      ok: false,
      reason: "invalid"
    });
    expect(verifyPayload("abc", "metadata", `${exp}.${signature!}x`, "secret", now)).toEqual({
      ok: false,
      reason: "invalid"
    });
  });

  it("signs and verifies fulfillment tokens", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const token = await signFulfillmentToken(
      {
        exchange_id: "a".repeat(64),
        requester_id: "agent:requester",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        policy_hash: "b".repeat(64),
        approval_reference: null
      },
      "secret",
      expiresAt
    );

    await expect(verifyFulfillmentToken(token, "secret")).resolves.toEqual({
      exchange_id: "a".repeat(64),
      requester_id: "agent:requester",
      secret_name: "stripe.api_key.prod",
      purpose: "charge-order",
      policy_hash: "b".repeat(64),
      approval_reference: null,
      tokenKind: "agent"
    });

    await expect(verifyFulfillmentToken(token, "wrong")).rejects.toThrow();
  });

  it("verifies guest fulfillment tokens with a distinct signing domain", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const token = await signGuestFulfillmentToken(
      {
        exchange_id: "c".repeat(64),
        requester_id: "guest-intent:intent-1",
        workspace_id: "ws-1",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        policy_hash: "d".repeat(64),
        approval_reference: "apr_123"
      },
      "secret",
      expiresAt
    );

    await expect(verifyFulfillmentToken(token, "secret")).resolves.toEqual({
      exchange_id: "c".repeat(64),
      requester_id: "guest-intent:intent-1",
      workspace_id: "ws-1",
      secret_name: "stripe.api_key.prod",
      purpose: "charge-order",
      policy_hash: "d".repeat(64),
      approval_reference: "apr_123",
      tokenKind: "guest"
    });
  });
});
