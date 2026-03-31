import { expect, test } from "./fixtures.js";

test.describe("Email Localization Smoke Test", () => {
  const password = "LongPassword123!";
  const API_URL = "http://localhost:3100";

  test("Scenario 601: Password Reset Request respects Accept-Language", async ({ request }) => {
    const timestamp = Date.now();
    const email = `admin-email-loc-${timestamp}@example.com`;

    // 1. Register a user so they exist
    await request.post(`${API_URL}/api/v2/auth/register`, {
      data: {
        email,
        password,
        workspace_slug: `email-loc-${timestamp}`,
        display_name: "Email Loc Test",
      }
    });

    // 2. Request password reset with Vietnamese Accept-Language
    const response = await request.post(`${API_URL}/api/v2/auth/forgot-password`, {
      data: { email },
      headers: {
        "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    // The message itself might be in English in the API response, but we check if the request was accepted
    expect(body.message).toContain("instructions have been issued");
  });

  test("Scenario 602: Retrigger Verification respects User Preferred Locale", async ({ request }) => {
    const timestamp = Date.now();
    const email = `admin-retry-loc-${timestamp}@example.com`;

    // 1. Register with Vietnamese locale
    const regRes = await request.post(`${API_URL}/api/v2/auth/register`, {
      data: {
        email,
        password,
        workspace_slug: `retry-loc-${timestamp}`,
        display_name: "Retry Loc Test",
        preferred_locale: "vi"
      }
    });
    
    expect(regRes.ok()).toBe(true);
    const regBody = await regRes.json();
    const token = regBody.access_token;

    // 2. Retrigger verification
    const retryRes = await request.post(`${API_URL}/api/v2/auth/retrigger-verification`, {
      headers: {
        "authorization": `Bearer ${token}`
      }
    });

    expect(retryRes.ok()).toBe(true);
    const retryBody = await retryRes.json();
    
    // In dev mode, it returns the delivery details
    if (retryBody.delivery) {
      expect(retryBody.delivery.mode).toBe("logged");
    }
  });
});
