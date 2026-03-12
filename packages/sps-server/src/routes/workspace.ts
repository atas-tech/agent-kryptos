import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { Pool } from "pg";
import { requireUserAuth, requireUserRole } from "../middleware/auth.js";
import { getWorkspace, type WorkspaceRecord, updateWorkspaceDisplayName } from "../services/workspace.js";

export interface WorkspaceRoutesOptions extends FastifyPluginOptions {
  db: Pool;
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

export async function registerWorkspaceRoutes(app: FastifyInstance, opts: WorkspaceRoutesOptions): Promise<void> {
  app.get("/", async (req, reply) => {
    const user = await requireUserAuth(req, reply);
    if (!user) {
      return;
    }

    const workspace = await getWorkspace(opts.db, user.workspaceId, { activeOnly: true });
    if (!workspace) {
      return reply.code(404).send({ error: "Workspace not found" });
    }

    return reply.send({ workspace: toWorkspaceResponse(workspace) });
  });

  app.patch<{ Body: { display_name: string } }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["display_name"],
          properties: {
            display_name: { type: "string", minLength: 1, maxLength: 160 }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_admin")(req, reply);
      if (!user) {
        return;
      }

      const workspace = await updateWorkspaceDisplayName(opts.db, user.workspaceId, req.body.display_name);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      return reply.send({ workspace: toWorkspaceResponse(workspace) });
    }
  );
}
