import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { generateConfirmationCode, generateRequestId, generateScopedSigs } from "../services/crypto.js";
import { requireBrowserSig, requireGatewayAuth } from "../middleware/auth.js";
import { logAudit } from "../services/audit.js";
import type { RequestStore } from "../types.js";

const REQUEST_ID_PATTERN = "^[a-f0-9]{64}$";
const SIG_PATTERN = "^[0-9]{10,13}\\.[A-Za-z0-9_-]{43}$";
const BASE64_PATTERN = "^[A-Za-z0-9+/]+={0,2}$";

const requestParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", pattern: REQUEST_ID_PATTERN }
  }
} as const;

const sigQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["sig"],
  properties: {
    sig: { type: "string", pattern: SIG_PATTERN }
  }
} as const;

export interface SecretRoutesOptions extends FastifyPluginOptions {
  store: RequestStore;
  hmacSecret: string;
  requestTtlSeconds?: number;
  submittedTtlSeconds?: number;
  uiBaseUrl?: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isHostedModeEnabled(): boolean {
  const raw = process.env.SPS_HOSTED_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function requestOwnedByAgent(
  request: { requesterId?: string; workspaceId?: string },
  agent: { sub: string; workspaceId?: string | null }
): boolean {
  if (request.requesterId && request.requesterId !== agent.sub) {
    return false;
  }

  if (isHostedModeEnabled()) {
    return !!request.workspaceId && !!agent.workspaceId && request.workspaceId === agent.workspaceId;
  }

  if (request.workspaceId && agent.workspaceId && request.workspaceId !== agent.workspaceId) {
    return false;
  }

  return true;
}

export async function registerSecretRoutes(app: FastifyInstance, opts: SecretRoutesOptions): Promise<void> {
  const requestTtl = opts.requestTtlSeconds ?? 180;
  const submittedTtl = opts.submittedTtlSeconds ?? 60;
  const uiBaseUrl = opts.uiBaseUrl ?? process.env.SPS_UI_BASE_URL ?? "http://localhost:5173";

  app.post<{ Body: { public_key: string; description: string } }>(
    "/request",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["public_key", "description"],
          properties: {
            public_key: { type: "string", minLength: 4, maxLength: 2048, pattern: BASE64_PATTERN },
            description: { type: "string", minLength: 1, maxLength: 512 }
          }
        }
      }
    },
    async (req, reply) => {
      const payload = await requireGatewayAuth(req, reply);
      if (!payload) {
        return;
      }

      if (!req.body.description.trim()) {
        return reply.code(400).send({ error: "description must not be blank" });
      }

      const requestId = generateRequestId();
      const confirmationCode = generateConfirmationCode();
      const createdAt = nowSeconds();
      const expiresAt = createdAt + requestTtl;

      await opts.store.setRequest(
        {
          requestId,
          requesterId: payload.sub,
          workspaceId: payload.workspaceId ?? undefined,
          publicKey: req.body.public_key,
          description: req.body.description,
          confirmationCode,
          status: "pending",
          createdAt,
          expiresAt
        },
        requestTtl
      );

      const sigs = generateScopedSigs(requestId, expiresAt, opts.hmacSecret);
      const secretUrl = `${uiBaseUrl}/?id=${requestId}&metadata_sig=${encodeURIComponent(sigs.metadataSig)}&submit_sig=${encodeURIComponent(sigs.submitSig)}`;

      logAudit({
        event: "request_created",
        requestId,
        agentId: payload.sub,
        workspaceId: payload.workspaceId ?? null,
        action: "request",
        ip: req.ip
      });

      return reply.code(201).send({
        request_id: requestId,
        confirmation_code: confirmationCode,
        secret_url: secretUrl
      });
    }
  );

  app.get<{ Params: { id: string }; Querystring: { sig?: string } }>(
    "/metadata/:id",
    {
      schema: {
        params: requestParamsSchema,
        querystring: sigQuerySchema
      }
    },
    async (req, reply) => {
      const auth = requireBrowserSig(req, reply, "metadata", opts.hmacSecret);
      if (!auth) {
        return;
      }

      const record = await opts.store.getRequest(req.params.id);
      if (!record) {
        return reply.code(410).send({ error: "Request expired" });
      }

      return reply.send({
        public_key: record.publicKey,
        description: record.description,
        confirmation_code: record.confirmationCode,
        expiry: auth.exp
      });
    }
  );

  app.post<{ Params: { id: string }; Querystring: { sig?: string }; Body: { enc: string; ciphertext: string } }>(
    "/submit/:id",
    {
      schema: {
        params: requestParamsSchema,
        querystring: sigQuerySchema,
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
      const auth = requireBrowserSig(req, reply, "submit", opts.hmacSecret);
      if (!auth) {
        return;
      }

      const record = await opts.store.getRequest(req.params.id);
      if (!record) {
        return reply.code(410).send({ error: "Request expired" });
      }

      if (record.status === "submitted") {
        return reply.code(409).send({ error: "Already submitted" });
      }

      const next = await opts.store.updateRequest(
        req.params.id,
        {
          status: "submitted",
          enc: req.body.enc,
          ciphertext: req.body.ciphertext,
          expiresAt: nowSeconds() + submittedTtl
        },
        submittedTtl
      );

      if (!next) {
        return reply.code(410).send({ error: "Request expired" });
      }

      logAudit({
        event: "secret_submitted",
        requestId: req.params.id,
        action: "submit",
        ip: req.ip
      });

      return reply.code(201).send({ status: "submitted" });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/retrieve/:id",
    {
      schema: {
        params: requestParamsSchema
      }
    },
    async (req, reply) => {
      const payload = await requireGatewayAuth(req, reply);
      if (!payload) {
        return;
      }

      const current = await opts.store.getRequest(req.params.id);
      if (!current) {
        return reply.code(410).send({ error: "Not available" });
      }

      if (!requestOwnedByAgent(current, payload)) {
        return reply.code(410).send({ error: "Not available" });
      }

      if (current.status !== "submitted") {
        return reply.code(409).send({ error: "Not submitted yet" });
      }

      const retrieved = await opts.store.atomicRetrieveAndDelete(
        req.params.id,
        current.requesterId ?? payload.sub,
        current.workspaceId ?? payload.workspaceId ?? undefined
      );
      if (!retrieved || !retrieved.enc || !retrieved.ciphertext) {
        return reply.code(410).send({ error: "Not available" });
      }

      logAudit({
        event: "secret_retrieved",
        requestId: req.params.id,
        agentId: payload.sub,
        workspaceId: payload.workspaceId ?? null,
        action: "retrieve",
        ip: req.ip
      });

      return reply.send({
        enc: retrieved.enc,
        ciphertext: retrieved.ciphertext
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/status/:id",
    {
      schema: {
        params: requestParamsSchema
      }
    },
    async (req, reply) => {
      const payload = await requireGatewayAuth(req, reply);
      if (!payload) {
        return;
      }

      const record = await opts.store.getRequest(req.params.id);
      if (!record) {
        return reply.code(410).send({ status: "expired" });
      }

      if (!requestOwnedByAgent(record, payload)) {
        return reply.code(410).send({ status: "expired" });
      }

      return reply.send({ status: record.status });
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/revoke/:id",
    {
      schema: {
        params: requestParamsSchema
      }
    },
    async (req, reply) => {
      const payload = await requireGatewayAuth(req, reply);
      if (!payload) {
        return;
      }

      const deleted = await opts.store.deleteRequest(
        req.params.id,
        payload.sub,
        payload.workspaceId ?? undefined
      );
      if (!deleted) {
        return reply.code(410).send({ error: "Not available" });
      }

      logAudit({
        event: "request_revoked",
        requestId: req.params.id,
        agentId: payload.sub,
        workspaceId: payload.workspaceId ?? null,
        action: "revoke",
        ip: req.ip
      });

      return reply.code(204).send();
    }
  );
}
