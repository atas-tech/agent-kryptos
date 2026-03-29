import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.test" });

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  MailerServiceError
} from "../src/services/mailer.js";

describe("MailerService", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("sends a verification email when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.SPS_EMAIL_FROM = "verify@blindpass.test";
    process.env.SPS_BASE_URL = "https://sps.test";

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "123" }), { status: 200 }));

    const result = await sendVerificationEmail("user@example.com", "ver_token");

    expect(result).toEqual({
      mode: "sent",
      provider: "resend"
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer re_test_key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: "verify@blindpass.test",
        to: ["user@example.com"],
        reply_to: undefined,
        subject: "Verify your BlindPass email",
        html: `<p>Verify your BlindPass email address.</p><p><a href="https://sps.test/api/v2/auth/verify-email/ver_token">Verify email</a></p><p>If you did not request this, you can ignore this email.</p>`,
        text: "Verify your BlindPass email address: https://sps.test/api/v2/auth/verify-email/ver_token\n\nIf you did not request this, you can ignore this email."
      })
    });
  });

  it("sends a password reset email when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.SPS_EMAIL_FROM = "verify@blindpass.test";
    process.env.SPS_UI_BASE_URL = "https://app.test";

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "123" }), { status: 200 }));

    const result = await sendPasswordResetEmail("user@example.com", "rst_token");

    expect(result).toEqual({
      mode: "sent",
      provider: "resend"
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer re_test_key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: "verify@blindpass.test",
        to: ["user@example.com"],
        reply_to: undefined,
        subject: "Reset your BlindPass password",
        html: `<p>Reset your BlindPass password.</p><p><a href="https://app.test/reset-password?token=rst_token">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
        text: "Reset your BlindPass password: https://app.test/reset-password?token=rst_token\n\nIf you did not request this, you can ignore this email."
      })
    });
  });

  it("falls back to local log when RESEND_API_KEY is missing (non-production)", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.NODE_ENV = "test";
    process.env.SPS_LOG_VERIFICATION_URLS = "1";

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await sendVerificationEmail("user@example.com", "ver_token");

    expect(result).toEqual({
      mode: "logged",
      provider: "local-log"
    });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("user@example.com"));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("ver_token"));
  });

  it("throws misconfigured error in production when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.NODE_ENV = "production";

    await expect(sendVerificationEmail("user@example.com", "ver_token"))
      .rejects.toThrow("Transactional email is not configured for this environment");
  });

  it("handles 429 rate limits as retryable error", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.SPS_EMAIL_FROM = "verify@blindpass.test";

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "too many requests" }), { status: 429 }));

    try {
      await sendVerificationEmail("user@example.com", "ver_token");
      throw new Error("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MailerServiceError);
      const mailerError = error as MailerServiceError;
      expect(mailerError.statusCode).toBe(503);
      expect(mailerError.code).toBe("mailer_unavailable");
      expect(mailerError.retryable).toBe(true);
    }
  });

  it("handles 400 bad request as fatal error", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.SPS_EMAIL_FROM = "verify@blindpass.test";

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid bounce" }), { status: 400 }));

    try {
      await sendVerificationEmail("user@example.com", "ver_token");
      throw new Error("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MailerServiceError);
      const mailerError = error as MailerServiceError;
      expect(mailerError.statusCode).toBe(502);
      expect(mailerError.code).toBe("mailer_rejected");
      expect(mailerError.retryable).toBe(false);
    }
  });

  it("handles network failure as retryable error", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.SPS_EMAIL_FROM = "verify@blindpass.test";

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("Network Error"));

    try {
      await sendVerificationEmail("user@example.com", "ver_token");
      throw new Error("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MailerServiceError);
      const mailerError = error as MailerServiceError;
      expect(mailerError.statusCode).toBe(503);
      expect(mailerError.code).toBe("mailer_unavailable");
      expect(mailerError.retryable).toBe(true);
    }
  });
});
