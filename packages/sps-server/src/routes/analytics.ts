import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import { getActiveAgentCount, getExchangeMetrics, getRequestVolume } from "../services/analytics.js";

export interface AnalyticsRoutesOptions extends FastifyPluginOptions {
  db: Pool;
}

export async function registerAnalyticsRoutes(app: FastifyInstance, opts: AnalyticsRoutesOptions): Promise<void> {
  app.get<{ Querystring: { days?: number } }>(
    "/requests",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            days: { type: "integer", minimum: 1, maximum: 90 }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      const volume = await getRequestVolume(opts.db, user.workspaceId, { days: req.query.days });
      return reply.send(volume);
    }
  );

  app.get<{ Querystring: { days?: number } }>(
    "/exchanges",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            days: { type: "integer", minimum: 1, maximum: 90 }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      const metrics = await getExchangeMetrics(opts.db, user.workspaceId, { days: req.query.days });
      return reply.send(metrics);
    }
  );

  app.get<{ Querystring: { hours?: number } }>(
    "/agents",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            hours: { type: "integer", minimum: 1, maximum: 336 }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      const summary = await getActiveAgentCount(opts.db, user.workspaceId, { hours: req.query.hours });
      return reply.send({
        hours: summary.hours,
        active_agents: summary.count
      });
    }
  );
}
