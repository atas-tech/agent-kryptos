import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import { requireAgentAuth } from "../middleware/auth.js";
import { generateRequestId, signFulfillmentToken, verifyFulfillmentToken } from "../services/crypto.js";
import { logAudit } from "../services/audit.js";
import { ExchangePolicyEngine, hashPolicyDecision } from "../services/policy.js";
import type { PolicyDecision, RequestStore } from "../types.js";

const EXCHANGE_ID_PATTERN = "^[a-f0-9]{64}$";
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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toPolicyResponse(decision: PolicyDecision) {
  return {
    mode: decision.mode,
    approval_required: decision.approvalRequired,
    rule_id: decision.ruleId,
    reason: decision.reason,
    approval_reference: decision.approvalReference ?? null
  };
}

function notAvailable(reply: FastifyReply) {
  return reply.code(410).send({ error: "Not available" });
}

export interface ExchangeRoutesOptions extends FastifyPluginOptions {
  store: RequestStore;
  hmacSecret: string;
  policyEngine: ExchangePolicyEngine;
  requestTtlSeconds?: number;
  submittedTtlSeconds?: number;
  revokedTtlSeconds?: number;
}

export async function registerExchangeRoutes(app: FastifyInstance, opts: ExchangeRoutesOptions): Promise<void> {
  const requestTtl = opts.requestTtlSeconds ?? 180;
  const submittedTtl = opts.submittedTtlSeconds ?? 60;
  const revokedTtl = opts.revokedTtlSeconds ?? 300;

  app.post<{
    Body: { public_key: string; secret_name: string; purpose: string; fulfiller_hint: string };
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
            fulfiller_hint: { type: "string", minLength: 1, maxLength: 512 }
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
      if (!secretName || !purpose || !fulfillerHint) {
        return reply.code(400).send({ error: "secret_name, purpose, and fulfiller_hint must not be blank" });
      }

      const evaluated = opts.policyEngine.evaluate({
        requesterId: agent.sub,
        secretName,
        purpose,
        fulfillerHint
      });

      if (!evaluated) {
        logAudit({
          event: "exchange_denied",
          requesterId: agent.sub,
          secretName,
          fulfilledBy: fulfillerHint,
          action: "exchange_request_denied",
          ip: req.ip
        });
        return reply.code(403).send({ error: "Exchange not allowed" });
      }

      const createdAt = nowSeconds();
      const expiresAt = createdAt + requestTtl;
      const exchangeId = generateRequestId();
      const policyHash = hashPolicyDecision(evaluated.decision, evaluated.allowedFulfillerId);
      const fulfillmentToken = await signFulfillmentToken(
        {
          exchange_id: exchangeId,
          requester_id: agent.sub,
          secret_name: secretName,
          purpose,
          policy_hash: policyHash,
          approval_reference: evaluated.decision.approvalReference ?? null
        },
        opts.hmacSecret,
        expiresAt
      );

      await opts.store.setExchange(
        {
          exchangeId,
          requesterId: agent.sub,
          requesterPublicKey: req.body.public_key,
          secretName,
          purpose,
          fulfillerHint,
          allowedFulfillerId: evaluated.allowedFulfillerId,
          policyDecision: evaluated.decision,
          policyHash,
          status: "pending",
          createdAt,
          expiresAt
        },
        requestTtl
      );

      logAudit({
        event: "exchange_requested",
        exchangeId,
        requesterId: agent.sub,
        secretName,
        policyRuleId: evaluated.decision.ruleId,
        approvalReference: evaluated.decision.approvalReference ?? null,
        action: "exchange_request",
        ip: req.ip
      });

      return reply.code(201).send({
        exchange_id: exchangeId,
        status: "pending",
        expires_at: expiresAt,
        fulfillment_token: fulfillmentToken,
        policy: toPolicyResponse(evaluated.decision)
      });
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
        exchange.secretName !== claims.secret_name ||
        exchange.purpose !== claims.purpose
      ) {
        return reply.code(409).send({ error: "Exchange token no longer matches request" });
      }

      const currentPolicy = opts.policyEngine.evaluate({
        requesterId: exchange.requesterId,
        secretName: exchange.secretName,
        purpose: exchange.purpose,
        fulfillerHint: agent.sub
      });
      if (!currentPolicy) {
        return reply.code(409).send({ error: "Exchange policy no longer allows fulfillment" });
      }

      const currentPolicyHash = hashPolicyDecision(currentPolicy.decision, currentPolicy.allowedFulfillerId);
      if (currentPolicyHash !== claims.policy_hash || currentPolicyHash !== exchange.policyHash) {
        return reply.code(409).send({ error: "Exchange policy changed; requester must create a new exchange" });
      }

      if (exchange.status !== "pending") {
        return reply.code(409).send({ error: "Exchange is no longer pending" });
      }

      if (exchange.allowedFulfillerId !== agent.sub || currentPolicy.allowedFulfillerId !== agent.sub) {
        return reply.code(409).send({ error: "Exchange is reserved for a different fulfiller" });
      }

      const reserved = await opts.store.reserveExchange(exchange.exchangeId, agent.sub);
      if (!reserved) {
        return reply.code(409).send({ error: "Exchange is no longer pending" });
      }

      logAudit({
        event: "exchange_reserved",
        exchangeId: reserved.exchangeId,
        requesterId: reserved.requesterId,
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

      logAudit({
        event: "exchange_submitted",
        exchangeId: submitted.exchangeId,
        requesterId: submitted.requesterId,
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
      if (!exchange || exchange.requesterId !== agent.sub) {
        return notAvailable(reply);
      }

      if (exchange.status !== "submitted") {
        return reply.code(409).send({ error: "Exchange is not ready" });
      }

      const retrieved = await opts.store.atomicRetrieveExchange(exchange.exchangeId, agent.sub);
      if (!retrieved || !retrieved.enc || !retrieved.ciphertext) {
        return notAvailable(reply);
      }

      logAudit({
        event: "exchange_retrieved",
        exchangeId: retrieved.exchangeId,
        requesterId: agent.sub,
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
      if (!exchange || exchange.requesterId !== agent.sub) {
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
      if (!exchange || (exchange.requesterId !== agent.sub && !isAdmin)) {
        return notAvailable(reply);
      }

      if (exchange.status === "revoked") {
        return reply.send({ status: "revoked" });
      }

      const revoked = await opts.store.revokeExchange(exchange.exchangeId, revokedTtl);
      if (!revoked) {
        return notAvailable(reply);
      }

      logAudit({
        event: "exchange_revoked",
        exchangeId: revoked.exchangeId,
        requesterId: revoked.requesterId,
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
}
