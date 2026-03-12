import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import { isUserRole } from "../services/rbac.js";
import {
  createWorkspaceMember,
  ensureWorkspaceOwnerVerified,
  listWorkspaceUsers,
  updateWorkspaceMember,
  UserServiceError,
  type UserRecord
} from "../services/user.js";

export interface MemberRoutesOptions extends FastifyPluginOptions {
  db: Pool;
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

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof UserServiceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }

  throw error;
}

export async function registerMemberRoutes(app: FastifyInstance, opts: MemberRoutesOptions): Promise<void> {
  app.get("/", async (req, reply) => {
    const user = await requireUserRole("workspace_admin")(req, reply);
    if (!user) {
      return;
    }

    const members = await listWorkspaceUsers(opts.db, user.workspaceId);
    return reply.send({ members: members.map(toUserResponse) });
  });

  app.post<{ Body: { email: string; temporary_password: string; role: string } }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "temporary_password", "role"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 320 },
            temporary_password: { type: "string", minLength: 12, maxLength: 200 },
            role: {
              type: "string",
              enum: ["workspace_admin", "workspace_operator", "workspace_viewer"]
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

      if (!isUserRole(req.body.role)) {
        return reply.code(400).send({ error: "Invalid user role", code: "invalid_role" });
      }

      try {
        await ensureWorkspaceOwnerVerified(opts.db, user.workspaceId);
        const member = await createWorkspaceMember(opts.db, user.workspaceId, {
          email: req.body.email,
          temporaryPassword: req.body.temporary_password,
          role: req.body.role
        });

        return reply.code(201).send({ member: toUserResponse(member) });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.patch<{ Params: { uid: string }; Body: { role?: string; status?: "active" | "suspended" | "deleted" } }>(
    "/:uid",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["uid"],
          properties: {
            uid: { type: "string", minLength: 36, maxLength: 36 }
          }
        },
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            role: {
              type: "string",
              enum: ["workspace_admin", "workspace_operator", "workspace_viewer"]
            },
            status: {
              type: "string",
              enum: ["active", "suspended", "deleted"]
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

      if (req.body.role !== undefined && !isUserRole(req.body.role)) {
        return reply.code(400).send({ error: "Invalid user role", code: "invalid_role" });
      }

      try {
        await ensureWorkspaceOwnerVerified(opts.db, user.workspaceId);
        const member = await updateWorkspaceMember(opts.db, user.workspaceId, req.params.uid, {
          role: req.body.role,
          status: req.body.status
        });

        return reply.send({ member: toUserResponse(member) });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );
}
