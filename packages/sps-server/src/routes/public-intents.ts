import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { rateLimitKeyByIp, sendRateLimited, type RateLimitService } from "../middleware/rate-limit.js";
import { requireUserRole } from "../middleware/auth.js";
import { generateRequestId, signGuestFulfillmentToken } from "../services/crypto.js";
import { logAudit } from "../services/audit.js";
import { getPublicOfferByToken } from "../services/guest-offer.js";
import {
  activateGuestIntent,
  cleanupExpiredUnpaidGuestIntents,
  createOrResumeGuestIntent,
  decideGuestIntentApproval,
  getGuestIntentAdminById,
  getGuestIntentById,
  getGuestIntentByStatusToken,
  listGuestIntentsForWorkspace,
  markGuestAgentDeliveryFailed,
  revokeGuestIntent,
  retryGuestAgentDelivery,
  toGuestIntentPublicStatus,
  type GuestIntentAdminRecord,
  type GuestIntentRecord
} from "../services/guest-intent.js";
import {
  findGuestPaymentByPaymentId,
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
import { hashPolicyDecision } from "../services/policy.js";
import type { PolicyDecision, RequestStore, StoredExchange } from "../types.js";

const BASE64_PATTERN = "^[A-Za-z0-9+/]+={0,2}$";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function publicIntentIpLimitPerMinute(): number {
  const raw = Number(process.env.SPS_PUBLIC_INTENT_IP_LIMIT ?? 30);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 30;
  }

  return Math.floor(raw);
}

function publicIntentOfferLimitPerMinute(): number {
  const raw = Number(process.env.SPS_PUBLIC_INTENT_OFFER_LIMIT ?? 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 10;
  }

  return Math.floor(raw);
}

export interface PublicIntentRoutesOptions extends FastifyPluginOptions {
  db: Pool;
  store: RequestStore;
  hmacSecret: string;
  uiBaseUrl: string;
  requestTtlSeconds?: number;
  revokedTtlSeconds?: number;
  rateLimitService?: RateLimitService;
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

async function toAdminIntentResponse(
  intent: GuestIntentAdminRecord,
  store: RequestStore
): Promise<Record<string, unknown>> {
  const request = intent.requestId ? await store.getRequest(intent.requestId) : null;
  const exchangeState = intent.exchangeId ? await getGuestExchangeSupportState(store, intent.exchangeId) : null;
  const requestState = request
    ? {
        status: request.status,
        expires_at: new Date(request.expiresAt * 1000).toISOString()
      }
    : null;

  return {
    id: intent.id,
    workspace_id: intent.workspaceId,
    offer_id: intent.offerId,
    offer_label: intent.offerLabel,
    offer_status: intent.offerStatus,
    offer_used_count: intent.offerUsedCount,
    offer_max_uses: intent.offerMaxUses,
    offer_expires_at: intent.offerExpiresAt.toISOString(),
    actor_type: intent.actorType,
    status: intent.status,
    effective_status: intent.effectiveStatus,
    approval_status: intent.approvalStatus,
    approval_reference: intent.approvalReference,
    requester_label: intent.requesterLabel,
    purpose: intent.purpose,
    delivery_mode: intent.deliveryMode,
    payment_policy: intent.paymentPolicy,
    price_usd_cents: intent.priceUsdCents,
    included_free_uses: intent.includedFreeUses,
    resolved_secret_name: intent.resolvedSecretName,
    allowed_fulfiller_id: intent.allowedFulfillerId,
    request_id: intent.requestId,
    request_state: requestState,
    exchange_id: intent.exchangeId,
    exchange_state: exchangeState
      ? {
          status: exchangeState.status,
          fulfilled_by: exchangeState.fulfilledBy,
          expires_at: exchangeState.expiresAt
        }
      : null,
    agent_delivery: intent.deliveryMode === "agent"
      ? {
          state: exchangeState?.status === "pending" && intent.agentDeliveryState === "failed"
            ? "delivery_failed"
            : exchangeState?.status ?? intent.agentDeliveryState,
          recoverable: intent.agentDeliveryState === "failed" && exchangeState?.status === "pending",
          failure_reason: intent.agentDeliveryFailureReason,
          failed_at: intent.agentDeliveryFailedAt?.toISOString() ?? null,
          last_dispatched_at: intent.agentDeliveryLastDispatchedAt?.toISOString() ?? null,
          attempt_count: intent.agentDeliveryAttemptCount
        }
      : null,
    activated_at: intent.activatedAt?.toISOString() ?? null,
    revoked_at: intent.revokedAt?.toISOString() ?? null,
    expires_at: intent.expiresAt.toISOString(),
    created_at: intent.createdAt.toISOString(),
    updated_at: intent.updatedAt.toISOString(),
    latest_payment: intent.latestPaymentId
      ? {
          payment_id: intent.latestPaymentId,
          status: intent.latestPaymentStatus,
          tx_hash: intent.latestPaymentTxHash,
          settled_at: intent.latestPaymentSettledAt?.toISOString() ?? null,
          created_at: intent.latestPaymentCreatedAt?.toISOString() ?? null
        }
      : null
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

async function signGuestExchangeFulfillmentToken(exchange: StoredExchange, hmacSecret: string): Promise<string> {
  return signGuestFulfillmentToken({
    exchange_id: exchange.exchangeId,
    requester_id: exchange.requesterId,
    workspace_id: exchange.workspaceId,
    secret_name: exchange.secretName,
    purpose: exchange.purpose,
    policy_hash: exchange.policyHash,
    approval_reference: exchange.policyDecision.approvalReference ?? null
  }, hmacSecret, exchange.expiresAt);
}

async function getGuestExchangeSupportState(store: RequestStore, exchangeId: string): Promise<{
  status: string;
  fulfilledBy: string | null;
  expiresAt: string | null;
}> {
  const exchange = await store.getExchange(exchangeId);
  if (exchange) {
    return {
      status: exchange.status,
      fulfilledBy: exchange.fulfilledBy ?? null,
      expiresAt: new Date(exchange.expiresAt * 1000).toISOString()
    };
  }

  const lifecycle = await store.listLifecycleRecordsByExchange(exchangeId);
  const lastRecord = lifecycle.at(-1);
  if (!lastRecord) {
    return {
      status: "expired",
      fulfilledBy: null,
      expiresAt: null
    };
  }

  return {
    status: lastRecord.status ?? (lastRecord.eventType === "exchange_retrieved" ? "retrieved" : "expired"),
    fulfilledBy:
      typeof lastRecord.metadata?.fulfilled_by === "string"
        ? lastRecord.metadata.fulfilled_by
        : lastRecord.eventType === "exchange_reserved" || lastRecord.eventType === "exchange_submitted"
          ? (lastRecord.actorId ?? null)
          : null,
    expiresAt: null
  };
}

function guestIntentAvailableForDelivery(intent: GuestIntentRecord, requestId: string): boolean {
  const expectedDeliveryId = intent.deliveryMode === "agent" ? intent.exchangeId : intent.requestId;
  if (expectedDeliveryId !== requestId) {
    return false;
  }

  if (intent.status !== "activated" || intent.revokedAt || intent.expiresAt.getTime() <= Date.now()) {
    return false;
  }

  return true;
}

function buildGuestExchangeDecision(
  intent: GuestIntentRecord,
  settledPolicySnapshot: Record<string, unknown>
): PolicyDecision {
  const approvalRequired = settledPolicySnapshot.require_approval === true;
  return {
    mode: "allow",
    approvalRequired,
    ruleId: `guest_offer:${intent.offerId}`,
    reason: approvalRequired ? "Guest public offer approval satisfied" : "Guest public offer direct allow",
    approvalReference: intent.approvalReference ?? null,
    secretName: intent.resolvedSecretName,
    requesterRing: null,
    fulfillerRing: null
  };
}

function guestPaymentRequestHash(body: {
  actor_type?: "guest_agent" | "guest_human";
  public_key: string;
  purpose: string;
  requester_label?: string;
}, offerId: string): string {
  return hashX402Request({
    offer_id: offerId,
    actor_type: body.actor_type ?? "guest_agent",
    requester_public_key: body.public_key,
    purpose: body.purpose,
    requester_label: body.requester_label?.trim() || null
  });
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
      requireUserAuth: false,
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
      requireUserAuth: false,
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

async function appendGuestExchangeLifecycle(
  store: RequestStore,
  record: {
    eventType: "exchange_requested" | "exchange_delivery_failed" | "exchange_delivery_retried" | "exchange_retrieved";
    exchangeId: string;
    approvalReference: string | null;
    requesterId: string;
    workspaceId: string;
    secretName: string;
    purpose: string;
    fulfillerHint: string | null;
    actorId: string | null;
    status: string;
    priorStatus: string | null;
    reason: string | null;
    policyRuleId: string | null;
    metadata: Record<string, unknown> | null;
  }
): Promise<void> {
  await store.appendLifecycleRecord({
    recordId: generateRequestId(),
    eventType: record.eventType,
    exchangeId: record.exchangeId,
    approvalReference: record.approvalReference,
    requesterId: record.requesterId,
    workspaceId: record.workspaceId,
    secretName: record.secretName,
    purpose: record.purpose,
    fulfillerHint: record.fulfillerHint,
    actorId: record.actorId,
    status: record.status,
    priorStatus: record.priorStatus,
    reason: record.reason,
    policyRuleId: record.policyRuleId,
    metadata: record.metadata,
    createdAt: nowSeconds()
  });
}

async function issueGuestExchangeArtifacts(
  opts: PublicIntentRoutesOptions,
  intent: GuestIntentRecord,
  settledPolicySnapshot: Record<string, unknown>
): Promise<{
  intent: GuestIntentRecord;
  exchangeId: string;
  fulfillmentToken: string;
  guestAccessToken: string;
}> {
  if (intent.deliveryMode !== "agent") {
    throw new Error("Only agent delivery is supported by this helper");
  }

  if (!intent.allowedFulfillerId) {
    const error = new Error("Agent-delivery guest offers must pin an allowed fulfiller");
    Object.assign(error, { statusCode: 400, code: "unsupported_offer" });
    throw error;
  }

  const createdAt = nowSeconds();
  const exchangeExpiresAt = Math.min(
    Math.floor(intent.expiresAt.getTime() / 1000),
    createdAt + (opts.requestTtlSeconds ?? 180)
  );
  const exchangeTtlSeconds = Math.max(1, exchangeExpiresAt - createdAt);
  const exchangeId = generateRequestId();
  const requesterId = guestRequesterId(intent);
  const policyDecision = buildGuestExchangeDecision(intent, settledPolicySnapshot);
  const policyHash = hashPolicyDecision(policyDecision, intent.allowedFulfillerId, intent.workspaceId);
  const exchangeRecord: StoredExchange = {
    exchangeId,
    requesterId,
    workspaceId: intent.workspaceId,
    requesterPublicKey: intent.requesterPublicKey,
    secretName: intent.resolvedSecretName,
    purpose: intent.purpose,
    fulfillerHint: intent.allowedFulfillerId,
    allowedFulfillerId: intent.allowedFulfillerId,
    priorExchangeId: null,
    supersedesExchangeId: null,
    policyDecision,
    policyHash,
    status: "pending",
    createdAt,
    expiresAt: exchangeExpiresAt
  };

  const fulfillmentToken = await signGuestExchangeFulfillmentToken(exchangeRecord, opts.hmacSecret);
  await opts.store.setExchange(exchangeRecord, exchangeTtlSeconds);

  await appendGuestExchangeLifecycle(opts.store, {
    eventType: "exchange_requested",
    exchangeId,
    approvalReference: policyDecision.approvalReference ?? null,
    requesterId,
    workspaceId: intent.workspaceId,
    secretName: intent.resolvedSecretName,
    purpose: intent.purpose,
    fulfillerHint: intent.allowedFulfillerId,
    actorId: guestActorId(intent),
    status: "pending",
    priorStatus: null,
    reason: null,
    policyRuleId: policyDecision.ruleId,
    metadata: {
      guest_intent_id: intent.id
    }
  });

  const activatedIntent = await activateGuestIntent(opts.db, {
    intentId: intent.id,
    exchangeId,
    settledPolicySnapshot
  });
  const guestAccessToken = await signGuestAccessToken({
    intent_id: activatedIntent.id,
    request_id: exchangeId,
    requester_id: requesterId,
    workspace_id: activatedIntent.workspaceId,
    actor_type: activatedIntent.actorType
  }, opts.hmacSecret, Math.floor(activatedIntent.expiresAt.getTime() / 1000));

  return {
    intent: activatedIntent,
    exchangeId,
    fulfillmentToken,
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
  app.get<{
    Querystring: {
      offer_id?: string;
      status?: "pending_approval" | "payment_required" | "activated" | "rejected" | "revoked" | "expired";
      approval_status?: "pending" | "approved" | "rejected";
      limit?: number;
    };
  }>(
    "/admin",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            offer_id: { type: "string", minLength: 36, maxLength: 36 },
            status: {
              type: "string",
              enum: ["pending_approval", "payment_required", "activated", "rejected", "revoked", "expired"]
            },
            approval_status: { type: "string", enum: ["pending", "approved", "rejected"] },
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

      const intents = await listGuestIntentsForWorkspace(opts.db, user.workspaceId, {
        offerId: req.query.offer_id,
        status: req.query.status,
        approvalStatus: req.query.approval_status,
        limit: req.query.limit
      });

      return reply.send({
        intents: await Promise.all(intents.map((intent) => toAdminIntentResponse(intent, opts.store)))
      });
    }
  );

  app.post(
    "/admin/cleanup-expired",
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      const result = await cleanupExpiredUnpaidGuestIntents(opts.db, user.workspaceId);
      await logAudit(opts.db, {
        event: "guest_intent_cleanup",
        workspaceId: user.workspaceId,
        actorId: user.sub,
        actorType: "user",
        resourceId: user.workspaceId,
        metadata: {
          expired_intent_count: result.expiredIntentCount
        },
        action: "guest_intent_cleanup",
        ip: req.ip
      });

      return reply.send({
        expired_intent_count: result.expiredIntentCount
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/admin/:id",
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
      const user = await requireUserRole("workspace_viewer")(req, reply);
      if (!user) {
        return;
      }

      const intent = await getGuestIntentAdminById(opts.db, user.workspaceId, req.params.id);
      if (!intent) {
        return reply.code(404).send({ error: "Guest intent not found", code: "guest_intent_not_found" });
      }

      return reply.send({
        intent: await toAdminIntentResponse(intent, opts.store)
      });
    }
  );

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

        const paymentSignature = typeof req.headers["payment-signature"] === "string" ? req.headers["payment-signature"].trim() : "";
        const paymentId = typeof req.headers["payment-identifier"] === "string" ? req.headers["payment-identifier"].trim() : "";
        const requestHash = guestPaymentRequestHash(req.body, offer.id);

        if (paymentId) {
          const existingPayment = await findGuestPaymentByPaymentId(opts.db, offer.workspaceId, paymentId);
          if (existingPayment) {
            if (existingPayment.requestHash !== requestHash) {
              return reply.code(409).send({
                error: "payment-identifier reuse does not match the original request",
                code: "payment_identifier_conflict"
              });
            }

            if (existingPayment.status === "settled" && existingPayment.responseCache) {
              return reply.code(201).send(existingPayment.responseCache);
            }

            return reply.code(409).send({
              error: existingPayment.status === "failed"
                ? "Payment already failed for this request"
                : "Payment is already being processed for this request",
              code: existingPayment.status === "failed" ? "payment_failed" : "payment_in_progress"
            });
          }
        }

        if (opts.rateLimitService) {
          const ipRateLimit = await opts.rateLimitService.consume(
            rateLimitKeyByIp(req, `public:intents:create:${offer.workspaceId}`),
            publicIntentIpLimitPerMinute(),
            60_000
          );
          if (!ipRateLimit.allowed) {
            await logAudit(opts.db, {
              event: "guest_intent_rate_limited",
              workspaceId: offer.workspaceId,
              actorType: "system",
              resourceId: offer.id,
              metadata: {
                scope: "ip",
                offer_id: offer.id,
                ip: req.ip,
                limit: ipRateLimit.limit,
                used: ipRateLimit.used,
                retry_after_seconds: ipRateLimit.retryAfterSeconds
              },
              action: "guest_intent_rate_limit",
              ip: req.ip
            });
            return sendRateLimited(reply, ipRateLimit, "Too many guest intent attempts from this IP", "guest_intent_rate_limited");
          }

          const offerRateLimit = await opts.rateLimitService.consume(
            `public:intents:offer:${offer.id}`,
            publicIntentOfferLimitPerMinute(),
            60_000
          );
          if (!offerRateLimit.allowed) {
            await logAudit(opts.db, {
              event: "guest_intent_rate_limited",
              workspaceId: offer.workspaceId,
              actorType: "system",
              resourceId: offer.id,
              metadata: {
                scope: "offer",
                offer_id: offer.id,
                ip: req.ip,
                limit: offerRateLimit.limit,
                used: offerRateLimit.used,
                retry_after_seconds: offerRateLimit.retryAfterSeconds
              },
              action: "guest_intent_rate_limit",
              ip: req.ip
            });
            return sendRateLimited(reply, offerRateLimit, "This public offer is temporarily throttled", "guest_offer_rate_limited");
          }
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
            requestHash,
            paymentId,
            paymentSignature,
            quote: result.quote
          });

          if (paymentOutcome.cachedResponse) {
            return reply.code(201).send(paymentOutcome.cachedResponse);
          }

          const settledSnapshot = {
            ...result.intent.policySnapshot,
            settled_at: new Date().toISOString(),
            payment_id: paymentId
          };
          let responsePayload: Record<string, unknown>;
          if (result.intent.deliveryMode === "human") {
            const activated = await issueGuestActivationArtifacts(opts, result.intent, settledSnapshot);
            responsePayload = {
              intent: toIntentResponse(activated.intent),
              request_id: activated.requestId,
              fulfill_url: activated.fulfillUrl,
              guest_access_token: activated.guestAccessToken
            };
          } else if (result.intent.deliveryMode === "agent") {
            const activated = await issueGuestExchangeArtifacts(opts, result.intent, settledSnapshot);
            responsePayload = {
              intent: toIntentResponse(activated.intent),
              exchange_id: activated.exchangeId,
              fulfillment_token: activated.fulfillmentToken,
              guest_access_token: activated.guestAccessToken
            };
          } else {
            return reply.code(501).send({ error: "Delivery mode is not implemented yet", code: "delivery_mode_not_implemented" });
          }
          await markGuestPaymentSettled(opts.db, {
            workspaceId: result.intent.workspaceId,
            paymentId,
            txHash: paymentOutcome.txHash,
            responseCache: responsePayload
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

        const settledSnapshot = {
          ...result.intent.policySnapshot,
          settled_at: new Date().toISOString(),
          settlement_mode: "free"
        };

        if (result.intent.deliveryMode === "human") {
          const activated = await issueGuestActivationArtifacts(opts, result.intent, settledSnapshot);

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
        }

        if (result.intent.deliveryMode === "agent") {
          const activated = await issueGuestExchangeArtifacts(opts, result.intent, settledSnapshot);

          await logAudit(opts.db, {
            event: "guest_intent_activated",
            workspaceId: activated.intent.workspaceId,
            actorId: guestActorId(activated.intent),
            actorType: activated.intent.actorType,
            resourceId: activated.intent.id,
            metadata: {
              offer_id: activated.intent.offerId,
              payment_policy: activated.intent.paymentPolicy,
              exchange_id: activated.exchangeId
            },
            action: "guest_intent_activate",
            ip: req.ip
          });

          return reply.code(result.httpStatus).send({
            intent: toIntentResponse(activated.intent),
            exchange_id: activated.exchangeId,
            fulfillment_token: activated.fulfillmentToken,
            guest_access_token: activated.guestAccessToken
          });
        }

        return reply.code(501).send({ error: "Delivery mode is not implemented yet", code: "delivery_mode_not_implemented" });
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
    if (!intent || intent.workspaceId !== claims.workspace_id || !guestIntentAvailableForDelivery(intent, claims.request_id)) {
      return reply.code(410).send({ error: "Not available" });
    }

    if (intent.deliveryMode === "agent") {
      const exchangeState = await getGuestExchangeSupportState(opts.store, claims.request_id);
      return reply.send({
        intent_id: intent.id,
        exchange_id: claims.request_id,
        status: exchangeState.status === "pending" && intent.agentDeliveryState === "failed"
          ? "delivery_failed"
          : exchangeState.status,
        recoverable: intent.agentDeliveryState === "failed" && exchangeState.status === "pending",
        fulfilled_by: exchangeState.fulfilledBy,
        expires_at: exchangeState.expiresAt ?? intent.expiresAt.toISOString()
      });
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
    if (!intent || intent.workspaceId !== claims.workspace_id || !guestIntentAvailableForDelivery(intent, claims.request_id)) {
      return reply.code(410).send({ error: "Not available" });
    }

    if (intent.deliveryMode === "agent") {
      const exchange = await opts.store.getExchange(claims.request_id);
      if (!exchange || exchange.status !== "submitted") {
        return reply.code(410).send({ error: "Not available" });
      }

      const retrieved = await opts.store.atomicRetrieveExchange(claims.request_id, claims.requester_id, claims.workspace_id);
      if (!retrieved || !retrieved.enc || !retrieved.ciphertext) {
        return reply.code(410).send({ error: "Not available" });
      }

      await appendGuestExchangeLifecycle(opts.store, {
        eventType: "exchange_retrieved",
        exchangeId: retrieved.exchangeId,
        approvalReference: retrieved.policyDecision.approvalReference ?? null,
        requesterId: retrieved.requesterId,
        workspaceId: retrieved.workspaceId ?? claims.workspace_id,
        secretName: retrieved.secretName,
        purpose: retrieved.purpose,
        fulfillerHint: retrieved.fulfillerHint,
        actorId: guestActorId(intent),
        status: "retrieved",
        priorStatus: exchange.status,
        reason: null,
        policyRuleId: retrieved.policyDecision.ruleId,
        metadata: {
          fulfilled_by: retrieved.fulfilledBy ?? null
        }
      });

      await logAudit(opts.db, {
        event: "exchange_retrieved",
        workspaceId: claims.workspace_id,
        actorId: guestActorId(intent),
        actorType: intent.actorType,
        exchangeId: retrieved.exchangeId,
        requesterId: claims.requester_id,
        fulfilledBy: retrieved.fulfilledBy ?? undefined,
        secretName: retrieved.secretName,
        policyRuleId: retrieved.policyDecision.ruleId,
        approvalReference: retrieved.policyDecision.approvalReference ?? null,
        resourceId: intent.id,
        action: "guest_exchange_retrieve",
        ip: req.ip
      });

      return reply.send({
        enc: retrieved.enc,
        ciphertext: retrieved.ciphertext
      });
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
        if (intent.requestId) {
          await opts.store.deleteRequest(intent.requestId).catch(() => undefined);
        }
        if (intent.exchangeId) {
          const currentExchange = await opts.store.getExchange(intent.exchangeId);
          if (currentExchange) {
            const revoked = await opts.store.revokeExchange(intent.exchangeId, opts.revokedTtlSeconds ?? 300);
            if (revoked) {
              await opts.store.appendLifecycleRecord({
                recordId: generateRequestId(),
                eventType: "exchange_revoked",
                exchangeId: revoked.exchangeId,
                approvalReference: revoked.policyDecision.approvalReference ?? null,
                requesterId: revoked.requesterId,
                workspaceId: revoked.workspaceId,
                secretName: revoked.secretName,
                purpose: revoked.purpose,
                fulfillerHint: revoked.fulfillerHint,
                actorId: user.sub,
                status: revoked.status,
                priorStatus: currentExchange.status,
                reason: "guest intent revoked",
                policyRuleId: revoked.policyDecision.ruleId,
                metadata: {
                  guest_intent_id: intent.id
                },
                createdAt: nowSeconds()
              });
            }
          }
        }
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

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/:id/agent-delivery-failed",
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
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: {
            reason: { type: "string", minLength: 3, maxLength: 500 }
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
        const current = await getGuestIntentById(opts.db, req.params.id);
        if (!current || current.workspaceId !== user.workspaceId) {
          return reply.code(404).send({ error: "Guest intent not found", code: "guest_intent_not_found" });
        }
        if (!current.exchangeId) {
          return reply.code(409).send({ error: "Guest intent has no active exchange", code: "guest_intent_not_agent_delivery" });
        }

        const exchange = await opts.store.getExchange(current.exchangeId);
        if (!exchange || exchange.status !== "pending") {
          return reply.code(409).send({
            error: "Guest exchange is no longer awaiting delivery",
            code: "guest_exchange_not_pending_delivery"
          });
        }

        const intent = await markGuestAgentDeliveryFailed(opts.db, user.workspaceId, req.params.id, req.body.reason);
        await appendGuestExchangeLifecycle(opts.store, {
          eventType: "exchange_delivery_failed",
          exchangeId: exchange.exchangeId,
          approvalReference: exchange.policyDecision.approvalReference ?? null,
          requesterId: exchange.requesterId,
          workspaceId: exchange.workspaceId ?? intent.workspaceId,
          secretName: exchange.secretName,
          purpose: exchange.purpose,
          fulfillerHint: exchange.fulfillerHint,
          actorId: user.sub,
          status: "delivery_failed",
          priorStatus: exchange.status,
          reason: req.body.reason.trim(),
          policyRuleId: exchange.policyDecision.ruleId,
          metadata: {
            guest_intent_id: intent.id,
            delivery_attempt_count: intent.agentDeliveryAttemptCount
          }
        });
        await logAudit(opts.db, {
          event: "guest_agent_delivery_failed",
          workspaceId: user.workspaceId,
          actorId: user.sub,
          actorType: "user",
          resourceId: intent.id,
          exchangeId: exchange.exchangeId,
          requesterId: exchange.requesterId,
          secretName: exchange.secretName,
          policyRuleId: exchange.policyDecision.ruleId,
          approvalReference: exchange.policyDecision.approvalReference ?? null,
          metadata: {
            offer_id: intent.offerId,
            reason: req.body.reason.trim(),
            delivery_attempt_count: intent.agentDeliveryAttemptCount
          },
          action: "guest_agent_delivery_fail",
          ip: req.ip
        });
        return reply.send({ intent: toIntentResponse(intent) });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/:id/retry-agent-delivery",
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
        const current = await getGuestIntentById(opts.db, req.params.id);
        if (!current || current.workspaceId !== user.workspaceId) {
          return reply.code(404).send({ error: "Guest intent not found", code: "guest_intent_not_found" });
        }
        if (!current.exchangeId) {
          return reply.code(409).send({ error: "Guest intent has no active exchange", code: "guest_intent_not_agent_delivery" });
        }

        const exchange = await opts.store.getExchange(current.exchangeId);
        if (!exchange || exchange.status !== "pending") {
          return reply.code(409).send({
            error: "Guest exchange is no longer awaiting delivery",
            code: "guest_exchange_not_pending_delivery"
          });
        }

        const intent = await retryGuestAgentDelivery(opts.db, user.workspaceId, req.params.id);
        const fulfillmentToken = await signGuestExchangeFulfillmentToken(exchange, opts.hmacSecret);
        await appendGuestExchangeLifecycle(opts.store, {
          eventType: "exchange_delivery_retried",
          exchangeId: exchange.exchangeId,
          approvalReference: exchange.policyDecision.approvalReference ?? null,
          requesterId: exchange.requesterId,
          workspaceId: exchange.workspaceId ?? intent.workspaceId,
          secretName: exchange.secretName,
          purpose: exchange.purpose,
          fulfillerHint: exchange.fulfillerHint,
          actorId: user.sub,
          status: "pending",
          priorStatus: "delivery_failed",
          reason: null,
          policyRuleId: exchange.policyDecision.ruleId,
          metadata: {
            guest_intent_id: intent.id,
            delivery_attempt_count: intent.agentDeliveryAttemptCount
          }
        });
        await logAudit(opts.db, {
          event: "guest_agent_delivery_retried",
          workspaceId: user.workspaceId,
          actorId: user.sub,
          actorType: "user",
          resourceId: intent.id,
          exchangeId: exchange.exchangeId,
          requesterId: exchange.requesterId,
          secretName: exchange.secretName,
          policyRuleId: exchange.policyDecision.ruleId,
          approvalReference: exchange.policyDecision.approvalReference ?? null,
          metadata: {
            offer_id: intent.offerId,
            delivery_attempt_count: intent.agentDeliveryAttemptCount
          },
          action: "guest_agent_delivery_retry",
          ip: req.ip
        });
        return reply.send({
          intent: toIntentResponse(intent),
          exchange_id: exchange.exchangeId,
          fulfillment_token: fulfillmentToken
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    }
  );
}
