import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { requireUserAuth, type AuthenticatedUserClaims } from "../middleware/auth.js";
import { rateLimitKeyByIp, sendRateLimited, type RateLimitService } from "../middleware/rate-limit.js";
import {
  authenticateUser,
  changePassword,
  getUserContext,
  logoutSession,
  refreshSession,
  registerUser,
  retriggerEmailVerification,
  UserServiceError,
  verifyEmail
} from "../services/user.js";
import { TurnstileServiceError, verifyTurnstileToken } from "../services/turnstile.js";
import type { AuthResult, UserRecord } from "../services/user.js";
import type { WorkspaceRecord } from "../services/workspace.js";

export interface AuthRoutesOptions extends FastifyPluginOptions {
  db: Pool;
  rateLimitService?: RateLimitService;
}

const REFRESH_COOKIE_NAME = "sps_refresh_token";
const REFRESH_COOKIE_PATH = "/api/v2/auth";

function isHostedModeEnabled(): boolean {
  const raw = process.env.SPS_HOSTED_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const entry of header.split(";")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function requestIsHttps(req: FastifyRequest): boolean {
  if (req.protocol === "https") {
    return true;
  }

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (Array.isArray(forwardedProto)) {
    return forwardedProto.some((value) => value.includes("https"));
  }

  return typeof forwardedProto === "string" && forwardedProto.includes("https");
}

function shouldUseSecureCookies(req: FastifyRequest): boolean {
  return isProductionEnv() || requestIsHttps(req);
}

function authCookieDomain(): string | null {
  const domain = process.env.SPS_AUTH_COOKIE_DOMAIN?.trim();
  return domain ? domain : null;
}

function serializeCookie(name: string, value: string, attributes: {
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  domain?: string | null;
  expires?: Date;
  maxAge?: number;
}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${attributes.path}`);

  if (attributes.domain) {
    parts.push(`Domain=${attributes.domain}`);
  }

  if (attributes.expires) {
    parts.push(`Expires=${attributes.expires.toUTCString()}`);
  }

  if (typeof attributes.maxAge === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(attributes.maxAge))}`);
  }

  if (attributes.httpOnly) {
    parts.push("HttpOnly");
  }

  if (attributes.secure) {
    parts.push("Secure");
  }

  if (attributes.sameSite) {
    parts.push(`SameSite=${attributes.sameSite}`);
  }

  return parts.join("; ");
}

function setRefreshTokenCookie(req: FastifyRequest, reply: FastifyReply, token: string, expiresAtEpochSeconds: number): void {
  if (isHostedModeEnabled() && isProductionEnv() && !shouldUseSecureCookies(req)) {
    throw new UserServiceError(500, "insecure_cookie_config", "Hosted auth requires HTTPS for refresh cookies");
  }

  const maxAge = Math.max(0, expiresAtEpochSeconds - Math.floor(Date.now() / 1000));
  reply.header("Set-Cookie", serializeCookie(REFRESH_COOKIE_NAME, token, {
    path: REFRESH_COOKIE_PATH,
    domain: authCookieDomain(),
    expires: new Date(expiresAtEpochSeconds * 1000),
    maxAge,
    httpOnly: true,
    sameSite: "Strict",
    secure: shouldUseSecureCookies(req)
  }));
}

function clearRefreshTokenCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.header("Set-Cookie", serializeCookie(REFRESH_COOKIE_NAME, "", {
    path: REFRESH_COOKIE_PATH,
    domain: authCookieDomain(),
    expires: new Date(0),
    maxAge: 0,
    httpOnly: true,
    sameSite: "Strict",
    secure: shouldUseSecureCookies(req)
  }));
}

function getRefreshTokenFromRequest(req: FastifyRequest): string | null {
  const cookieHeader = req.headers.cookie;
  const normalizedCookieHeader = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  const cookieToken = parseCookies(normalizedCookieHeader)[REFRESH_COOKIE_NAME];
  if (cookieToken) {
    return cookieToken;
  }

  if (req.body && typeof req.body === "object" && "refresh_token" in req.body) {
    const refreshToken = (req.body as { refresh_token?: unknown }).refresh_token;
    if (typeof refreshToken === "string" && refreshToken.trim()) {
      return refreshToken;
    }
  }

  return null;
}

function userAgentFromHeaders(header: string | string[] | undefined): string | null {
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }

  return header ?? null;
}

function toUserResponse(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    email_verified: user.emailVerified,
    force_password_change: user.forcePasswordChange,
    workspace_id: user.workspaceId,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString()
  };
}

function toWorkspaceResponse(workspace: WorkspaceRecord) {
  return {
    id: workspace.id,
    slug: workspace.slug,
    display_name: workspace.displayName,
    tier: workspace.tier,
    status: workspace.status,
    owner_user_id: workspace.ownerUserId,
    created_at: workspace.createdAt.toISOString(),
    updated_at: workspace.updatedAt.toISOString()
  };
}

function sessionContextForRequest(ip: string, userAgent: string | null) {
  return {
    ipAddress: ip,
    userAgent
  };
}

function buildAuthResponse(
  req: FastifyRequest,
  reply: FastifyReply,
  result: AuthResult
) {
  const payload = {
    access_token: result.tokens.accessToken,
    access_token_expires_at: result.tokens.accessTokenExpiresAt,
    refresh_token_expires_at: result.tokens.refreshTokenExpiresAt,
    user: toUserResponse(result.user),
    workspace: toWorkspaceResponse(result.workspace)
  } as {
    access_token: string;
    access_token_expires_at: number;
    refresh_token?: string;
    refresh_token_expires_at: number;
    user: ReturnType<typeof toUserResponse>;
    workspace: ReturnType<typeof toWorkspaceResponse>;
  };

  if (isHostedModeEnabled()) {
    setRefreshTokenCookie(req, reply, result.tokens.refreshToken, result.tokens.refreshTokenExpiresAt);
    return payload;
  }

  payload.refresh_token = result.tokens.refreshToken;
  return payload;
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof UserServiceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }

  if (error instanceof TurnstileServiceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }

  if (error instanceof Error && (
    error.message.includes("slug") ||
    error.message.includes("displayName") ||
    error.message.includes("blank")
  )) {
    return reply.code(400).send({ error: error.message, code: "invalid_input" });
  }

  throw error;
}

async function requireCurrentUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUserClaims | null> {
  return requireUserAuth(req, reply, { allowForcePasswordChange: true });
}

export async function registerAuthRoutes(app: FastifyInstance, opts: AuthRoutesOptions): Promise<void> {
  app.post<{ Body: { email: string; password: string; workspace_slug: string; display_name: string; cf_turnstile_response?: string } }>(
    "/register",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password", "workspace_slug", "display_name"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 320 },
            password: { type: "string", minLength: 8, maxLength: 200 },
            workspace_slug: { type: "string", minLength: 3, maxLength: 40 },
            display_name: { type: "string", minLength: 1, maxLength: 160 },
            cf_turnstile_response: { type: "string", minLength: 1, maxLength: 4096 }
          }
        }
      }
    },
    async (req, reply) => {
      if (opts.rateLimitService) {
        const limit = Number(process.env.SPS_AUTH_REGISTRATION_LIMIT) || 3;
        const rateLimit = await opts.rateLimitService.consume(rateLimitKeyByIp(req, "auth:register"), limit, 60_000);
        if (!rateLimit.allowed) {
          return sendRateLimited(reply, rateLimit, "Too many registration attempts");
        }
      }

      try {
        await verifyTurnstileToken(req.body.cf_turnstile_response, req.ip);
        const result = await registerUser(
          opts.db,
          req.body.email,
          req.body.password,
          req.body.workspace_slug,
          req.body.display_name,
          sessionContextForRequest(req.ip, userAgentFromHeaders(req.headers["user-agent"]))
        );

        return reply.code(201).send(buildAuthResponse(req, reply, result));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.post<{ Body: { email: string; password: string; cf_turnstile_response?: string } }>(
    "/login",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 320 },
            password: { type: "string", minLength: 1, maxLength: 200 },
            cf_turnstile_response: { type: "string", minLength: 1, maxLength: 4096 }
          }
        }
      }
    },
    async (req, reply) => {
      if (opts.rateLimitService) {
        const limit = Number(process.env.SPS_AUTH_LOGIN_LIMIT) || 10;
        const rateLimit = await opts.rateLimitService.consume(rateLimitKeyByIp(req, "auth:login"), limit, 60_000);
        if (!rateLimit.allowed) {
          return sendRateLimited(reply, rateLimit, "Too many login attempts");
        }
      }

      try {
        await verifyTurnstileToken(req.body.cf_turnstile_response, req.ip);
        const result = await authenticateUser(
          opts.db,
          req.body.email,
          req.body.password,
          sessionContextForRequest(req.ip, userAgentFromHeaders(req.headers["user-agent"]))
        );

        return reply.send(buildAuthResponse(req, reply, result));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.post<{ Body: { refresh_token?: string } }>(
    "/refresh",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            refresh_token: { type: "string", minLength: 20, maxLength: 4096 }
          }
        }
      }
    },
    async (req, reply) => {
      try {
        const refreshToken = getRefreshTokenFromRequest(req);
        if (!refreshToken) {
          clearRefreshTokenCookie(req, reply);
          return reply.code(401).send({ error: "Invalid refresh token", code: "invalid_refresh_token" });
        }

        const result = await refreshSession(
          opts.db,
          refreshToken,
          sessionContextForRequest(req.ip, userAgentFromHeaders(req.headers["user-agent"]))
        );

        return reply.send(buildAuthResponse(req, reply, result));
      } catch (error) {
        if (error instanceof UserServiceError && error.code === "invalid_refresh_token") {
          clearRefreshTokenCookie(req, reply);
        }
        return sendServiceError(reply, error);
      }
    }
  );

  app.post("/logout", async (req, reply) => {
    const currentUser = await requireCurrentUser(req, reply);
    if (!currentUser) {
      clearRefreshTokenCookie(req, reply);
      return;
    }

    if (!currentUser.sid) {
      clearRefreshTokenCookie(req, reply);
      return reply.code(401).send({ error: "Session id missing from token", code: "invalid_token" });
    }

    await logoutSession(opts.db, currentUser.sub, currentUser.workspaceId, currentUser.sid);
    clearRefreshTokenCookie(req, reply);
    return reply.code(204).send();
  });

  app.post<{ Body: { current_password: string; next_password: string } }>(
    "/change-password",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["current_password", "next_password"],
          properties: {
            current_password: { type: "string", minLength: 1, maxLength: 200 },
            next_password: { type: "string", minLength: 8, maxLength: 200 }
          }
        }
      }
    },
    async (req, reply) => {
      const currentUser = await requireCurrentUser(req, reply);
      if (!currentUser) {
        return;
      }

      if (!currentUser.sid) {
        return reply.code(401).send({ error: "Session id missing from token", code: "invalid_token" });
      }

      try {
        const result = await changePassword(
          opts.db,
          currentUser.sub,
          currentUser.workspaceId,
          req.body.current_password,
          req.body.next_password,
          currentUser.sid
        );

        return reply.send({
          access_token: result.accessToken,
          access_token_expires_at: result.accessTokenExpiresAt,
          user: toUserResponse(result.user)
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.get<{ Params: { token: string } }>("/verify-email/:token", async (req, reply) => {
    try {
      const result = await verifyEmail(opts.db, req.params.token);
      return reply.send({
        user: toUserResponse(result.user),
        workspace: toWorkspaceResponse(result.workspace)
      });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post("/retrigger-verification", async (req, reply) => {
    const currentUser = await requireCurrentUser(req, reply);
    if (!currentUser) {
      return;
    }

    try {
      await retriggerEmailVerification(opts.db, currentUser.sub);
      return reply.code(200).send({ message: "Verification email re-triggered" });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get("/me", async (req, reply) => {
    const currentUser = await requireCurrentUser(req, reply);
    if (!currentUser) {
      return;
    }

    const context = await getUserContext(opts.db, currentUser.sub);
    if (!context) {
      return reply.code(404).send({ error: "User not found", code: "user_not_found" });
    }

    return reply.send({
      user: toUserResponse(context.user),
      workspace: toWorkspaceResponse(context.workspace)
    });
  });
}
