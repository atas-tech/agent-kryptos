import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import { logAudit } from "../services/audit.js";
import {
  createPublicOffer,
  getPublicOfferById,
  listPublicOffers,
  revokePublicOffer,
  type PublicOfferRecord
} from "../services/guest-offer.js";
import { WorkspacePolicyResolver } from "../services/workspace-policy.js";

const SECRET_NAME_PATTERN = "^[a-z0-9_]+(?:\\.[a-z0-9_]+)+$";

export interface PublicOfferRoutesOptions extends FastifyPluginOptions {
  db: Pool;
  policyResolver: WorkspacePolicyResolver;
}

function toOfferResponse(offer: PublicOfferRecord) {
  return {
    id: offer.id,
    workspace_id: offer.workspaceId,
    created_by_user_id: offer.createdByUserId,
    offer_label: offer.offerLabel,
    delivery_mode: offer.deliveryMode,
    payment_policy: offer.paymentPolicy,
    price_usd_cents: offer.priceUsdCents,
    included_free_uses: offer.includedFreeUses,
    secret_name: offer.secretName,
    secret_alias: offer.secretAlias,
    allowed_fulfiller_id: offer.allowedFulfillerId,
    require_approval: offer.requireApproval,
    status: offer.status,
    max_uses: offer.maxUses,
    used_count: offer.usedCount,
    expires_at: offer.expiresAt.toISOString(),
    revoked_at: offer.revokedAt?.toISOString() ?? null,
    created_at: offer.createdAt.toISOString(),
    updated_at: offer.updatedAt.toISOString()
  };
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof Error && "statusCode" in error && "code" in error) {
    const typed = error as Error & { statusCode: number; code: string };
    return reply.code(typed.statusCode).send({ error: typed.message, code: typed.code });
  }

  throw error;
}

export async function registerPublicOfferRoutes(app: FastifyInstance, opts: PublicOfferRoutesOptions): Promise<void> {
  app.get("/", async (req, reply) => {
    const user = await requireUserRole("workspace_operator")(req, reply);
    if (!user) {
      return;
    }

    const offers = await listPublicOffers(opts.db, user.workspaceId);
    return reply.send({ offers: offers.map(toOfferResponse) });
  });

  app.post<{
    Body: {
      offer_label?: string;
      delivery_mode: "human" | "agent" | "either";
      payment_policy: "free" | "always_x402" | "quota_then_x402";
      price_usd_cents?: number;
      included_free_uses?: number;
      secret_name?: string;
      allowed_fulfiller_id?: string;
      require_approval?: boolean;
      ttl_seconds: number;
      max_uses?: number;
    };
  }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["delivery_mode", "payment_policy", "secret_name", "ttl_seconds"],
          properties: {
            offer_label: { type: "string", minLength: 1, maxLength: 160 },
            delivery_mode: { type: "string", enum: ["human", "agent", "either"] },
            payment_policy: { type: "string", enum: ["free", "always_x402", "quota_then_x402"] },
            price_usd_cents: { type: "integer", minimum: 0, maximum: 1000000 },
            included_free_uses: { type: "integer", minimum: 0, maximum: 1000000 },
            secret_name: { type: "string", pattern: SECRET_NAME_PATTERN },
            allowed_fulfiller_id: { type: "string", minLength: 1, maxLength: 160 },
            require_approval: { type: "boolean" },
            ttl_seconds: { type: "integer", minimum: 1, maximum: 31 * 24 * 60 * 60 },
            max_uses: { type: "integer", minimum: 1, maximum: 1000000 }
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
        const resolvedPolicy = await opts.policyResolver.resolve(user.workspaceId);
        const secretName = req.body.secret_name;
        if (!secretName || !resolvedPolicy.engine.hasSecret(secretName)) {
          return reply.code(400).send({
            error: "Offer secret is not declared in the workspace policy registry",
            code: "unknown_secret_name"
          });
        }

        if (req.body.payment_policy === "free" && (req.body.price_usd_cents ?? 0) !== 0) {
          return reply.code(400).send({
            error: "Free offers must not set a paid price",
            code: "invalid_payment_policy"
          });
        }

        if (req.body.payment_policy === "always_x402" && (req.body.price_usd_cents ?? 0) <= 0) {
          return reply.code(400).send({
            error: "Paid offers must set a positive price",
            code: "invalid_payment_policy"
          });
        }

        if (req.body.payment_policy === "quota_then_x402" && ((req.body.price_usd_cents ?? 0) <= 0 || (req.body.included_free_uses ?? 0) <= 0)) {
          return reply.code(400).send({
            error: "quota_then_x402 offers require both a positive price and included_free_uses",
            code: "invalid_payment_policy"
          });
        }

        const created = await createPublicOffer(opts.db, user.workspaceId, user.sub, {
          offerLabel: req.body.offer_label,
          deliveryMode: req.body.delivery_mode,
          paymentPolicy: req.body.payment_policy,
          priceUsdCents: req.body.price_usd_cents ?? 0,
          includedFreeUses: req.body.included_free_uses ?? 0,
          secretName,
          allowedFulfillerId: req.body.allowed_fulfiller_id,
          requireApproval: req.body.require_approval === true,
          maxUses: req.body.max_uses,
          expiresAt: new Date(Date.now() + req.body.ttl_seconds * 1000)
        });

        await logAudit(opts.db, {
          event: "public_offer_created",
          workspaceId: user.workspaceId,
          actorId: user.sub,
          actorType: "user",
          resourceId: created.offer.id,
          metadata: {
            delivery_mode: created.offer.deliveryMode,
            payment_policy: created.offer.paymentPolicy,
            price_usd_cents: created.offer.priceUsdCents,
            included_free_uses: created.offer.includedFreeUses,
            secret_name: created.offer.secretName,
            require_approval: created.offer.requireApproval
          },
          action: "public_offer_create",
          ip: req.ip
        });

        return reply.code(201).send({
          offer: toOfferResponse(created.offer),
          offer_token: created.offerToken
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/:id/revoke",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 36, maxLength: 36 }
          }
        }
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      const existing = await getPublicOfferById(opts.db, user.workspaceId, req.params.id);
      if (!existing) {
        return reply.code(404).send({ error: "Offer not found", code: "public_offer_not_found" });
      }

      const revoked = await revokePublicOffer(opts.db, user.workspaceId, req.params.id);
      if (!revoked) {
        return reply.code(409).send({ error: "Offer is already revoked", code: "public_offer_already_revoked" });
      }

      await logAudit(opts.db, {
        event: "public_offer_revoked",
        workspaceId: user.workspaceId,
        actorId: user.sub,
        actorType: "user",
        resourceId: revoked.id,
        metadata: {
          delivery_mode: revoked.deliveryMode,
          payment_policy: revoked.paymentPolicy
        },
        action: "public_offer_revoke",
        ip: req.ip
      });

      return reply.send({ offer: toOfferResponse(revoked) });
    }
  );
}
