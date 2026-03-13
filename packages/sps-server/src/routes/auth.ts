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
  UserServiceError,
  verifyEmail
} from "../services/user.js";
import type { UserRecord } from "../services/user.js";
import type { WorkspaceRecord } from "../services/workspace.js";

export interface AuthRoutesOptions extends FastifyPluginOptions {
  db: Pool;
  rateLimitService?: RateLimitService;
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

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof UserServiceError) {
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
  app.post<{ Body: { email: string; password: string; workspace_slug: string; display_name: string } }>(
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
            display_name: { type: "string", minLength: 1, maxLength: 160 }
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
        const result = await registerUser(
          opts.db,
          req.body.email,
          req.body.password,
          req.body.workspace_slug,
          req.body.display_name,
          sessionContextForRequest(req.ip, userAgentFromHeaders(req.headers["user-agent"]))
        );

        return reply.code(201).send({
          access_token: result.tokens.accessToken,
          refresh_token: result.tokens.refreshToken,
          access_token_expires_at: result.tokens.accessTokenExpiresAt,
          refresh_token_expires_at: result.tokens.refreshTokenExpiresAt,
          user: toUserResponse(result.user),
          workspace: toWorkspaceResponse(result.workspace)
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.post<{ Body: { email: string; password: string } }>(
    "/login",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 320 },
            password: { type: "string", minLength: 1, maxLength: 200 }
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
        const result = await authenticateUser(
          opts.db,
          req.body.email,
          req.body.password,
          sessionContextForRequest(req.ip, userAgentFromHeaders(req.headers["user-agent"]))
        );

        return reply.send({
          access_token: result.tokens.accessToken,
          refresh_token: result.tokens.refreshToken,
          access_token_expires_at: result.tokens.accessTokenExpiresAt,
          refresh_token_expires_at: result.tokens.refreshTokenExpiresAt,
          user: toUserResponse(result.user),
          workspace: toWorkspaceResponse(result.workspace)
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.post<{ Body: { refresh_token: string } }>(
    "/refresh",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["refresh_token"],
          properties: {
            refresh_token: { type: "string", minLength: 20, maxLength: 4096 }
          }
        }
      }
    },
    async (req, reply) => {
      try {
        const result = await refreshSession(
          opts.db,
          req.body.refresh_token,
          sessionContextForRequest(req.ip, userAgentFromHeaders(req.headers["user-agent"]))
        );

        return reply.send({
          access_token: result.tokens.accessToken,
          refresh_token: result.tokens.refreshToken,
          access_token_expires_at: result.tokens.accessTokenExpiresAt,
          refresh_token_expires_at: result.tokens.refreshTokenExpiresAt,
          user: toUserResponse(result.user),
          workspace: toWorkspaceResponse(result.workspace)
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.post("/logout", async (req, reply) => {
    const currentUser = await requireCurrentUser(req, reply);
    if (!currentUser) {
      return;
    }

    if (!currentUser.sid) {
      return reply.code(401).send({ error: "Session id missing from token", code: "invalid_token" });
    }

    await logoutSession(opts.db, currentUser.sub, currentUser.workspaceId, currentUser.sid);
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
