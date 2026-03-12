import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import { listAuditRecords, listExchangeAuditRecords } from "../services/audit.js";

export interface AuditRoutesOptions extends FastifyPluginOptions {
  db: Pool;
}

function parseOptionalDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toAuditResponse(record: Awaited<ReturnType<typeof listAuditRecords>>[number]) {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    event_type: record.eventType,
    actor_id: record.actorId,
    actor_type: record.actorType,
    resource_id: record.resourceId,
    metadata: record.metadata,
    ip_address: record.ipAddress,
    created_at: record.createdAt.toISOString()
  };
}

export async function registerAuditRoutes(app: FastifyInstance, opts: AuditRoutesOptions): Promise<void> {
  app.get<{
    Querystring: {
      event_type?: string;
      actor_type?: "user" | "agent" | "system";
      resource_id?: string;
      from?: string;
      to?: string;
      limit?: number;
    };
  }>(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            event_type: { type: "string", minLength: 1, maxLength: 120 },
            actor_type: { type: "string", enum: ["user", "agent", "system"] },
            resource_id: { type: "string", minLength: 1, maxLength: 256 },
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            limit: { type: "integer", minimum: 1, maximum: 200 }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_viewer")(req, reply);
      if (!user) {
        return;
      }

      const from = parseOptionalDate(req.query.from);
      const to = parseOptionalDate(req.query.to);
      if (req.query.from && !from) {
        return reply.code(400).send({ error: "Invalid from timestamp", code: "invalid_from" });
      }
      if (req.query.to && !to) {
        return reply.code(400).send({ error: "Invalid to timestamp", code: "invalid_to" });
      }

      const records = await listAuditRecords(opts.db, user.workspaceId, {
        eventType: req.query.event_type,
        actorType: req.query.actor_type,
        resourceId: req.query.resource_id,
        from: from ?? undefined,
        to: to ?? undefined,
        limit: req.query.limit
      });

      return reply.send({
        records: records.map(toAuditResponse)
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/exchange/:id",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 64, maxLength: 64 }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_viewer")(req, reply);
      if (!user) {
        return;
      }

      const records = await listExchangeAuditRecords(opts.db, user.workspaceId, req.params.id);
      if (records.length === 0) {
        return reply.code(404).send({ error: "Audit records not found", code: "audit_not_found" });
      }

      return reply.send({
        exchange_id: req.params.id,
        records: records.map(toAuditResponse)
      });
    }
  );
}
