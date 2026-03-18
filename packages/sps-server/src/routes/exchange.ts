import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { requireAdminAgentAuth, requireAgentAuth, requireUserRole } from "../middleware/auth.js";
import { generateRequestId, signFulfillmentToken, verifyFulfillmentToken } from "../services/crypto.js";
import type { QuotaService } from "../services/quota.js";
import { exchangeAllowed } from "../services/quota.js";
import { getWorkspace } from "../services/workspace.js";
import {
  approvalMatches,
  buildApprovalReference,
  createApprovalRequest,
  isApproverAuthorized,
  promoteApprovedDecision
} from "../services/approval.js";
import { logAudit } from "../services/audit.js";
import { hashPolicyDecision } from "../services/policy.js";
import { WorkspacePolicyResolver, WorkspacePolicyServiceError } from "../services/workspace-policy.js";
import {
  acquireInflightLease,
  buildExchangeQuote,
  buildPaymentRequiredPayload,
  consumeFreeExchangeSlot,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  findTransactionByPaymentId,
  hashX402Request,
  insertPendingTransaction,
  markTransactionFailed,
  markTransactionSettled,
  markTransactionVerified,
  parsePaymentSignatureHeader,
  releaseInflightLease,
  reserveAllowanceSpend,
  rollbackAllowanceSpend,
  type X402Provider,
  X402ServiceError,
  x402ConfigFromEnv
} from "../services/x402.js";
import type { ExchangeLifecycleRecord, PolicyDecision, RequestStore, StoredApprovalRequest, StoredExchange } from "../types.js";

const EXCHANGE_ID_PATTERN = "^[a-f0-9]{64}$";
const APPROVAL_ID_PATTERN = "^apr_[a-f0-9]{24}$";
const BASE64_PATTERN = "^[A-Za-z0-9+/]+={0,2}$";
const SECRET_NAME_PATTERN = "^[a-z0-9_]+(?:\\.[a-z0-9_]+)+$";

const exchangeParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", pattern: EXCHANGE_ID_PATTERN }
  }
} as const;

const approvalParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", pattern: APPROVAL_ID_PATTERN }
  }
} as const;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isHostedModeEnabled(): boolean {
  const raw = process.env.SPS_HOSTED_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function workspaceMatches(
  resourceWorkspaceId: string | undefined,
  agentWorkspaceId: string | null | undefined
): boolean {
  if (isHostedModeEnabled()) {
    return !!resourceWorkspaceId && !!agentWorkspaceId && resourceWorkspaceId === agentWorkspaceId;
  }

  if (resourceWorkspaceId && agentWorkspaceId && resourceWorkspaceId !== agentWorkspaceId) {
    return false;
  }

  return true;
}

function toPolicyResponse(decision: PolicyDecision) {
  return {
    mode: decision.mode,
    approval_required: decision.approvalRequired,
    rule_id: decision.ruleId,
    reason: decision.reason,
    approval_reference: decision.approvalReference ?? null,
    requester_ring: decision.requesterRing ?? null,
    fulfiller_ring: decision.fulfillerRing ?? null,
    secret_name: decision.secretName
  };
}

function toApprovalResponse(approval: StoredApprovalRequest) {
  return {
    approval_reference: approval.approvalReference,
    status: approval.status,
    requester_id: approval.requesterId,
    fulfiller_hint: approval.fulfillerHint,
    secret_name: approval.secretName,
    purpose: approval.purpose,
    rule_id: approval.ruleId,
    reason: approval.reason,
    requester_ring: approval.requesterRing ?? null,
    fulfiller_ring: approval.fulfillerRing ?? null,
    created_at: approval.createdAt,
    decided_at: approval.decidedAt ?? null,
    decided_by: approval.decidedBy ?? null,
    expires_at: approval.expiresAt
  };
}

function toExchangeAdminResponse(exchange: StoredExchange) {
  return {
    exchange_id: exchange.exchangeId,
    requester_id: exchange.requesterId,
    secret_name: exchange.secretName,
    purpose: exchange.purpose,
    fulfiller_hint: exchange.fulfillerHint,
    allowed_fulfiller_id: exchange.allowedFulfillerId,
    fulfilled_by: exchange.fulfilledBy ?? null,
    status: exchange.status,
    prior_exchange_id: exchange.priorExchangeId ?? null,
    supersedes_exchange_id: exchange.supersedesExchangeId ?? null,
    policy: toPolicyResponse(exchange.policyDecision),
    created_at: exchange.createdAt,
    expires_at: exchange.expiresAt
  };
}

function toLifecycleResponse(record: ExchangeLifecycleRecord) {
  return {
    record_id: record.recordId,
    event_type: record.eventType,
    exchange_id: record.exchangeId ?? null,
    approval_reference: record.approvalReference ?? null,
    requester_id: record.requesterId,
    secret_name: record.secretName,
    purpose: record.purpose,
    fulfiller_hint: record.fulfillerHint ?? null,
    actor_id: record.actorId ?? null,
    status: record.status ?? null,
    prior_status: record.priorStatus ?? null,
    reason: record.reason ?? null,
    policy_rule_id: record.policyRuleId ?? null,
    metadata: record.metadata ?? null,
    created_at: record.createdAt
  };
}

async function appendLifecycleRecord(
  store: RequestStore,
  record: Omit<ExchangeLifecycleRecord, "recordId">
): Promise<void> {
  await store.appendLifecycleRecord({
    ...record,
    recordId: generateRequestId()
  });
}

async function validatePriorExchange(
  store: RequestStore,
  priorExchangeId: string,
  requesterId: string,
  secretName: string,
  workspaceId?: string
): Promise<boolean> {
  const exchange = await store.getExchange(priorExchangeId);
  if (exchange) {
    return (
      exchange.requesterId === requesterId &&
      exchange.secretName === secretName &&
      workspaceMatches(exchange.workspaceId, workspaceId)
    );
  }

  const lifecycle = await store.listLifecycleRecordsByExchange(priorExchangeId);
  return lifecycle.some(
    (record) =>
      record.requesterId === requesterId &&
      record.secretName === secretName &&
      workspaceMatches(record.workspaceId, workspaceId)
  );
}

function notAvailable(reply: FastifyReply) {
  return reply.code(410).send({ error: "Not available" });
}

function attachApprovalReference(decision: PolicyDecision, approvalReference: string): PolicyDecision {
  if (decision.mode !== "pending_approval" || decision.approvalReference) {
    return decision;
  }

  return {
    ...decision,
    approvalReference
  };
}

function sendWorkspacePolicyError(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkspacePolicyServiceError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code
    });
  }

  throw error;
}

export interface ExchangeRoutesOptions extends FastifyPluginOptions {
  store: RequestStore;
  hmacSecret: string;
  policyResolver: WorkspacePolicyResolver;
  db?: Pool | null;
  quotaService?: QuotaService;
  x402Provider?: X402Provider;
  requestTtlSeconds?: number;
  submittedTtlSeconds?: number;
  revokedTtlSeconds?: number;
  approvalTtlSeconds?: number;
}

interface CreatedExchangeResponse {
  exchange_id: string;
  status: "pending";
  expires_at: number;
  fulfillment_token: string;
  policy: ReturnType<typeof toPolicyResponse>;
}

export async function registerExchangeRoutes(app: FastifyInstance, opts: ExchangeRoutesOptions): Promise<void> {
  const requestTtl = opts.requestTtlSeconds ?? 180;
  const submittedTtl = opts.submittedTtlSeconds ?? 60;
  const revokedTtl = opts.revokedTtlSeconds ?? 300;
  const approvalTtl = opts.approvalTtlSeconds ?? 600;
  const x402Config = x402ConfigFromEnv();

  async function createExchangeRequestRecord(params: {
    publicKey: string;
    secretName: string;
    purpose: string;
    fulfillerHint: string;
    priorExchangeId: string;
    requesterId: string;
    workspaceId?: string;
    decision: PolicyDecision;
    allowedFulfillerId: string;
    ip?: string;
  }): Promise<CreatedExchangeResponse> {
    const createdAt = nowSeconds();
    const expiresAt = createdAt + requestTtl;
    const exchangeId = generateRequestId();
    const policyHash = hashPolicyDecision(params.decision, params.allowedFulfillerId, params.workspaceId);
    const fulfillmentToken = await signFulfillmentToken(
      {
        exchange_id: exchangeId,
        requester_id: params.requesterId,
        workspace_id: params.workspaceId,
        secret_name: params.secretName,
        purpose: params.purpose,
        policy_hash: policyHash,
        approval_reference: params.decision.approvalReference ?? null
      },
      opts.hmacSecret,
      expiresAt
    );

    await opts.store.setExchange(
      {
        exchangeId,
        requesterId: params.requesterId,
        workspaceId: params.workspaceId,
        requesterPublicKey: params.publicKey,
        secretName: params.secretName,
        purpose: params.purpose,
        fulfillerHint: params.fulfillerHint,
        allowedFulfillerId: params.allowedFulfillerId,
        priorExchangeId: params.priorExchangeId || null,
        supersedesExchangeId: params.priorExchangeId || null,
        policyDecision: params.decision,
        policyHash,
        status: "pending",
        createdAt,
        expiresAt
      },
      requestTtl
    );

    await appendLifecycleRecord(opts.store, {
      eventType: "exchange_requested",
      exchangeId,
      approvalReference: params.decision.approvalReference ?? null,
      requesterId: params.requesterId,
      workspaceId: params.workspaceId,
      secretName: params.secretName,
      purpose: params.purpose,
      fulfillerHint: params.fulfillerHint,
      actorId: params.requesterId,
      status: "pending",
      priorStatus: null,
      reason: null,
      policyRuleId: params.decision.ruleId,
      metadata: {
        prior_exchange_id: params.priorExchangeId || null,
        requester_ring: params.decision.requesterRing ?? null,
        fulfiller_ring: params.decision.fulfillerRing ?? null
      },
      createdAt
    });

    await logAudit(opts.db, {
      event: "exchange_requested",
      actorId: params.requesterId,
      actorType: "agent",
      exchangeId,
      requesterId: params.requesterId,
      workspaceId: params.workspaceId ?? null,
      secretName: params.secretName,
      policyRuleId: params.decision.ruleId,
      approvalReference: params.decision.approvalReference ?? null,
      action: "exchange_request",
      ip: params.ip
    });

    return {
      exchange_id: exchangeId,
      status: "pending",
      expires_at: expiresAt,
      fulfillment_token: fulfillmentToken,
      policy: toPolicyResponse(params.decision)
    };
  }

  async function decideApproval(params: {
    approvalReference: string;
    status: "approved" | "rejected";
    actorId: string;
    actorType: "agent" | "user";
    workspaceId?: string;
    ip?: string;
  }): Promise<
    | { kind: "not_available" }
    | { kind: "conflict" }
    | {
        kind: "ok";
        approval: StoredApprovalRequest;
      }
  > {
    const approval = await opts.store.getApprovalRequest(params.approvalReference);
    if (!approval) {
      return { kind: "not_available" };
    }

    if (params.workspaceId && approval.workspaceId !== params.workspaceId) {
      return { kind: "not_available" };
    }

    if (params.actorType === "agent") {
      if (!workspaceMatches(approval.workspaceId, params.workspaceId)) {
        return { kind: "not_available" };
      }

      if (!isApproverAuthorized(approval, params.actorId)) {
        return { kind: "not_available" };
      }
    }

    if (approval.status !== "pending") {
      return { kind: "conflict" };
    }

    const decidedAt = nowSeconds();
    const nextApproval = await opts.store.updateApprovalRequest(
      approval.approvalReference,
      {
        status: params.status,
        decidedAt,
        decidedBy: params.actorId
      },
      approvalTtl
    );

    if (!nextApproval) {
      return { kind: "not_available" };
    }

    await appendLifecycleRecord(opts.store, {
      eventType: "approval_decided",
      exchangeId: null,
      approvalReference: nextApproval.approvalReference,
      requesterId: nextApproval.requesterId,
      workspaceId: nextApproval.workspaceId,
      secretName: nextApproval.secretName,
      purpose: nextApproval.purpose,
      fulfillerHint: nextApproval.fulfillerHint,
      actorId: params.actorId,
      status: nextApproval.status,
      priorStatus: approval.status,
      reason: nextApproval.reason,
      policyRuleId: nextApproval.ruleId,
      metadata: null,
      createdAt: decidedAt
    });

    await logAudit(opts.db, {
      event: params.status === "approved" ? "exchange_approved" : "exchange_rejected",
      actorType: params.actorType,
      actorId: params.actorId,
      requesterId: nextApproval.requesterId,
      workspaceId: nextApproval.workspaceId ?? null,
      fulfilledBy: nextApproval.fulfillerHint,
      secretName: nextApproval.secretName,
      policyRuleId: nextApproval.ruleId,
      approvalReference: nextApproval.approvalReference,
      resourceId: nextApproval.approvalReference,
      metadata: {
        purpose: nextApproval.purpose
      },
      action: params.status === "approved" ? "exchange_approval_approve" : "exchange_approval_reject",
      ip: params.ip
    });

    return {
      kind: "ok",
      approval: nextApproval
    };
  }

  async function resolveDecision(
    requesterId: string,
    requesterWorkspaceId: string | undefined,
    secretName: string,
    purpose: string,
    fulfillerHint: string,
    fulfillerWorkspaceId?: string
  ): Promise<{
    decision: PolicyDecision;
    allowedFulfillerId: string | null;
    approvalRecordStatus?: "pending" | "approved" | "rejected";
  } | null> {
    const resolvedPolicy = await opts.policyResolver.resolve(requesterWorkspaceId);
    const evaluated = resolvedPolicy.engine.evaluate({
      requesterId,
      requesterWorkspaceId,
      secretName,
      purpose,
      fulfillerHint,
      fulfillerWorkspaceId
    });
    if (!evaluated) {
      return null;
    }

    if (evaluated.decision.mode !== "pending_approval") {
      return {
        decision: evaluated.decision,
        allowedFulfillerId: evaluated.allowedFulfillerId
      };
    }

    const approvalReference = buildApprovalReference({
      requesterId,
      workspaceId: requesterWorkspaceId,
      secretName,
      purpose,
      fulfillerHint,
      ruleId: evaluated.decision.ruleId
    });
    const decision = attachApprovalReference(evaluated.decision, approvalReference);
    const approvalRecord = await opts.store.getApprovalRequest(approvalReference);

    if (
      approvalRecord &&
      approvalMatches(approvalRecord, {
        requesterId,
        workspaceId: requesterWorkspaceId,
        secretName,
        purpose,
        fulfillerHint,
        ruleId: decision.ruleId
      })
    ) {
      if (approvalRecord.status === "approved") {
        return {
          decision: promoteApprovedDecision(decision, approvalReference, approvalRecord.decidedBy),
          allowedFulfillerId: fulfillerHint,
          approvalRecordStatus: approvalRecord.status
        };
      }

      return {
        decision,
        allowedFulfillerId: null,
        approvalRecordStatus: approvalRecord.status
      };
    }

    const createdAt = nowSeconds();
    await opts.store.setApprovalRequest(
      createApprovalRequest({
        approvalReference,
        requesterId,
        workspaceId: requesterWorkspaceId,
        secretName,
        purpose,
        fulfillerHint,
        ruleId: decision.ruleId,
        reason: decision.reason,
        requesterRing: decision.requesterRing ?? null,
        fulfillerRing: decision.fulfillerRing ?? null,
        approverIds: evaluated.approverIds,
        approverRings: evaluated.approverRings,
        createdAt,
        expiresAt: createdAt + approvalTtl
      }),
      approvalTtl
    );

    await appendLifecycleRecord(opts.store, {
      eventType: "approval_requested",
      exchangeId: null,
      approvalReference,
      requesterId,
      workspaceId: requesterWorkspaceId,
      secretName,
      purpose,
      fulfillerHint,
      actorId: null,
      status: "pending",
      priorStatus: null,
      reason: decision.reason,
      policyRuleId: decision.ruleId,
      metadata: {
        requester_ring: decision.requesterRing ?? null,
        fulfiller_ring: decision.fulfillerRing ?? null
      },
      createdAt
    });

    await logAudit(opts.db, {
      event: "exchange_approval_requested",
      actorId: requesterId,
      actorType: "agent",
      requesterId,
      workspaceId: requesterWorkspaceId ?? null,
      resourceId: approvalReference,
      fulfilledBy: fulfillerHint,
      secretName,
      policyRuleId: decision.ruleId,
      approvalReference,
      metadata: {
        purpose
      },
      action: "exchange_approval_request",
      ip: undefined
    });

    return {
      decision,
      allowedFulfillerId: null,
      approvalRecordStatus: "pending"
    };
  }

  app.post<{
    Body: { public_key: string; secret_name: string; purpose: string; fulfiller_hint: string; prior_exchange_id?: string };
  }>(
    "/request",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["public_key", "secret_name", "purpose", "fulfiller_hint"],
          properties: {
            public_key: { type: "string", minLength: 4, maxLength: 2048, pattern: BASE64_PATTERN },
            secret_name: { type: "string", minLength: 3, maxLength: 256, pattern: SECRET_NAME_PATTERN },
            purpose: { type: "string", minLength: 1, maxLength: 256 },
            fulfiller_hint: { type: "string", minLength: 1, maxLength: 512 },
            prior_exchange_id: { type: "string", pattern: EXCHANGE_ID_PATTERN }
          }
        }
      }
    },
    async (req, reply) => {
      const agent = await requireAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      const secretName = req.body.secret_name.trim();
      const purpose = req.body.purpose.trim();
      const fulfillerHint = req.body.fulfiller_hint.trim();
      const priorExchangeId = typeof req.body.prior_exchange_id === "string" ? req.body.prior_exchange_id.trim() : "";
      if (!secretName || !purpose || !fulfillerHint) {
        return reply.code(400).send({ error: "secret_name, purpose, and fulfiller_hint must not be blank" });
      }
      if (priorExchangeId && !(await validatePriorExchange(opts.store, priorExchangeId, agent.sub, secretName, agent.workspaceId ?? undefined))) {
        return reply.code(409).send({ error: "prior_exchange_id does not match requester or secret_name" });
      }

      if (opts.db && agent.workspaceId) {
        const workspace = await getWorkspace(opts.db, agent.workspaceId, { activeOnly: true });
        if (!workspace) {
          return reply.code(404).send({ error: "Workspace not found", code: "workspace_not_found" });
        }
      }

      let resolvedPolicy;
      try {
        resolvedPolicy = await resolveDecision(
          agent.sub,
          agent.workspaceId ?? undefined,
          secretName,
          purpose,
          fulfillerHint
        );
      } catch (error) {
        return sendWorkspacePolicyError(reply, error);
      }
      if (!resolvedPolicy) {
        await logAudit(opts.db, {
          event: "exchange_denied",
          actorId: agent.sub,
          actorType: "agent",
          requesterId: agent.sub,
          workspaceId: agent.workspaceId ?? null,
          secretName,
          fulfilledBy: fulfillerHint,
          action: "exchange_request_denied",
          ip: req.ip
        });
        return reply.code(403).send({ error: "Exchange not allowed" });
      }

      const decision = resolvedPolicy.decision;
      if (decision.mode !== "allow") {
        await logAudit(opts.db, {
          event: decision.mode === "pending_approval" ? "exchange_pending_approval" : "exchange_denied",
          actorId: agent.sub,
          actorType: "agent",
          requesterId: agent.sub,
          workspaceId: agent.workspaceId ?? null,
          secretName,
          fulfilledBy: fulfillerHint,
          policyRuleId: decision.ruleId,
          approvalReference: decision.approvalReference ?? null,
          action: decision.mode === "pending_approval" ? "exchange_request_pending_approval" : "exchange_request_denied",
          ip: req.ip
        });
        return reply.code(403).send({
          error:
            resolvedPolicy.approvalRecordStatus === "rejected"
              ? "Exchange approval was rejected"
              : decision.mode === "pending_approval"
                ? "Exchange requires human approval"
                : "Exchange not allowed",
          approval_status: resolvedPolicy.approvalRecordStatus ?? null,
          policy: toPolicyResponse(decision)
        });
      }

      const allowedFulfillerId = resolvedPolicy.allowedFulfillerId;
      if (!allowedFulfillerId) {
        return reply.code(500).send({ error: "Exchange policy did not resolve an allowed fulfiller" });
      }

      const workspace = opts.db && agent.workspaceId
        ? await getWorkspace(opts.db, agent.workspaceId, { activeOnly: true })
        : null;

      const requestHash = hashX402Request({
        requester_id: agent.sub,
        workspace_id: agent.workspaceId ?? null,
        public_key: req.body.public_key,
        secret_name: secretName,
        purpose,
        fulfiller_hint: fulfillerHint,
        prior_exchange_id: priorExchangeId || null,
        policy_rule_id: decision.ruleId
      });

      if (opts.db && workspace?.tier === "free" && agent.workspaceId) {
        if (!exchangeAllowed(workspace.tier)) {
          return reply.code(403).send({ error: "Exchange is not available on this workspace tier", code: "feature_not_available" });
        }

        const freeUsage = await consumeFreeExchangeSlot(opts.db, agent.workspaceId, x402Config.freeExchangeMonthlyCap);
        if (!freeUsage.granted) {
          if (!x402Config.enabled) {
            return reply.code(403).send({ error: "x402 overages are disabled", code: "x402_disabled" });
          }

          if (!opts.x402Provider || !x402Config.facilitatorUrl || !x402Config.payToAddress) {
            return reply.code(500).send({ error: "x402 is not configured", code: "x402_not_configured" });
          }

          const quote = buildExchangeQuote(x402Config, {
            workspaceId: agent.workspaceId,
            agentId: agent.sub,
            secretName
          });
          const paymentRequired = buildPaymentRequiredPayload(quote);
          const paymentSignature = typeof req.headers["payment-signature"] === "string" ? req.headers["payment-signature"].trim() : "";
          const paymentId = typeof req.headers["payment-identifier"] === "string" ? req.headers["payment-identifier"].trim() : "";

          if (!paymentSignature) {
            await logAudit(opts.db, {
              event: "x402_payment_required",
              actorId: agent.sub,
              actorType: "agent",
              requesterId: agent.sub,
              workspaceId: agent.workspaceId,
              secretName,
              action: "x402_payment_required",
              ip: req.ip,
              metadata: {
                quoted_amount_cents: quote.amountUsdCents,
                quoted_asset_amount: quote.amountAssetDisplay,
                network_id: quote.networkId
              }
            });
            reply.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
            return reply.code(402).send({ error: "Payment required", code: "payment_required" });
          }

          if (!paymentId) {
            reply.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
            return reply.code(400).send({ error: "payment-identifier header is required", code: "missing_payment_identifier" });
          }

          const existing = await findTransactionByPaymentId(opts.db, agent.workspaceId, paymentId);
          if (existing) {
            if (existing.requestHash !== requestHash) {
              return reply.code(409).send({ error: "payment-identifier reuse does not match the original request", code: "payment_identifier_conflict" });
            }
            if (existing.status === "settled" && existing.responseCache) {
              reply.header("PAYMENT-RESPONSE", encodePaymentResponseHeader({
                payment_id: paymentId,
                tx_hash: existing.txHash,
                cached: true,
                status: existing.status
              }));
              return reply.code(201).send(existing.responseCache);
            }

            return reply.code(409).send({ error: "Payment is already being processed for this request", code: "payment_in_progress" });
          }

          const leaseAcquired = await acquireInflightLease(
            opts.db,
            agent.workspaceId,
            agent.sub,
            paymentId,
            x402Config.leaseDurationSeconds
          );
          if (!leaseAcquired) {
            return reply.code(409).send({ error: "Payment is already in progress for this agent", code: "payment_in_progress" });
          }

          let allowanceReserved = false;
          try {
            await insertPendingTransaction(opts.db, {
              workspaceId: agent.workspaceId,
              agentId: agent.sub,
              paymentId,
              requestHash,
              quote,
              facilitatorUrl: x402Config.facilitatorUrl
            });

            let paymentPayload: ReturnType<typeof parsePaymentSignatureHeader>;
            try {
              paymentPayload = parsePaymentSignatureHeader(paymentSignature);
            } catch {
              throw new X402ServiceError(400, "invalid_payment_signature", "Invalid PAYMENT-SIGNATURE header");
            }
            if (paymentPayload.paymentId !== paymentId) {
              throw new X402ServiceError(400, "payment_identifier_mismatch", "payment-identifier does not match PAYMENT-SIGNATURE");
            }

            const verifyResult = await opts.x402Provider.verifyPayment({
              paymentPayload,
              paymentDetails: paymentRequired,
              paymentId
            });

            if (!verifyResult.valid) {
              await markTransactionFailed(opts.db, agent.workspaceId, paymentId);
              await logAudit(opts.db, {
                event: "x402_payment_failed",
                actorId: agent.sub,
                actorType: "agent",
                requesterId: agent.sub,
                workspaceId: agent.workspaceId,
                secretName,
                action: "x402_payment_verify_failed",
                ip: req.ip,
                metadata: {
                  payment_id: paymentId,
                  reason: verifyResult.failureReason ?? "verification_failed"
                }
              });
              return reply.code(402).send({ error: "Payment verification failed", code: "payment_verification_failed" });
            }

            await markTransactionVerified(opts.db, agent.workspaceId, paymentId);
            await logAudit(opts.db, {
              event: "x402_payment_verified",
              actorId: agent.sub,
              actorType: "agent",
              requesterId: agent.sub,
              workspaceId: agent.workspaceId,
              secretName,
              action: "x402_payment_verified",
              ip: req.ip,
              metadata: {
                payment_id: paymentId
              }
            });

            try {
              await reserveAllowanceSpend(opts.db, agent.workspaceId, agent.sub, quote.amountUsdCents);
              allowanceReserved = true;
            } catch (error) {
              await markTransactionFailed(opts.db, agent.workspaceId, paymentId);
              if (error instanceof X402ServiceError) {
                await logAudit(opts.db, {
                  event: "x402_budget_denied",
                  actorId: agent.sub,
                  actorType: "agent",
                  requesterId: agent.sub,
                  workspaceId: agent.workspaceId,
                  secretName,
                  action: "x402_budget_denied",
                  ip: req.ip,
                  metadata: {
                    payment_id: paymentId,
                    quoted_amount_cents: quote.amountUsdCents
                  }
                });
              }
              throw error;
            }

            const settlement = await opts.x402Provider.settlePayment({
              paymentPayload,
              paymentDetails: paymentRequired,
              paymentId
            });
            const created = await createExchangeRequestRecord({
              publicKey: req.body.public_key,
              secretName,
              purpose,
              fulfillerHint,
              priorExchangeId,
              requesterId: agent.sub,
              workspaceId: agent.workspaceId ?? undefined,
              decision,
              allowedFulfillerId,
              ip: req.ip
            });

            await markTransactionSettled(opts.db, {
              workspaceId: agent.workspaceId,
              paymentId,
              resourceId: created.exchange_id,
              txHash: settlement.txHash,
              responseCache: created as unknown as Record<string, unknown>
            });

            await logAudit(opts.db, {
              event: "x402_payment_settled",
              actorId: agent.sub,
              actorType: "agent",
              requesterId: agent.sub,
              exchangeId: created.exchange_id,
              workspaceId: agent.workspaceId,
              secretName,
              action: "x402_payment_settled",
              ip: req.ip,
              metadata: {
                payment_id: paymentId,
                tx_hash: settlement.txHash,
                quoted_amount_cents: quote.amountUsdCents,
                quoted_asset_amount: quote.amountAssetDisplay,
                network_id: quote.networkId
              }
            });

            reply.header("PAYMENT-RESPONSE", encodePaymentResponseHeader({
              payment_id: paymentId,
              tx_hash: settlement.txHash,
              status: settlement.status
            }));
            return reply.code(201).send(created);
          } catch (error) {
            if (allowanceReserved) {
              await rollbackAllowanceSpend(opts.db, agent.workspaceId, agent.sub, quote.amountUsdCents).catch(() => undefined);
            }

            await markTransactionFailed(opts.db, agent.workspaceId, paymentId).catch(() => undefined);
            await logAudit(opts.db, {
              event: "x402_payment_failed",
              actorId: agent.sub,
              actorType: "agent",
              requesterId: agent.sub,
              workspaceId: agent.workspaceId,
              secretName,
              action: "x402_payment_failed",
              ip: req.ip,
              metadata: {
                payment_id: paymentId,
                message: error instanceof Error ? error.message : "x402_payment_failed"
              }
            }).catch(() => undefined);

            if (error instanceof X402ServiceError) {
              return reply.code(error.statusCode).send({ error: error.message, code: error.code });
            }

            return reply.code(502).send({ error: "x402 payment processing failed", code: "x402_payment_failed" });
          } finally {
            await releaseInflightLease(opts.db, agent.workspaceId, agent.sub, paymentId).catch(() => undefined);
          }
        }
      }

      const created = await createExchangeRequestRecord({
        publicKey: req.body.public_key,
        secretName,
        purpose,
        fulfillerHint,
        priorExchangeId,
        requesterId: agent.sub,
        workspaceId: agent.workspaceId ?? undefined,
        decision,
        allowedFulfillerId,
        ip: req.ip
      });

      return reply.code(201).send(created);
    }
  );

  app.post<{ Body: { fulfillment_token: string } }>(
    "/fulfill",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["fulfillment_token"],
          properties: {
            fulfillment_token: { type: "string", minLength: 32, maxLength: 4096 }
          }
        }
      }
    },
    async (req, reply) => {
      const agent = await requireAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      let claims;
      try {
        claims = await verifyFulfillmentToken(req.body.fulfillment_token, opts.hmacSecret);
      } catch {
        return reply.code(401).send({ error: "Invalid fulfillment token" });
      }

      const exchange = await opts.store.getExchange(claims.exchange_id);
      if (!exchange) {
        return notAvailable(reply);
      }

      if (
        exchange.requesterId !== claims.requester_id ||
        exchange.workspaceId !== (claims.workspace_id ?? exchange.workspaceId) ||
        exchange.secretName !== claims.secret_name ||
        exchange.purpose !== claims.purpose
      ) {
        return reply.code(409).send({ error: "Exchange token no longer matches request" });
      }

      if (!workspaceMatches(exchange.workspaceId, agent.workspaceId)) {
        return notAvailable(reply);
      }

      let currentResolvedPolicy;
      let currentPolicy;
      try {
        currentResolvedPolicy = await opts.policyResolver.resolve(exchange.workspaceId);
        currentPolicy = currentResolvedPolicy.engine.evaluate({
          requesterId: exchange.requesterId,
          requesterWorkspaceId: exchange.workspaceId,
          secretName: exchange.secretName,
          purpose: exchange.purpose,
          fulfillerHint: agent.sub,
          fulfillerWorkspaceId: agent.workspaceId ?? undefined
        });
      } catch (error) {
        return sendWorkspacePolicyError(reply, error);
      }
      if (!currentPolicy) {
        return reply.code(409).send({ error: "Exchange policy no longer allows fulfillment" });
      }

      let resolvedCurrentPolicy;
      try {
        resolvedCurrentPolicy = await resolveDecision(
          exchange.requesterId,
          exchange.workspaceId,
          exchange.secretName,
          exchange.purpose,
          agent.sub,
          agent.workspaceId ?? undefined
        );
      } catch (error) {
        return sendWorkspacePolicyError(reply, error);
      }
      if (!resolvedCurrentPolicy) {
        return reply.code(409).send({ error: "Exchange policy no longer allows fulfillment" });
      }

      const currentDecision = resolvedCurrentPolicy.decision;
      if (currentDecision.mode !== "allow") {
        return reply.code(409).send({
          error:
            resolvedCurrentPolicy.approvalRecordStatus === "rejected"
              ? "Exchange approval was rejected"
              : currentDecision.mode === "pending_approval"
                ? "Exchange policy now requires approval before fulfillment"
                : "Exchange policy no longer allows fulfillment"
        });
      }

      const currentPolicyHash = hashPolicyDecision(
        currentDecision,
        resolvedCurrentPolicy.allowedFulfillerId,
        exchange.workspaceId
      );
      if (currentPolicyHash !== claims.policy_hash || currentPolicyHash !== exchange.policyHash) {
        return reply.code(409).send({ error: "Exchange policy changed; requester must create a new exchange" });
      }

      if (exchange.status !== "pending") {
        return reply.code(409).send({ error: "Exchange is no longer pending" });
      }

      if (exchange.allowedFulfillerId !== agent.sub || resolvedCurrentPolicy.allowedFulfillerId !== agent.sub) {
        return reply.code(409).send({ error: "Exchange is reserved for a different fulfiller" });
      }

      const reserved = await opts.store.reserveExchange(exchange.exchangeId, agent.sub);
      if (!reserved) {
        return reply.code(409).send({ error: "Exchange is no longer pending" });
      }

      await appendLifecycleRecord(opts.store, {
        eventType: "exchange_reserved",
        exchangeId: reserved.exchangeId,
        approvalReference: reserved.policyDecision.approvalReference ?? null,
        requesterId: reserved.requesterId,
        workspaceId: reserved.workspaceId,
        secretName: reserved.secretName,
        purpose: reserved.purpose,
        fulfillerHint: reserved.fulfillerHint,
        actorId: agent.sub,
        status: reserved.status,
        priorStatus: exchange.status,
        reason: null,
        policyRuleId: reserved.policyDecision.ruleId,
        metadata: null,
        createdAt: nowSeconds()
      });

      await logAudit(opts.db, {
        event: "exchange_reserved",
        actorId: agent.sub,
        actorType: "agent",
        exchangeId: reserved.exchangeId,
        requesterId: reserved.requesterId,
        workspaceId: reserved.workspaceId ?? null,
        fulfilledBy: agent.sub,
        secretName: reserved.secretName,
        policyRuleId: reserved.policyDecision.ruleId,
        approvalReference: reserved.policyDecision.approvalReference ?? null,
        action: "exchange_reserve",
        ip: req.ip
      });

      return reply.send({
        exchange_id: reserved.exchangeId,
        status: reserved.status,
        fulfilled_by: agent.sub,
        requester_id: reserved.requesterId,
        requester_public_key: reserved.requesterPublicKey,
        secret_name: reserved.secretName,
        purpose: reserved.purpose,
        expires_at: reserved.expiresAt,
        policy: toPolicyResponse(reserved.policyDecision)
      });
    }
  );

  app.post<{ Params: { id: string }; Body: { enc: string; ciphertext: string } }>(
    "/submit/:id",
    {
      schema: {
        params: exchangeParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["enc", "ciphertext"],
          properties: {
            enc: { type: "string", minLength: 4, maxLength: 4096, pattern: BASE64_PATTERN },
            ciphertext: { type: "string", minLength: 4, maxLength: 524288, pattern: BASE64_PATTERN }
          }
        }
      }
    },
    async (req, reply) => {
      const agent = await requireAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      const exchange = await opts.store.getExchange(req.params.id);
      if (!exchange) {
        return notAvailable(reply);
      }

      if (!workspaceMatches(exchange.workspaceId, agent.workspaceId)) {
        return notAvailable(reply);
      }

      if (exchange.status !== "reserved") {
        return reply.code(409).send({ error: "Exchange is not reserved" });
      }

      if (exchange.fulfilledBy !== agent.sub) {
        return reply.code(409).send({ error: "Exchange is reserved for a different fulfiller" });
      }

      const expiresAt = nowSeconds() + submittedTtl;
      const submitted = await opts.store.submitExchange(
        exchange.exchangeId,
        agent.sub,
        req.body.enc,
        req.body.ciphertext,
        expiresAt,
        submittedTtl
      );
      if (!submitted) {
        return reply.code(409).send({ error: "Exchange submission failed" });
      }

      await appendLifecycleRecord(opts.store, {
        eventType: "exchange_submitted",
        exchangeId: submitted.exchangeId,
        approvalReference: submitted.policyDecision.approvalReference ?? null,
        requesterId: submitted.requesterId,
        workspaceId: submitted.workspaceId,
        secretName: submitted.secretName,
        purpose: submitted.purpose,
        fulfillerHint: submitted.fulfillerHint,
        actorId: agent.sub,
        status: submitted.status,
        priorStatus: exchange.status,
        reason: null,
        policyRuleId: submitted.policyDecision.ruleId,
        metadata: null,
        createdAt: nowSeconds()
      });

      await logAudit(opts.db, {
        event: "exchange_submitted",
        actorId: agent.sub,
        actorType: "agent",
        exchangeId: submitted.exchangeId,
        requesterId: submitted.requesterId,
        workspaceId: submitted.workspaceId ?? null,
        fulfilledBy: agent.sub,
        secretName: submitted.secretName,
        policyRuleId: submitted.policyDecision.ruleId,
        approvalReference: submitted.policyDecision.approvalReference ?? null,
        action: "exchange_submit",
        ip: req.ip
      });

      return reply.code(201).send({
        status: submitted.status,
        retrieve_by: submitted.expiresAt,
        fulfilled_by: agent.sub
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/retrieve/:id",
    {
      schema: {
        params: exchangeParamsSchema
      }
    },
    async (req, reply) => {
      const agent = await requireAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      const exchange = await opts.store.getExchange(req.params.id);
      if (!exchange || exchange.requesterId !== agent.sub || !workspaceMatches(exchange.workspaceId, agent.workspaceId)) {
        return notAvailable(reply);
      }

      if (exchange.status !== "submitted") {
        return reply.code(409).send({ error: "Exchange is not ready" });
      }

      const retrieved = await opts.store.atomicRetrieveExchange(
        exchange.exchangeId,
        agent.sub,
        exchange.workspaceId ?? agent.workspaceId ?? undefined
      );
      if (!retrieved || !retrieved.enc || !retrieved.ciphertext) {
        return notAvailable(reply);
      }

      await appendLifecycleRecord(opts.store, {
        eventType: "exchange_retrieved",
        exchangeId: retrieved.exchangeId,
        approvalReference: retrieved.policyDecision.approvalReference ?? null,
        requesterId: retrieved.requesterId,
        workspaceId: retrieved.workspaceId,
        secretName: retrieved.secretName,
        purpose: retrieved.purpose,
        fulfillerHint: retrieved.fulfillerHint,
        actorId: agent.sub,
        status: "retrieved",
        priorStatus: exchange.status,
        reason: null,
        policyRuleId: retrieved.policyDecision.ruleId,
        metadata: {
          fulfilled_by: retrieved.fulfilledBy ?? null
        },
        createdAt: nowSeconds()
      });

      await logAudit(opts.db, {
        event: "exchange_retrieved",
        actorId: agent.sub,
        actorType: "agent",
        exchangeId: retrieved.exchangeId,
        requesterId: agent.sub,
        workspaceId: retrieved.workspaceId ?? agent.workspaceId ?? null,
        fulfilledBy: retrieved.fulfilledBy,
        secretName: retrieved.secretName,
        policyRuleId: retrieved.policyDecision.ruleId,
        approvalReference: retrieved.policyDecision.approvalReference ?? null,
        action: "exchange_retrieve",
        ip: req.ip
      });

      return reply.send({
        enc: retrieved.enc,
        ciphertext: retrieved.ciphertext,
        secret_name: retrieved.secretName,
        fulfilled_by: retrieved.fulfilledBy ?? null
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/approval/:id",
    {
      schema: {
        params: approvalParamsSchema
      }
    },
    async (req, reply) => {
      const agent = await requireAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      const approval = await opts.store.getApprovalRequest(req.params.id);
      if (!approval) {
        return notAvailable(reply);
      }

      if (!workspaceMatches(approval.workspaceId, agent.workspaceId)) {
        return notAvailable(reply);
      }

      if (approval.requesterId !== agent.sub && !isApproverAuthorized(approval, agent.sub)) {
        return notAvailable(reply);
      }

      return reply.send(toApprovalResponse(approval));
    }
  );

  app.post<{ Params: { id: string } }>(
    "/approval/:id/approve",
    {
      schema: {
        params: approvalParamsSchema
      }
    },
    async (req, reply) => {
      const agent = await requireAgentAuth(req, reply);
      if (!agent) {
        return;
      }
      const result = await decideApproval({
        approvalReference: req.params.id,
        status: "approved",
        actorId: agent.sub,
        actorType: "agent",
        workspaceId: agent.workspaceId ?? undefined,
        ip: req.ip
      });

      if (result.kind === "not_available") {
        return notAvailable(reply);
      }

      if (result.kind === "conflict") {
        return reply.code(409).send({ error: "Approval is no longer pending" });
      }

      return reply.send({
        approval_reference: result.approval.approvalReference,
        status: result.approval.status,
        decided_at: result.approval.decidedAt,
        decided_by: result.approval.decidedBy
      });
    }
  );

  app.post<{ Params: { id: string } }>(
    "/approval/:id/reject",
    {
      schema: {
        params: approvalParamsSchema
      }
    },
    async (req, reply) => {
      const agent = await requireAgentAuth(req, reply);
      if (!agent) {
        return;
      }
      const result = await decideApproval({
        approvalReference: req.params.id,
        status: "rejected",
        actorId: agent.sub,
        actorType: "agent",
        workspaceId: agent.workspaceId ?? undefined,
        ip: req.ip
      });

      if (result.kind === "not_available") {
        return notAvailable(reply);
      }

      if (result.kind === "conflict") {
        return reply.code(409).send({ error: "Approval is no longer pending" });
      }

      return reply.send({
        approval_reference: result.approval.approvalReference,
        status: result.approval.status,
        decided_at: result.approval.decidedAt,
        decided_by: result.approval.decidedBy
      });
    }
  );

  app.post<{ Params: { id: string } }>(
    "/admin/approval/:id/approve",
    {
      schema: {
        params: approvalParamsSchema
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      const result = await decideApproval({
        approvalReference: req.params.id,
        status: "approved",
        actorId: user.sub,
        actorType: "user",
        workspaceId: user.workspaceId,
        ip: req.ip
      });

      if (result.kind === "not_available") {
        return notAvailable(reply);
      }

      if (result.kind === "conflict") {
        return reply.code(409).send({ error: "Approval is no longer pending" });
      }

      return reply.send({
        approval_reference: result.approval.approvalReference,
        status: result.approval.status,
        decided_at: result.approval.decidedAt,
        decided_by: result.approval.decidedBy
      });
    }
  );

  app.post<{ Params: { id: string } }>(
    "/admin/approval/:id/reject",
    {
      schema: {
        params: approvalParamsSchema
      }
    },
    async (req, reply) => {
      const user = await requireUserRole("workspace_operator")(req, reply);
      if (!user) {
        return;
      }

      const result = await decideApproval({
        approvalReference: req.params.id,
        status: "rejected",
        actorId: user.sub,
        actorType: "user",
        workspaceId: user.workspaceId,
        ip: req.ip
      });

      if (result.kind === "not_available") {
        return notAvailable(reply);
      }

      if (result.kind === "conflict") {
        return reply.code(409).send({ error: "Approval is no longer pending" });
      }

      return reply.send({
        approval_reference: result.approval.approvalReference,
        status: result.approval.status,
        decided_at: result.approval.decidedAt,
        decided_by: result.approval.decidedBy
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/status/:id",
    {
      schema: {
        params: exchangeParamsSchema
      }
    },
    async (req, reply) => {
      const agent = await requireAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      const exchange = await opts.store.getExchange(req.params.id);
      if (!exchange || exchange.requesterId !== agent.sub || !workspaceMatches(exchange.workspaceId, agent.workspaceId)) {
        return notAvailable(reply);
      }

      return reply.send({ status: exchange.status });
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/revoke/:id",
    {
      schema: {
        params: exchangeParamsSchema
      }
    },
    async (req, reply) => {
      const agent = await requireAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      const exchange = await opts.store.getExchange(req.params.id);
      const isAdmin = agent.admin === true;
      if (!exchange || !workspaceMatches(exchange.workspaceId, agent.workspaceId) || (exchange.requesterId !== agent.sub && !isAdmin)) {
        return notAvailable(reply);
      }

      if (exchange.status === "revoked") {
        return reply.send({ status: "revoked" });
      }

      const priorStatus = exchange.status;
      const revoked = await opts.store.revokeExchange(exchange.exchangeId, revokedTtl);
      if (!revoked) {
        return notAvailable(reply);
      }

      await appendLifecycleRecord(opts.store, {
        eventType: "exchange_revoked",
        exchangeId: revoked.exchangeId,
        approvalReference: revoked.policyDecision.approvalReference ?? null,
        requesterId: revoked.requesterId,
        workspaceId: revoked.workspaceId,
        secretName: revoked.secretName,
        purpose: revoked.purpose,
        fulfillerHint: revoked.fulfillerHint,
        actorId: agent.sub,
        status: revoked.status,
        priorStatus,
        reason: isAdmin ? "revoked by admin" : "revoked by requester",
        policyRuleId: revoked.policyDecision.ruleId,
        metadata: null,
        createdAt: nowSeconds()
      });

      await logAudit(opts.db, {
        event: "exchange_revoked",
        actorId: agent.sub,
        actorType: "agent",
        exchangeId: revoked.exchangeId,
        requesterId: revoked.requesterId,
        workspaceId: revoked.workspaceId ?? null,
        fulfilledBy: revoked.fulfilledBy,
        secretName: revoked.secretName,
        policyRuleId: revoked.policyDecision.ruleId,
        approvalReference: revoked.policyDecision.approvalReference ?? null,
        action: "exchange_revoke",
        ip: req.ip
      });

      return reply.send({ status: "revoked" });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/admin/exchange/:id",
    {
      schema: {
        params: exchangeParamsSchema
      }
    },
    async (req, reply) => {
      const agent = await requireAdminAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      const exchange = await opts.store.getExchange(req.params.id);
      if (!exchange || !workspaceMatches(exchange.workspaceId, agent.workspaceId)) {
        return notAvailable(reply);
      }

      return reply.send(toExchangeAdminResponse(exchange));
    }
  );

  app.get<{ Params: { id: string } }>(
    "/admin/exchange/:id/lifecycle",
    {
      schema: {
        params: exchangeParamsSchema
      }
    },
    async (req, reply) => {
      const agent = await requireAdminAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      const records = await opts.store.listLifecycleRecordsByExchange(req.params.id);
      if (
        records.length === 0 ||
        !records.some((record) => workspaceMatches(record.workspaceId, agent.workspaceId))
      ) {
        return notAvailable(reply);
      }

      return reply.send({
        exchange_id: req.params.id,
        records: records.filter((record) => workspaceMatches(record.workspaceId, agent.workspaceId)).map(toLifecycleResponse)
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/admin/approval/:id/history",
    {
      schema: {
        params: approvalParamsSchema
      }
    },
    async (req, reply) => {
      const agent = await requireAdminAgentAuth(req, reply);
      if (!agent) {
        return;
      }

      const approval = await opts.store.getApprovalRequest(req.params.id);
      const records = await opts.store.listLifecycleRecordsByApproval(req.params.id);
      if (
        (!approval || !workspaceMatches(approval.workspaceId, agent.workspaceId)) &&
        !records.some((record) => workspaceMatches(record.workspaceId, agent.workspaceId))
      ) {
        return notAvailable(reply);
      }

      return reply.send({
        approval_reference: req.params.id,
        approval: approval && workspaceMatches(approval.workspaceId, agent.workspaceId) ? toApprovalResponse(approval) : null,
        records: records.filter((record) => workspaceMatches(record.workspaceId, agent.workspaceId)).map(toLifecycleResponse)
      });
    }
  );
}
