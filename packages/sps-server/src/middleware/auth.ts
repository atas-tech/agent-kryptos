import { readFile } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { verifyPayload } from "../services/crypto.js";
import type { RequestScope } from "../types.js";

interface JwksCacheEntry {
  sourceKey: string;
  verifier: ReturnType<typeof createLocalJWKSet>;
  expiresAtMs: number;
}

let jwksCache: JwksCacheEntry | null = null;

function getJwksCacheTtlMs(): number {
  const raw = process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS;
  if (!raw) {
    return 60_000;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 60_000;
  }

  return Math.floor(parsed);
}

function getJwksSource(): { sourceKey: string; kind: "url" | "file"; value: string } | null {
  const url = process.env.SPS_GATEWAY_JWKS_URL?.trim();
  if (url) {
    return { sourceKey: `url:${url}`, kind: "url", value: url };
  }

  const file = process.env.SPS_GATEWAY_JWKS_FILE?.trim();
  if (file) {
    return { sourceKey: `file:${file}`, kind: "file", value: file };
  }

  return null;
}

async function loadJwks(source: { kind: "url" | "file"; value: string }): Promise<JSONWebKeySet> {
  if (source.kind === "file") {
    return JSON.parse(await readFile(source.value, "utf8")) as JSONWebKeySet;
  }

  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is unavailable for SPS_GATEWAY_JWKS_URL");
  }

  const response = await globalThis.fetch(source.value, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`);
  }

  return (await response.json()) as JSONWebKeySet;
}

export function __resetJwksCacheForTests(): void {
  jwksCache = null;
}

async function getJwksVerifier() {
  const source = getJwksSource();
  if (!source) {
    return null;
  }

  const now = Date.now();
  if (jwksCache && jwksCache.sourceKey === source.sourceKey && now < jwksCache.expiresAtMs) {
    return jwksCache.verifier;
  }

  const jwks = await loadJwks(source);
  const verifier = createLocalJWKSet(jwks);
  const ttlMs = getJwksCacheTtlMs();

  jwksCache = {
    sourceKey: source.sourceKey,
    verifier,
    expiresAtMs: now + ttlMs
  };

  return verifier;
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

export async function requireGatewayAuth(req: FastifyRequest, reply: FastifyReply): Promise<JWTPayload | null> {
  return verifyGatewayLikeToken(req, reply);
}

export async function requireAgentAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<(JWTPayload & { sub: string }) | null> {
  const payload = await verifyGatewayLikeToken(req, reply);
  if (!payload) {
    return null;
  }

  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    reply.code(401).send({ error: "Invalid agent identity" });
    return null;
  }

  return payload as JWTPayload & { sub: string };
}

async function verifyGatewayLikeToken(req: FastifyRequest, reply: FastifyReply): Promise<JWTPayload | null> {
  const token = bearerToken(req);
  if (!token) {
    reply.code(401).send({ error: "Missing bearer token" });
    return null;
  }

  let jwks: ReturnType<typeof createLocalJWKSet> | null = null;
  try {
    jwks = await getJwksVerifier();
  } catch {
    reply.code(500).send({ error: "Gateway JWK unavailable" });
    return null;
  }

  if (!jwks) {
    reply.code(500).send({ error: "Gateway JWK not configured" });
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: "gateway",
      audience: "sps"
    });

    if (payload.role !== "gateway" || !payload.sub) {
      reply.code(401).send({ error: "Invalid gateway claims" });
      return null;
    }

    return payload;
  } catch {
    reply.code(401).send({ error: "Invalid token" });
    return null;
  }
}

export function requireBrowserSig(
  req: FastifyRequest<{ Params: { id: string }; Querystring: { sig?: string } }>,
  reply: FastifyReply,
  scope: RequestScope,
  hmacSecret: string
): { exp: number } | null {
  const sig = req.query.sig;
  if (!sig) {
    reply.code(403).send({ error: "Missing signature" });
    return null;
  }

  const result = verifyPayload(req.params.id, scope, sig, hmacSecret);
  if (!result.ok) {
    if (result.reason === "expired") {
      reply.code(410).send({ error: "Request expired" });
      return null;
    }

    reply.code(403).send({ error: "Invalid signature" });
    return null;
  }

  return { exp: result.exp };
}
