import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import {
  authenticateAgentApiKey,
  AgentServiceError,
  countActiveAgents,
  enrollAgent,
  listAgents,
  mintAgentAccessToken,
  revokeAgent,
  rotateAgentApiKey,
  type EnrolledAgentRecord
} from "../services/agent.js";
import { activeAgentLimit } from "../services/quota.js";
import { ensureWorkspaceOwnerVerified, UserServiceError } from "../services/user.js";
import { getWorkspace } from "../services/workspace.js";

const AGENT_ID_PATTERN = "^[A-Za-z0-9._:@-]{1,160}$";

export interface AgentRoutesOptions extends FastifyPluginOptions {
  db: Pool;
}

class FixedWindowRateLimiter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  consume(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const current = this.counts.get(key);

    if (!current || current.resetAt <= now) {
      this.counts.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
      };
    }

    current.count += 1;
    this.counts.set(key, current);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

const tokenRateLimiter = new FixedWindowRateLimiter();

function toAgentResponse(agent: EnrolledAgentRecord) {
  return {
    id: agent.id,
    workspace_id: agent.workspaceId,
    agent_id: agent.agentId,
    display_name: agent.displayName,
    status: agent.status,
    created_at: agent.createdAt.toISOString(),
    revoked_at: agent.revokedAt?.toISOString() ?? null
  };
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentServiceError || error instanceof UserServiceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }

  throw error;
}

function agentApiKeyFromRequest(headers: Record<string, unknown>): string | null {
  const authHeader = headers.authorization;
  if (typeof authHeader === "string") {
    const [scheme, token] = authHeader.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token?.trim()) {
      return token.trim();
    }
  }

  const headerKey = headers["x-agent-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) {
    return headerKey.trim();
  }

  return null;
}

export async function registerAgentRoutes(app: FastifyInstance, opts: AgentRoutesOptions): Promise<void> {
  app.post<{ Body: { agent_id: string; display_name?: string } }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["agent_id"],
          properties: {
            agent_id: { type: "string", pattern: AGENT_ID_PATTERN },
            display_name: { type: "string", minLength: 1, maxLength: 160 }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      try {
        await ensureWorkspaceOwnerVerified(opts.db, user.workspaceId);
        const workspace = await getWorkspace(opts.db, user.workspaceId, { activeOnly: true });
        if (!workspace) {
          return reply.code(404).send({ error: "Workspace not found", code: "workspace_not_found" });
        }

        const activeAgents = await countActiveAgents(opts.db, user.workspaceId);
        const limit = activeAgentLimit(workspace.tier);
        if (activeAgents >= limit) {
          return reply.code(429).send({
            error: "Agent quota exceeded",
            code: "quota_exceeded",
            limit,
            used: activeAgents
          });
        }

        const result = await enrollAgent(opts.db, user.workspaceId, req.body.agent_id, req.body.display_name);
        return reply.code(201).send({
          agent: toAgentResponse(result.agent),
          bootstrap_api_key: result.apiKey
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.get("/", async (req, reply) => {
    const user = await requireUserRole("workspace_operator")(req, reply);
    if (!user) {
      return;
    }

    const agents = await listAgents(opts.db, user.workspaceId);
    return reply.send({ agents: agents.map(toAgentResponse) });
  });

  app.post("/token", async (req, reply) => {
    const rateLimitKey = req.ip || "unknown";
    const rateLimit = tokenRateLimiter.consume(rateLimitKey, 5, 60_000);
    if (!rateLimit.allowed) {
      return reply.code(429).send({
        error: "Too many token requests",
        code: "rate_limited",
        retry_after_seconds: rateLimit.retryAfterSeconds
      });
    }

    const apiKey = agentApiKeyFromRequest(req.headers as Record<string, unknown>);
    if (!apiKey) {
      return reply.code(401).send({ error: "Missing agent API key", code: "missing_api_key" });
    }

    try {
      const agent = await authenticateAgentApiKey(opts.db, apiKey);
      const token = await mintAgentAccessToken(agent);
      return reply.send({
        access_token: token.accessToken,
        access_token_expires_at: token.accessTokenExpiresAt,
        agent: toAgentResponse(token.agent)
      });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{ Params: { aid: string } }>(
    "/:aid/rotate-key",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["aid"],
          properties: {
            aid: { type: "string", pattern: AGENT_ID_PATTERN }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      try {
        await ensureWorkspaceOwnerVerified(opts.db, user.workspaceId);
        const result = await rotateAgentApiKey(opts.db, user.workspaceId, req.params.aid);
        return reply.send({
          agent: toAgentResponse(result.agent),
          bootstrap_api_key: result.apiKey
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.delete<{ Params: { aid: string } }>(
    "/:aid",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["aid"],
          properties: {
            aid: { type: "string", pattern: AGENT_ID_PATTERN }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      try {
        await ensureWorkspaceOwnerVerified(opts.db, user.workspaceId);
        const agent = await revokeAgent(opts.db, user.workspaceId, req.params.aid);
        return reply.send({ agent: toAgentResponse(agent) });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );
}
