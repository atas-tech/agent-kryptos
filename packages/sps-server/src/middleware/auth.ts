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

interface AuthProviderConfig {
  name: string;
  sourceKey: string;
  kind: "url" | "file";
  value: string;
  issuers: string[];
  audiences: string[];
  requireSpiffe: boolean;
}

export interface AuthenticatedAgentClaims extends JWTPayload {
  sub: string;
  role: string;
  admin?: boolean;
  authProvider?: string | null;
  spiffeId?: string | null;
  workloadMode?: string | null;
}

const jwksCache = new Map<string, JwksCacheEntry>();

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
  jwksCache.clear();
}

function normalizeStringList(
  value: unknown,
  fallback: string[] = []
): string[] {
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return normalized.length > 0 ? normalized : fallback;
  }

  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return fallback;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return fallback;
}

function providerFromLegacyEnv(): AuthProviderConfig | null {
  const source = getJwksSource();
  if (!source) {
    return null;
  }

  return {
    name: "legacy-gateway",
    sourceKey: source.sourceKey,
    kind: source.kind,
    value: source.value,
    issuers: allowedIssuers(),
    audiences: allowedAudiences(),
    requireSpiffe: requiresSpiffeIdentity()
  };
}

function authProviders(): AuthProviderConfig[] {
  const raw = process.env.SPS_AGENT_AUTH_PROVIDERS_JSON?.trim();
  if (!raw) {
    const legacy = providerFromLegacyEnv();
    return legacy ? [legacy] : [];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("SPS_AGENT_AUTH_PROVIDERS_JSON must be a JSON array");
  }

  return parsed.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const jwksUrl = typeof entry.jwks_url === "string" && entry.jwks_url.trim()
      ? entry.jwks_url.trim()
      : typeof entry.jwksUrl === "string" && entry.jwksUrl.trim()
        ? entry.jwksUrl.trim()
        : "";
    const jwksFile = typeof entry.jwks_file === "string" && entry.jwks_file.trim()
      ? entry.jwks_file.trim()
      : typeof entry.jwksFile === "string" && entry.jwksFile.trim()
        ? entry.jwksFile.trim()
        : "";

    if (!jwksUrl && !jwksFile) {
      return [];
    }

    return [{
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : `provider-${index + 1}`,
      sourceKey: jwksUrl ? `url:${jwksUrl}` : `file:${jwksFile}`,
      kind: jwksUrl ? "url" : "file",
      value: jwksUrl || jwksFile,
      issuers: normalizeStringList((entry as Record<string, unknown>).issuers ?? (entry as Record<string, unknown>).issuer, ["gateway"]),
      audiences: normalizeStringList((entry as Record<string, unknown>).audiences ?? (entry as Record<string, unknown>).audience, ["sps"]),
      requireSpiffe: parseBoolean((entry as Record<string, unknown>).require_spiffe ?? (entry as Record<string, unknown>).requireSpiffe, false)
    }];
  });
}

async function getJwksVerifier(provider: AuthProviderConfig) {
  const now = Date.now();
  const cached = jwksCache.get(provider.sourceKey);
  if (cached && now < cached.expiresAtMs) {
    return cached.verifier;
  }

  const jwks = await loadJwks({ kind: provider.kind, value: provider.value });
  const verifier = createLocalJWKSet(jwks);
  const ttlMs = getJwksCacheTtlMs();

  jwksCache.set(provider.sourceKey, {
    sourceKey: provider.sourceKey,
    verifier,
    expiresAtMs: now + ttlMs
  });

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

function parseCsvEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function allowedIssuers(): string[] {
  return parseCsvEnv("SPS_AGENT_JWT_ISSUERS", ["gateway"]);
}

function allowedAudiences(): string[] {
  return parseCsvEnv("SPS_AGENT_JWT_AUDIENCES", ["sps"]);
}

function requiresSpiffeIdentity(): boolean {
  const raw = process.env.SPS_REQUIRE_SPIFFE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function extractSpiffeId(payload: JWTPayload): string | null {
  const claim = typeof payload.spiffe_id === "string" && payload.spiffe_id.trim() ? payload.spiffe_id.trim() : null;
  const subject = typeof payload.sub === "string" && payload.sub.startsWith("spiffe://") ? payload.sub : null;

  if (claim && subject && claim !== subject) {
    return "__mismatch__";
  }

  return claim ?? subject;
}

export async function requireGatewayAuth(req: FastifyRequest, reply: FastifyReply): Promise<JWTPayload | null> {
  return requireAuthenticatedWorkload(req, reply);
}

export async function requireAgentAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedAgentClaims | null> {
  const payload = await requireAuthenticatedWorkload(req, reply);
  if (!payload) {
    return null;
  }
  return payload;
}

export async function requireAdminAgentAuth(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedAgentClaims | null> {
  const payload = await requireAuthenticatedWorkload(req, reply);
  if (!payload) {
    return null;
  }

  if (payload.admin !== true) {
    reply.code(403).send({ error: "Admin access required" });
    return null;
  }

  return payload;
}

async function verifyGatewayLikeToken(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<(JWTPayload & { auth_provider?: string }) | null> {
  const token = bearerToken(req);
  if (!token) {
    reply.code(401).send({ error: "Missing bearer token" });
    return null;
  }

  let providers: AuthProviderConfig[];
  try {
    providers = authProviders();
  } catch {
    reply.code(500).send({ error: "Invalid workload auth provider config" });
    return null;
  }

  if (providers.length === 0) {
    reply.code(500).send({ error: "Gateway JWK not configured" });
    return null;
  }

  try {
    let verifiedPayload: JWTPayload | null = null;
    let matchedProvider: AuthProviderConfig | null = null;

    for (const provider of providers) {
      const jwks = await getJwksVerifier(provider);
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: provider.issuers,
          audience: provider.audiences
        });
        verifiedPayload = payload;
        matchedProvider = provider;
        break;
      } catch {
        // Try next provider.
      }
    }

    if (!verifiedPayload || !matchedProvider) {
      reply.code(401).send({ error: "Invalid token" });
      return null;
    }

    if (verifiedPayload.role !== "gateway" || !verifiedPayload.sub) {
      reply.code(401).send({ error: "Invalid gateway claims" });
      return null;
    }

    return {
      ...verifiedPayload,
      auth_provider: matchedProvider.name
    };
  } catch {
    reply.code(500).send({ error: "Gateway JWK unavailable" });
    return null;
  }
}

async function requireAuthenticatedWorkload(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedAgentClaims | null> {
  const payload = await verifyGatewayLikeToken(req, reply);
  if (!payload) {
    return null;
  }

  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    reply.code(401).send({ error: "Invalid agent identity" });
    return null;
  }

  const spiffeId = extractSpiffeId(payload);
  if (spiffeId === "__mismatch__") {
    reply.code(401).send({ error: "Invalid SPIFFE workload claims" });
    return null;
  }

  const matchedProviderName = typeof payload.auth_provider === "string" ? payload.auth_provider : null;
  const providerRequiresSpiffe = matchedProviderName
    ? authProviders().find((provider) => provider.name === matchedProviderName)?.requireSpiffe === true
    : false;

  if ((requiresSpiffeIdentity() || providerRequiresSpiffe) && !spiffeId) {
    reply.code(401).send({ error: "SPIFFE workload identity required" });
    return null;
  }

  return {
    ...(payload as JWTPayload & { sub: string; role: string; admin?: boolean }),
    authProvider: typeof payload.auth_provider === "string" ? payload.auth_provider : null,
    spiffeId,
    workloadMode: typeof payload.workload_mode === "string" ? payload.workload_mode : null
  };
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
