const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export class TurnstileServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface TurnstileVerifyResponse {
  success?: boolean;
  "error-codes"?: string[];
}

function turnstileSecret(): string | null {
  const secret = process.env.SPS_TURNSTILE_SECRET?.trim();
  return secret ? secret : null;
}

export function turnstileEnabled(): boolean {
  return turnstileSecret() !== null;
}

export async function verifyTurnstileToken(token: string | null | undefined, remoteIp?: string | null): Promise<void> {
  const secret = turnstileSecret();
  if (!secret) {
    return;
  }

  const normalizedToken = token?.trim();
  if (!normalizedToken) {
    throw new TurnstileServiceError(400, "turnstile_required", "Human verification is required");
  }

  const form = new URLSearchParams({
    secret,
    response: normalizedToken
  });
  if (remoteIp?.trim()) {
    form.set("remoteip", remoteIp.trim());
  }

  let response: Response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: form
    });
  } catch {
    throw new TurnstileServiceError(502, "turnstile_unavailable", "Human verification service unavailable");
  }

  if (!response.ok) {
    throw new TurnstileServiceError(502, "turnstile_unavailable", "Human verification service unavailable");
  }

  const payload = (await response.json().catch(() => null)) as TurnstileVerifyResponse | null;
  if (payload?.success === true) {
    return;
  }

  throw new TurnstileServiceError(400, "invalid_turnstile", "Human verification failed");
}
