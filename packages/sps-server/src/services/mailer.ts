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

function emailSupport(): string {
  return process.env.SPS_EMAIL_SUPPORT?.trim() || "support@blindpass.test";
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

function renderBaseTemplate(params: {
  title: string;
  preheader: string;
  bodyContent: string;
  ctaUrl: string;
  ctaText: string;
  footerNotice: string;
}) {
  const supportEmail = emailSupport();
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${params.title}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
    
    body {
      margin: 0;
      padding: 0;
      width: 100% !important;
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
      background-color: #060a14;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }

    .wrapper {
      width: 100%;
      table-layout: fixed;
      background-color: #060a14;
      padding-bottom: 40px;
    }

    .main {
      background-color: #0c1222;
      margin: 0 auto;
      width: 100%;
      max-width: 600px;
      border-spacing: 0;
      color: #f0f4ff;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid rgba(0, 245, 212, 0.1);
    }

    .header {
      padding: 40px 30px 20px;
      text-align: center;
    }

    .content {
      padding: 0 40px 40px;
      line-height: 1.6;
      font-size: 16px;
      text-align: center;
    }

    h1 {
      font-size: 24px;
      font-weight: 800;
      margin: 0 0 20px;
      color: #ffffff;
      letter-spacing: -0.02em;
    }

    p {
      margin: 0 0 20px;
      color: #8892a8;
    }

    .button-container {
      padding: 20px 0 30px;
    }

    .button {
      background: linear-gradient(135deg, #00f5d4 0%, #00b4d8 50%, #7b61ff 100%);
      background-color: #00f5d4; /* Fallback */
      border-radius: 12px;
      color: #060a14 !important;
      display: inline-block;
      font-size: 16px;
      font-weight: 700;
      line-height: 50px;
      text-align: center;
      text-decoration: none;
      width: 240px;
      -webkit-text-size-adjust: none;
      box-shadow: 0 10px 20px rgba(0, 245, 212, 0.2);
    }

    .footer {
      padding: 30px;
      text-align: center;
      font-size: 12px;
      color: #4b5563;
    }

    .footer a {
      color: #00f5d4;
      text-decoration: none;
    }

    .preheader {
      display: none;
      max-height: 0;
      max-width: 0;
      opacity: 0;
      overflow: hidden;
    }
    
    @media screen and (max-width: 600px) {
      .content {
        padding: 0 20px 40px !important;
      }
    }
  </style>
</head>
<body>
  <div class="preheader">${params.preheader}</div>
  <div class="wrapper">
    <table class="main" role="presentation">
      <tr>
        <td class="header">
           <div style="font-size: 28px; font-weight: 900; letter-spacing: -0.05em; color: #ffffff;">
            BLIND<span style="color: #00f5d4;">PASS</span>
           </div>
        </td>
      </tr>
      <tr>
        <td class="content">
          <h1>${params.title}</h1>
          <p>${params.bodyContent}</p>
          <div class="button-container">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${params.ctaUrl}" style="height:50px;v-text-anchor:middle;width:240px;" arcsize="24%" stroke="f" fillcolor="#00f5d4">
              <w:anchorlock/>
              <center>
            <![endif]-->
            <a href="${params.ctaUrl}" class="button">${params.ctaText}</a>
            <!--[if mso]>
              </center>
            </v:roundrect>
            <![endif]-->
          </div>
          <p style="font-size: 14px; margin-top: 20px;">
            ${params.footerNotice}
          </p>
        </td>
      </tr>
      <tr>
        <td class="footer">
          &copy; ${new Date().getFullYear()} BlindPass Ecosystem. All rights reserved.<br>
          Need help? Contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>
  `;
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
  const html = renderBaseTemplate({
    title: "Verify your email",
    preheader: "Confirm your email address to get started with BlindPass.",
    bodyContent: "Welcome to BlindPass. To begin securing your secrets and automating high-assurance workflows, please confirm your email address by clicking the button below.",
    ctaUrl: url,
    ctaText: "Verify Email",
    footerNotice: "If you did not create an account on BlindPass, you can safely ignore this email."
  });

  return sendViaResend({
    to: email,
    subject: "Verify your BlindPass email",
    html,
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
  const html = renderBaseTemplate({
    title: "Reset your password",
    preheader: "Securely reset your BlindPass account password.",
    bodyContent: "We received a request to reset your BlindPass password. Click the button below to choose a new, secure password for your account.",
    ctaUrl: url,
    ctaText: "Reset Password",
    footerNotice: "If you did not request a password reset, your account is secure and you can ignore this email. This link will expire in 1 hour."
  });

  return sendViaResend({
    to: email,
    subject: "Reset your BlindPass password",
    html,
    text: `Reset your BlindPass password: ${url}\n\nIf you did not request this, you can ignore this email.`
  });
}
