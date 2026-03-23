import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { requireUserRole } from "../middleware/auth.js";
import { logAudit } from "../services/audit.js";
import { getPublicOfferByToken } from "../services/guest-offer.js";
import {
  activateGuestIntent,
  createOrResumeGuestIntent,
  decideGuestIntentApproval,
  getGuestIntentById,
  getGuestIntentByStatusToken,
  revokeGuestIntent,
  toGuestIntentPublicStatus,
  type GuestIntentRecord
} from "../services/guest-intent.js";
import {
  markGuestPaymentSettled,
  verifyAndSettleGuestPayment
} from "../services/guest-payment.js";
import { verifyGuestAccessToken, signGuestAccessToken } from "../services/requester-auth.js";
import { createSecretRequest } from "../services/secret-request.js";
import type { X402Provider } from "../services/x402.js";
import {
  encodePaymentRequiredHeader,
  buildPaymentRequiredPayload,
  hashX402Request,
  x402ConfigFromEnv
} from "../services/x402.js";
import type { RequestStore } from "../types.js";

const BASE64_PATTERN = "^[A-Za-z0-9+/]+={0,2}$";

export interface PublicIntentRoutesOptions extends FastifyPluginOptions {
  db: Pool;
  store: RequestStore;
  hmacSecret: string;
  uiBaseUrl: string;
  requestTtlSeconds?: number;
  x402Provider?: X402Provider;
}

function toIntentResponse(intent: GuestIntentRecord) {
  return {
    intent_id: intent.id,
    status: intent.status,
    approval_status: intent.approvalStatus,
    approval_reference: intent.approvalReference,
    delivery_mode: intent.deliveryMode,
    payment_policy: intent.paymentPolicy,
    payment_required: intent.status === "payment_required",
    price_usd_cents: intent.priceUsdCents,
    requester_label: intent.requesterLabel,
    status_token: intent.statusToken,
    request_id: intent.requestId,
    exchange_id: intent.exchangeId,
    expires_at: intent.expiresAt.toISOString(),
    activated_at: intent.activatedAt?.toISOString() ?? null
  };
}

function guestActorId(intent: GuestIntentRecord): string {
  return intent.requesterLabel ? `${intent.actorType}:${intent.requesterLabel}` : `${intent.actorType}:${intent.id}`;
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

function guestRequesterId(intent: GuestIntentRecord): string {
  return `guest-intent:${intent.id}`;
}

function buildHumanRequestDescription(intent: GuestIntentRecord): string {
  const requester = intent.requesterLabel?.trim() || "External requester";
  return `${requester} requested a one-time secret handoff. Purpose: ${intent.purpose}`;
}

async function issueGuestActivationArtifacts(
  opts: PublicIntentRoutesOptions,
  intent: GuestIntentRecord,
  settledPolicySnapshot: Record<string, unknown>
): Promise<{
  intent: GuestIntentRecord;
  requestId: string;
  fulfillUrl: string;
  guestAccessToken: string;
}> {
  if (intent.deliveryMode !== "human") {
    throw new Error("Only human delivery is implemented for guest activation");
  }

  let activatedIntent = intent;
  let fulfillUrl: string;

  if (intent.requestId) {
    const existingRequest = await opts.store.getRequest(intent.requestId);
    if (!existingRequest) {
      throw new Error("Guest intent request record is unavailable");
    }
    fulfillUrl = `${opts.uiBaseUrl}/?id=${existingRequest.requestId}`;
    const sigStart = fulfillUrl.indexOf("?");
    if (sigStart >= 0) {
      fulfillUrl = fulfillUrl.slice(0, sigStart);
    }
    const recreated = await createSecretRequest(opts.store, {
      publicKey: existingRequest.publicKey,
      description: existingRequest.description,
      requesterId: existingRequest.requesterId,
      workspaceId: existingRequest.workspaceId,
      requestTtlSeconds: Math.max(1, existingRequest.expiresAt - Math.floor(Date.now() / 1000)),
      hmacSecret: opts.hmacSecret,
      uiBaseUrl: opts.uiBaseUrl,
      requireUserAuth: existingRequest.requireUserAuth,
      requiredUserWorkspaceId: existingRequest.requiredUserWorkspaceId,
      requestedByActorType: existingRequest.requestedByActorType,
      guestIntentId: existingRequest.guestIntentId
    });
    await opts.store.deleteRequest(existingRequest.requestId).catch(() => undefined);
    const updated = await activateGuestIntent(opts.db, {
      intentId: intent.id,
      requestId: recreated.record.requestId,
      settledPolicySnapshot
    });
    activatedIntent = updated;
    fulfillUrl = recreated.secretUrl;
  } else {
    const created = await createSecretRequest(opts.store, {
      publicKey: intent.requesterPublicKey,
      description: buildHumanRequestDescription(intent),
      requesterId: guestRequesterId(intent),
      workspaceId: intent.workspaceId,
      requestTtlSeconds: opts.requestTtlSeconds ?? 180,
      hmacSecret: opts.hmacSecret,
      uiBaseUrl: opts.uiBaseUrl,
      requireUserAuth: true,
      requiredUserWorkspaceId: intent.workspaceId,
      requestedByActorType: intent.actorType,
      guestIntentId: intent.id
    });

    activatedIntent = await activateGuestIntent(opts.db, {
      intentId: intent.id,
      requestId: created.record.requestId,
      settledPolicySnapshot
    });
    fulfillUrl = created.secretUrl;
  }

  const guestAccessToken = await signGuestAccessToken({
    intent_id: activatedIntent.id,
    request_id: activatedIntent.requestId!,
    requester_id: guestRequesterId(activatedIntent),
    workspace_id: activatedIntent.workspaceId,
    actor_type: activatedIntent.actorType
  }, opts.hmacSecret, Math.floor(activatedIntent.expiresAt.getTime() / 1000));

  return {
    intent: activatedIntent,
    requestId: activatedIntent.requestId!,
    fulfillUrl,
    guestAccessToken
  };
}

async function requireGuestAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  hmacSecret: string,
  intentId: string
) {
  const token = bearerToken(req);
  if (!token) {
    reply.code(401).send({ error: "Missing bearer token" });
    return null;
  }

  try {
    const claims = await verifyGuestAccessToken(token, hmacSecret);
    if (claims.intent_id !== intentId) {
      reply.code(410).send({ error: "Not available" });
      return null;
    }
    return claims;
  } catch {
    reply.code(401).send({ error: "Invalid token" });
    return null;
  }
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof Error && "statusCode" in error && "code" in error) {
    const typed = error as Error & { statusCode: number; code: string };
    return reply.code(typed.statusCode).send({ error: typed.message, code: typed.code });
  }

  throw error;
}

export async function registerPublicIntentRoutes(app: FastifyInstance, opts: PublicIntentRoutesOptions): Promise<void> {
  app.post<{
    Body: {
      offer_token: string;
      actor_type?: "guest_agent" | "guest_human";
      public_key: string;
      purpose: string;
      requester_label?: string;
    };
  }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["offer_token", "public_key", "purpose"],
          properties: {
            offer_token: { type: "string", minLength: 12, maxLength: 255 },
            actor_type: { type: "string", enum: ["guest_agent", "guest_human"] },
            public_key: { type: "string", minLength: 4, maxLength: 4096, pattern: BASE64_PATTERN },
            purpose: { type: "string", minLength: 1, maxLength: 500 },
            requester_label: { type: "string", minLength: 1, maxLength: 160 }
          }
        }
      }
    },
    async (req, reply) => {
      try {
        const offer = await getPublicOfferByToken(opts.db, req.body.offer_token);
        if (!offer) {
          return reply.code(404).send({ error: "Offer not found", code: "public_offer_not_found" });
        }

        const x402Config = x402ConfigFromEnv();
        const result = await createOrResumeGuestIntent(opts.db, req.body.offer_token, offer, {
          actorType: req.body.actor_type ?? "guest_agent",
          requesterPublicKey: req.body.public_key,
          purpose: req.body.purpose,
          requesterLabel: req.body.requester_label,
          sourceIp: req.ip
        }, x402Config);

        if (result.kind === "pending_approval") {
          await logAudit(opts.db, {
            event: "guest_intent_pending_approval",
            workspaceId: result.intent.workspaceId,
            actorId: guestActorId(result.intent),
            actorType: result.intent.actorType,
            resourceId: result.intent.id,
            metadata: {
              offer_id: result.intent.offerId,
              purpose: result.intent.purpose,
              approval_reference: result.intent.approvalReference
            },
            action: "guest_intent_pending_approval",
            ip: req.ip
          });
          return reply.code(result.httpStatus).send({ intent: toIntentResponse(result.intent) });
        }

        if (result.kind === "rejected") {
          return reply.code(result.httpStatus).send({
            error: "Guest intent was rejected",
            code: "guest_intent_rejected",
            intent: toIntentResponse(result.intent)
          });
        }

        if (result.kind === "payment_required") {
          const paymentSignature = typeof req.headers["payment-signature"] === "string" ? req.headers["payment-signature"].trim() : "";
          const paymentId = typeof req.headers["payment-identifier"] === "string" ? req.headers["payment-identifier"].trim() : "";

          if (!paymentSignature) {
            reply.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(buildPaymentRequiredPayload(result.quote)));
            await logAudit(opts.db, {
              event: "guest_payment_required",
              workspaceId: result.intent.workspaceId,
              actorId: guestActorId(result.intent),
              actorType: result.intent.actorType,
              resourceId: result.intent.id,
              metadata: {
                offer_id: result.intent.offerId,
                quoted_amount_cents: result.quote.amountUsdCents,
                quoted_asset_amount: result.quote.amountAssetDisplay,
                network_id: result.quote.networkId
              },
              action: "guest_payment_required",
              ip: req.ip
            });
            return reply.code(result.httpStatus).send({
              error: "Payment required",
              code: "payment_required",
              intent: toIntentResponse(result.intent)
            });
          }

          if (!paymentId) {
            reply.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(buildPaymentRequiredPayload(result.quote)));
            return reply.code(400).send({ error: "payment-identifier header is required", code: "missing_payment_identifier" });
          }

          if (!opts.x402Provider || !x402Config.facilitatorUrl) {
            return reply.code(500).send({ error: "x402 is not configured", code: "x402_not_configured" });
          }

          const paymentOutcome = await verifyAndSettleGuestPayment(opts.db, opts.x402Provider, x402Config, {
            workspaceId: result.intent.workspaceId,
            intentId: result.intent.id,
            requestHash: hashX402Request({
              intent_id: result.intent.id,
              requester_public_key: req.body.public_key,
              purpose: req.body.purpose,
              offer_id: result.intent.offerId
            }),
            paymentId,
            paymentSignature,
            quote: result.quote
          });

          if (paymentOutcome.cachedResponse) {
            return reply.code(201).send(paymentOutcome.cachedResponse);
          }

          const activated = await issueGuestActivationArtifacts(opts, result.intent, {
            ...result.intent.policySnapshot,
            settled_at: new Date().toISOString(),
            payment_id: paymentId
          });

          const responsePayload = {
            intent: toIntentResponse(activated.intent),
            request_id: activated.requestId,
            fulfill_url: activated.fulfillUrl,
            guest_access_token: activated.guestAccessToken
          };
          await markGuestPaymentSettled(opts.db, {
            workspaceId: result.intent.workspaceId,
            paymentId,
            txHash: paymentOutcome.txHash,
            responseCache: responsePayload as unknown as Record<string, unknown>
          });

          await logAudit(opts.db, {
            event: "x402_payment_settled",
            workspaceId: result.intent.workspaceId,
            actorId: guestActorId(result.intent),
            actorType: result.intent.actorType,
            resourceId: result.intent.id,
            metadata: {
              offer_id: result.intent.offerId,
              payment_id: paymentId,
              tx_hash: paymentOutcome.txHash,
              quoted_amount_cents: result.quote.amountUsdCents
            },
            action: "guest_payment_settled",
            ip: req.ip
          });

          return reply.code(201).send(responsePayload);
        }

        if (result.intent.deliveryMode !== "human") {
          return reply.code(501).send({ error: "Agent delivery is not implemented yet", code: "delivery_mode_not_implemented" });
        }

        const activated = await issueGuestActivationArtifacts(opts, result.intent, {
          ...result.intent.policySnapshot,
          settled_at: new Date().toISOString(),
          settlement_mode: "free"
        });

        await logAudit(opts.db, {
          event: "guest_intent_activated",
          workspaceId: activated.intent.workspaceId,
          actorId: guestActorId(activated.intent),
          actorType: activated.intent.actorType,
          resourceId: activated.intent.id,
          metadata: {
            offer_id: activated.intent.offerId,
            payment_policy: activated.intent.paymentPolicy,
            request_id: activated.requestId
          },
          action: "guest_intent_activate",
          ip: req.ip
        });

        return reply.code(result.httpStatus).send({
          intent: toIntentResponse(activated.intent),
          request_id: activated.requestId,
          fulfill_url: activated.fulfillUrl,
          guest_access_token: activated.guestAccessToken
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.get<{ Params: { id: string }; Querystring: { status_token: string } }>(
    "/:id/status",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 36, maxLength: 36 }
          }
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["status_token"],
          properties: {
            status_token: { type: "string", minLength: 12, maxLength: 255 }
          }
        }
      }
    },
    async (req, reply) => {
      const intent = await getGuestIntentByStatusToken(opts.db, req.params.id, req.query.status_token);
      if (!intent) {
        return reply.code(410).send({ status: "expired" });
      }

      return reply.send(toGuestIntentPublicStatus(intent));
    }
  );

  app.get<{ Params: { id: string } }>("/:id/delivery-status", async (req, reply) => {
    const claims = await requireGuestAccess(req, reply, opts.hmacSecret, req.params.id);
    if (!claims) {
      return;
    }

    const intent = await getGuestIntentById(opts.db, req.params.id);
    if (!intent || intent.workspaceId !== claims.workspace_id || intent.requestId !== claims.request_id) {
      return reply.code(410).send({ error: "Not available" });
    }

    const request = await opts.store.getRequest(claims.request_id);
    if (!request) {
      return reply.code(410).send({ status: "expired" });
    }

    return reply.send({
      intent_id: intent.id,
      request_id: claims.request_id,
      status: request.status,
      expires_at: new Date(request.expiresAt * 1000).toISOString()
    });
  });

  app.get<{ Params: { id: string } }>("/:id/retrieve", async (req, reply) => {
    const claims = await requireGuestAccess(req, reply, opts.hmacSecret, req.params.id);
    if (!claims) {
      return;
    }

    const intent = await getGuestIntentById(opts.db, req.params.id);
    if (!intent || intent.workspaceId !== claims.workspace_id || intent.requestId !== claims.request_id) {
      return reply.code(410).send({ error: "Not available" });
    }

    const retrieved = await opts.store.atomicRetrieveAndDelete(claims.request_id, claims.requester_id, claims.workspace_id);
    if (!retrieved || !retrieved.enc || !retrieved.ciphertext) {
      return reply.code(410).send({ error: "Not available" });
    }

    await logAudit(opts.db, {
      event: "secret_retrieved",
      workspaceId: claims.workspace_id,
      actorId: guestActorId(intent),
      actorType: intent.actorType,
      requestId: claims.request_id,
      resourceId: intent.id,
      action: "guest_secret_retrieve",
      ip: req.ip
    });

    return reply.send({
      enc: retrieved.enc,
      ciphertext: retrieved.ciphertext
    });
  });

  app.post<{ Params: { id: string } }>(
    "/:id/approve",
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

      try {
        const intent = await decideGuestIntentApproval(opts.db, user.workspaceId, req.params.id, user.sub, "approved");
        await logAudit(opts.db, {
          event: "guest_intent_approved",
          workspaceId: user.workspaceId,
          actorId: user.sub,
          actorType: "user",
          resourceId: intent.id,
          metadata: {
            offer_id: intent.offerId,
            approval_reference: intent.approvalReference
          },
          action: "guest_intent_approve",
          ip: req.ip
        });
        return reply.send({ intent: toIntentResponse(intent) });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/:id/reject",
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

      try {
        const intent = await decideGuestIntentApproval(opts.db, user.workspaceId, req.params.id, user.sub, "rejected");
        await logAudit(opts.db, {
          event: "guest_intent_rejected",
          workspaceId: user.workspaceId,
          actorId: user.sub,
          actorType: "user",
          resourceId: intent.id,
          metadata: {
            offer_id: intent.offerId,
            approval_reference: intent.approvalReference
          },
          action: "guest_intent_reject",
          ip: req.ip
        });
        return reply.send({ intent: toIntentResponse(intent) });
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

      try {
        const intent = await revokeGuestIntent(opts.db, user.workspaceId, req.params.id);
        await logAudit(opts.db, {
          event: "guest_intent_revoked",
          workspaceId: user.workspaceId,
          actorId: user.sub,
          actorType: "user",
          resourceId: intent.id,
          metadata: {
            offer_id: intent.offerId
          },
          action: "guest_intent_revoke",
          ip: req.ip
        });
        return reply.send({ intent: toIntentResponse(intent) });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );
}
