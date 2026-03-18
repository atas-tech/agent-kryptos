import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import { logAudit } from "../services/audit.js";
import type { ExchangePolicyRule, SecretRegistryEntry } from "../services/policy.js";
import {
  getWorkspacePolicy,
  replaceWorkspacePolicy,
  validateWorkspacePolicyDocument,
  WorkspacePolicyServiceError
} from "../services/workspace-policy.js";

export interface WorkspacePolicyRoutesOptions extends FastifyPluginOptions {
  db: Pool;
}

function toWorkspacePolicyResponse(policy: NonNullable<Awaited<ReturnType<typeof getWorkspacePolicy>>>) {
  return {
    policy: {
      id: policy.id,
      workspace_id: policy.workspaceId,
      version: policy.version,
      source: policy.source,
      secret_registry: policy.secretRegistry,
      exchange_policy: policy.exchangePolicyRules,
      updated_by_user_id: policy.updatedByUserId,
      created_at: policy.createdAt.toISOString(),
      updated_at: policy.updatedAt.toISOString()
    }
  };
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkspacePolicyServiceError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      issues: error.issues ?? undefined
    });
  }

  throw error;
}

export async function registerWorkspacePolicyRoutes(
  app: FastifyInstance,
  opts: WorkspacePolicyRoutesOptions
): Promise<void> {
  app.get(
    "/",
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      const policy = await getWorkspacePolicy(opts.db, user.workspaceId);
      if (!policy) {
        return reply.code(404).send({
          error: "Workspace policy not found",
          code: "workspace_policy_not_found"
        });
      }

      return reply.send(toWorkspacePolicyResponse(policy));
    }
  );

  app.post<{
    Body: {
      secret_registry: Array<Record<string, unknown>>;
      exchange_policy: Array<Record<string, unknown>>;
    };
  }>(
    "/validate",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["secret_registry", "exchange_policy"],
          properties: {
            secret_registry: {
              type: "array",
              maxItems: 256,
              items: { type: "object" }
            },
            exchange_policy: {
              type: "array",
              maxItems: 512,
              items: { type: "object" }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_admin")(req, reply);
      if (!user) {
        return;
      }

      const validation = validateWorkspacePolicyDocument({
        secretRegistry: req.body.secret_registry as unknown as SecretRegistryEntry[],
        exchangePolicyRules: req.body.exchange_policy as unknown as ExchangePolicyRule[]
      });

      await logAudit(opts.db, {
        event: "workspace_policy_validated",
        workspaceId: user.workspaceId,
        actorId: user.sub,
        actorType: "user",
        resourceId: `workspace-policy:${user.workspaceId}`,
        metadata: {
          valid: validation.ok,
          issue_count: validation.ok ? 0 : validation.issues.length
        },
        action: "workspace_policy_validate",
        ip: req.ip
      });

      if (!validation.ok) {
        return reply.send({
          valid: false,
          issues: validation.issues
        });
      }

      return reply.send({
        valid: true,
        issues: []
      });
    }
  );

  app.patch<{
    Body: {
      expected_version?: number;
      secret_registry: Array<Record<string, unknown>>;
      exchange_policy: Array<Record<string, unknown>>;
    };
  }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expected_version", "secret_registry", "exchange_policy"],
          properties: {
            expected_version: { type: "integer", minimum: 0 },
            secret_registry: {
              type: "array",
              maxItems: 256,
              items: { type: "object" }
            },
            exchange_policy: {
              type: "array",
              maxItems: 512,
              items: { type: "object" }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_admin")(req, reply);
      if (!user) {
        return;
      }

      try {
        const policy = await replaceWorkspacePolicy(opts.db, user.workspaceId, {
          secretRegistry: req.body.secret_registry as unknown as SecretRegistryEntry[],
          exchangePolicyRules: req.body.exchange_policy as unknown as ExchangePolicyRule[]
        }, {
          expectedVersion: req.body.expected_version,
          updatedByUserId: user.sub,
          source: "manual"
        });

        await logAudit(opts.db, {
          event: "workspace_policy_updated",
          workspaceId: user.workspaceId,
          actorId: user.sub,
          actorType: "user",
          resourceId: policy.id,
          metadata: {
            version: policy.version,
            source: policy.source,
            secret_registry_count: policy.secretRegistry.length,
            exchange_rule_count: policy.exchangePolicyRules.length
          },
          action: "workspace_policy_update",
          ip: req.ip
        });

        return reply.send(toWorkspacePolicyResponse(policy));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );
}
