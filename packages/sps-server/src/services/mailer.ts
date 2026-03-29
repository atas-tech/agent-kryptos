const RESEND_API_URL = "https://api.resend.com/emails";

export interface MailDeliveryResult {
  mode: "sent" | "logged";
  provider: "resend" | "local-log";
}

export class MailerServiceError extends Error {
  statusCode: number;
  code: string;
  retryable: boolean;

  constructor(statusCode: number, code: string, message: string, retryable = false) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
  }
}

interface MailRequest {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function resendApiKey(): string | null {
  const value = process.env.RESEND_API_KEY?.trim();
  return value ? value : null;
}

function emailFrom(): string | null {
  const value = process.env.SPS_EMAIL_FROM?.trim();
  return value ? value : null;
}

function emailReplyTo(): string | null {
  const value = process.env.SPS_EMAIL_REPLY_TO?.trim();
  return value ? value : null;
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

function isEnvFlagEnabled(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function verificationUrl(token: string): string {
  const baseUrl = process.env.SPS_BASE_URL?.trim() || "http://localhost:3100";
  return `${baseUrl}/api/v2/auth/verify-email/${token}`;
}

function passwordResetUrl(token: string): string {
  const baseUrl = process.env.SPS_UI_BASE_URL?.trim() || "http://localhost:5173";
  return `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

function logVerificationFallback(email: string, token: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  if (!isEnvFlagEnabled("SPS_LOG_VERIFICATION_URLS")) {
    console.info(`Email verification issued for ${email}. Set SPS_LOG_VERIFICATION_URLS=1 to print the verification URL in non-production.`);
    return;
  }

  console.info(`Email verification URL for ${email}: ${verificationUrl(token)}`);
}

function logPasswordResetFallback(email: string, token: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  if (!isEnvFlagEnabled("SPS_LOG_PASSWORD_RESET_URLS")) {
    console.info(`Password reset issued for ${email}. Set SPS_LOG_PASSWORD_RESET_URLS=1 to print the reset URL in non-production.`);
    return;
  }

  console.info(`Password reset URL for ${email}: ${passwordResetUrl(token)}`);
}

async function sendViaResend(input: MailRequest): Promise<MailDeliveryResult> {
  const apiKey = resendApiKey();
  const from = emailFrom();

  if (!apiKey || !from) {
    throw new MailerServiceError(
      500,
      "mailer_misconfigured",
      "Transactional email is not configured for this environment"
    );
  }

  let response: Response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        reply_to: emailReplyTo() ?? undefined,
        subject: input.subject,
        html: input.html,
        text: input.text
      })
    });
  } catch {
    throw new MailerServiceError(503, "mailer_unavailable", "Transactional email service is unavailable", true);
  }

  if (response.ok) {
    return {
      mode: "sent",
      provider: "resend"
    };
  }

  const retryable = response.status === 429 || response.status >= 500;
  throw new MailerServiceError(
    retryable ? 503 : 502,
    retryable ? "mailer_unavailable" : "mailer_rejected",
    retryable ? "Transactional email service is unavailable" : "Transactional email could not be delivered",
    retryable
  );
}

export async function sendVerificationEmail(email: string, token: string): Promise<MailDeliveryResult> {
  const apiKey = resendApiKey();
  if (!apiKey) {
    if (isProductionEnv()) {
      throw new MailerServiceError(500, "mailer_misconfigured", "Transactional email is not configured for this environment");
    }

    logVerificationFallback(email, token);
    return {
      mode: "logged",
      provider: "local-log"
    };
  }

  const url = verificationUrl(token);
  return sendViaResend({
    to: email,
    subject: "Verify your BlindPass email",
    html: `<p>Verify your BlindPass email address.</p><p><a href="${url}">Verify email</a></p><p>If you did not request this, you can ignore this email.</p>`,
    text: `Verify your BlindPass email address: ${url}\n\nIf you did not request this, you can ignore this email.`
  });
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<MailDeliveryResult> {
  const apiKey = resendApiKey();
  if (!apiKey) {
    if (isProductionEnv()) {
      throw new MailerServiceError(500, "mailer_misconfigured", "Transactional email is not configured for this environment");
    }

    logPasswordResetFallback(email, token);
    return {
      mode: "logged",
      provider: "local-log"
    };
  }

  const url = passwordResetUrl(token);
  return sendViaResend({
    to: email,
    subject: "Reset your BlindPass password",
    html: `<p>Reset your BlindPass password.</p><p><a href="${url}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`,
    text: `Reset your BlindPass password: ${url}\n\nIf you did not request this, you can ignore this email.`
  });
}
