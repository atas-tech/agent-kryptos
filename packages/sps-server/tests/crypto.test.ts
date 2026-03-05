import { describe, expect, it } from "vitest";
import { generateConfirmationCode, generateRequestId, signPayload, verifyPayload } from "../src/services/crypto.js";

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
});
